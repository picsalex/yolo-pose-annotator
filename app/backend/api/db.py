"""Database (SQLite): users, batches (one per image subfolder), images, annotations, issues, and the
annotation campaigns: their people per step and their tasks (one per image and step)."""
import os
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./studio.db")
# concurrent requests share the file: wait for a lock rather than fail
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False, "timeout": 30})


@event.listens_for(engine, "connect")
def _pragmas(conn, _):
    conn.execute("PRAGMA journal_mode=WAL")       # readers do not block the writer
    conn.execute("PRAGMA foreign_keys=ON")


Session = sessionmaker(engine, expire_on_commit=False)


def now():
    """Naive UTC."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(128))
    role: Mapped[str] = mapped_column(String(16), default="annotator")   # admin | manager | annotator
    theme: Mapped[str] = mapped_column(String(8), default="dark")         # dark | light
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Batch(Base):
    """An uploaded zip of images (a subfolder of IMAGES_DIR). Called "dataset" before batches."""
    __tablename__ = "datasets"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)


class Image(Base):
    __tablename__ = "images"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column("dataset_id", ForeignKey("datasets.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(512))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    # where its campaign is: todo -> annotated (annotation submitted) -> approved (review approved)
    status: Mapped[str] = mapped_column(String(16), default="todo")


class Annotation(Base):
    __tablename__ = "annotations"
    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"), primary_key=True)
    data: Mapped[dict] = mapped_column(JSON)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class Issue(Base):
    """A question pinned on a spot of an image, and its replies."""
    __tablename__ = "issues"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"), index=True)
    x: Mapped[float] = mapped_column(Float)                              # image pixels
    y: Mapped[float] = mapped_column(Float)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    messages: Mapped[list] = mapped_column(JSON)                         # [{user, text, at}], the first one opens it
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Campaign(Base):
    """An annotation campaign on a batch: an annotate task per image, then a review task per annotated one."""
    __tablename__ = "campaigns"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("datasets.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Member(Base):
    """Someone working on a campaign step (annotate | review)."""
    __tablename__ = "members"
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    step: Mapped[str] = mapped_column(String(16), primary_key=True)


class Task(Base):
    """One image to annotate or to review, for one person (none: waiting for someone to take it)."""
    __tablename__ = "tasks"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id", ondelete="CASCADE"), index=True)
    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"), index=True)
    step: Mapped[str] = mapped_column(String(16))                                  # annotate | review
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    annotator_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))   # review: who annotated
    status: Mapped[str] = mapped_column(String(16), default="todo")                # todo | done
    result: Mapped[str | None] = mapped_column(String(16))                        # review: approved | rejected
    rounds: Mapped[int] = mapped_column(Integer, default=0)                       # review: times it sent the image back
    comment: Mapped[str | None] = mapped_column(Text)                             # annotate: why the review sent it back
    started_at: Mapped[datetime | None] = mapped_column(DateTime)                 # first worked on by its assignee
    done_at: Mapped[datetime | None] = mapped_column(DateTime)


def init_db():
    """Create the tables (and the database file's folder)."""
    path = engine.url.database
    if path and path != ":memory:":
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    Base.metadata.create_all(engine)
    # columns added after the first release (create_all does not alter existing tables)
    cols = {c["name"] for c in inspect(engine).get_columns("users")}
    task_cols = {c["name"] for c in inspect(engine).get_columns("tasks")}
    with engine.begin() as c:
        if "rounds" not in task_cols:
            # a review used to end at a rejection and a new one came with the fix: one review per image
            # now, reopened by the fix; the rejections before it become its rounds
            c.execute(text("ALTER TABLE tasks ADD COLUMN rounds INTEGER DEFAULT 0"))
            c.execute(text("""UPDATE tasks SET rounds = (SELECT COUNT(*) FROM tasks r WHERE r.step = 'review'
                AND r.result = 'rejected' AND r.campaign_id = tasks.campaign_id AND r.image_id = tasks.image_id
                AND r.id <= tasks.id) WHERE step = 'review'"""))
            c.execute(text("""DELETE FROM tasks WHERE step = 'review' AND EXISTS (SELECT 1 FROM tasks n
                WHERE n.step = 'review' AND n.campaign_id = tasks.campaign_id AND n.image_id = tasks.image_id
                AND n.id > tasks.id)"""))
        if "theme" not in cols:
            c.execute(text("ALTER TABLE users ADD COLUMN theme VARCHAR(8) DEFAULT 'dark'"))
        if "role" not in cols:                                            # is_admin -> role
            c.execute(text("ALTER TABLE users ADD COLUMN role VARCHAR(16) DEFAULT 'annotator'"))
            c.execute(text("UPDATE users SET role = CASE WHEN is_admin THEN 'admin' ELSE 'annotator' END"))
            c.execute(text("ALTER TABLE users DROP COLUMN is_admin"))
        c.execute(text("UPDATE images SET status = 'annotated' WHERE status = 'done'"))   # before campaigns: done
