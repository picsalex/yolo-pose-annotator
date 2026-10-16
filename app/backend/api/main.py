"""Studio API: sign-in, users and roles, batches (zips unpacked into subfolders of
IMAGES_DIR), annotations, issues and the YOLO export; the
campaigns and their tasks are in workflow.py. Also serves the web app.

Roles: annotators work on the images of their tasks; managers and admins (staff) run
everything, except that only admins manage admin accounts and delete batches."""
import os
import shutil
import tempfile
import zipfile
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image as PILImage
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from starlette.background import BackgroundTask

from .auth import (COOKIE, LIFETIME, admin_user, check_password, current_user, hash_password, is_staff, make_token,
                   seed_admin, staff_user)
from .db import Annotation, Batch, Image, Issue, Session, Task, User, init_db, now
from .export import write_zip
from .workflow import dispatch_all, open_campaign, router

IMAGES_DIR = Path(os.environ.get("IMAGES_DIR", "../../images")).resolve()
STATIC_DIR = Path(os.environ.get("STATIC_DIR", "../frontend/dist")).resolve()
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

app = FastAPI(title="Studio")
app.include_router(router)


@app.on_event("startup")
def startup():
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    for left in IMAGES_DIR.glob(".tmp-*"):          # uploads / exports cut short by a restart
        left.unlink(missing_ok=True)
    init_db()
    seed_admin()
    scan()


def _tmp() -> Path:
    """A temporary zip on the images volume (uploads and exports are as big as batches: not in the
    container's own disk). Hidden: the batches scan skips it."""
    return Path(tempfile.mkstemp(prefix=".tmp-", suffix=".zip", dir=IMAGES_DIR)[1])


@app.get("/api/health")
def health():
    return {"ok": True}


# ---------------------------------------------------------------- auth
class Login(BaseModel):
    username: str
    password: str


def user_json(u: User):
    return {"id": u.id, "username": u.username, "role": u.role, "theme": u.theme or "dark"}


@app.post("/api/login")
def login(body: Login, response: Response):
    with Session() as s:
        u = s.scalar(select(User).where(User.username == body.username))
    if not u or not check_password(body.password, u.password_hash):
        raise HTTPException(401, "wrong username or password")
    response.set_cookie(COOKIE, make_token(u), httponly=True, samesite="lax",
                        max_age=int(LIFETIME.total_seconds()))
    return user_json(u)


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/me")
def me(user: User = Depends(current_user)):
    return user_json(user)


class Prefs(BaseModel):
    theme: str


@app.patch("/api/me")
def update_me(body: Prefs, user: User = Depends(current_user)):
    if body.theme not in ("dark", "light"):
        raise HTTPException(400, "theme must be dark or light")
    with Session() as s:
        u = s.get(User, user.id)
        u.theme = body.theme
        s.commit()
        return user_json(u)


# ---------------------------------------------------------------- users (staff)
ROLES = ("annotator", "manager", "admin")


def _may_manage(actor: User, role: str):
    """Managers manage annotators and managers; admins, everyone."""
    if role not in ROLES:
        raise HTTPException(400, f"role must be one of {', '.join(ROLES)}")
    if role == "admin" and actor.role != "admin":
        raise HTTPException(403, "only an admin can manage admins")


class NewUser(BaseModel):
    username: str
    password: str
    role: str = "annotator"


@app.get("/api/users")
def list_users(_: User = Depends(staff_user)):
    with Session() as s:
        users = s.scalars(select(User).order_by(User.username)).all()
        tasks: dict = {}
        for uid, st, n in s.execute(select(Task.assignee_id, Task.status, func.count()).group_by(Task.assignee_id, Task.status)):
            tasks.setdefault(uid, {"todo": 0, "done": 0})[st] = n
    return [{**user_json(u), "tasks": tasks.get(u.id, {"todo": 0, "done": 0})} for u in users]


@app.post("/api/users")
def create_user(body: NewUser, actor: User = Depends(staff_user)):
    _may_manage(actor, body.role)
    if not body.username.strip() or not body.password:
        raise HTTPException(400, "username and password required")
    with Session() as s:
        if s.scalar(select(User).where(User.username == body.username)):
            raise HTTPException(409, "username taken")
        u = User(username=body.username.strip(), password_hash=hash_password(body.password), role=body.role)
        s.add(u)
        s.commit()
        return user_json(u)


@app.delete("/api/users/{uid}")
def delete_user(uid: int, actor: User = Depends(staff_user)):
    if uid == actor.id:
        raise HTTPException(400, "you cannot delete yourself")
    with Session() as s:
        u = s.get(User, uid)
        if not u:
            raise HTTPException(404)
        _may_manage(actor, u.role)
        s.delete(u)                     # their steps go with them, their tasks lose their assignee
        s.flush()
        dispatch_all(s)                 # ... and are handed to the others
        s.commit()
    return {"ok": True}


class Password(BaseModel):
    password: str


@app.post("/api/users/{uid}/password")
def set_password(uid: int, body: Password, actor: User = Depends(staff_user)):
    with Session() as s:
        u = s.get(User, uid)
        if not u:
            raise HTTPException(404)
        _may_manage(actor, u.role)
        u.password_hash = hash_password(body.password)
        s.commit()
    return {"ok": True}


class Role(BaseModel):
    role: str


@app.patch("/api/users/{uid}")
def set_role(uid: int, body: Role, actor: User = Depends(staff_user)):
    if uid == actor.id:
        raise HTTPException(400, "you cannot change your own role")
    with Session() as s:
        u = s.get(User, uid)
        if not u:
            raise HTTPException(404)
        _may_manage(actor, u.role)
        _may_manage(actor, body.role)
        u.role = body.role
        s.commit()
        return user_json(u)


# ---------------------------------------------------------------- batches
def scan(only: str | None = None):
    """Register every image under IMAGES_DIR/<batch>/ (recursively; only: that batch).
    Returns the new image count."""
    added = 0
    if not IMAGES_DIR.is_dir():
        return 0
    with Session() as s:
        for folder in sorted(p for p in IMAGES_DIR.iterdir() if p.is_dir() and not p.name.startswith(".")
                             and only in (None, p.name)):
            b = s.scalar(select(Batch).where(Batch.name == folder.name))
            if not b:
                b = Batch(name=folder.name)
                s.add(b)
                s.flush()
            known = set(s.scalars(select(Image.filename).where(Image.batch_id == b.id)))
            for f in sorted(folder.rglob("*")):
                rel = f.relative_to(folder).as_posix()
                if f.suffix.lower() not in IMAGE_EXT or rel in known or f.name.startswith("."):
                    continue
                try:
                    with PILImage.open(f) as im:
                        w, h = im.size
                except Exception:
                    continue
                s.add(Image(batch_id=b.id, filename=rel, width=w, height=h))
                added += 1
        s.commit()
    return added


def _unpack(zip_path: Path, folder: Path) -> int:
    """The zip's images into folder (a single top folder in the zip is dropped; files already
    there are kept). Returns how many were written."""
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        raise HTTPException(400, "not a zip file")
    with zf:
        names = [Path(n) for n in zf.namelist() if not n.endswith("/") and Path(n).suffix.lower() in IMAGE_EXT
                 and not any(p.startswith(".") or p == "__MACOSX" for p in Path(n).parts)]
        strip = len({n.parts[0] for n in names}) == 1 and all(len(n.parts) > 1 for n in names)
        written = 0
        for n in names:
            rel = Path(*n.parts[strip:])
            dest = folder / rel
            if rel.is_absolute() or ".." in rel.parts or dest.exists():
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(n.as_posix()) as src, dest.open("wb") as out:
                shutil.copyfileobj(src, out)
            written += 1
    return written


@app.put("/api/batches/upload")
async def upload(request: Request, name: str, _: User = Depends(staff_user)):
    """A zip of images (the request body) into batch `name`, new or existing."""
    name = name.strip()
    if not name or name.startswith(".") or any(c in name for c in '/\\:'):
        raise HTTPException(400, "invalid batch name")
    tmp = _tmp()
    try:
        with tmp.open("wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
        if not await run_in_threadpool(_unpack, tmp, IMAGES_DIR / name):
            raise HTTPException(400, "no new images in the zip")
    finally:
        tmp.unlink(missing_ok=True)
    return {"added": await run_in_threadpool(scan, name)}


@app.delete("/api/batches/{bid}")
def delete_batch(bid: int, _: User = Depends(admin_user)):
    """The batch, its campaigns, its images' annotations and issues, and its image files."""
    with Session() as s:
        b = s.get(Batch, bid)
        if not b:
            raise HTTPException(404)
        ids = select(Image.id).where(Image.batch_id == bid)
        for table in (Task, Issue, Annotation):
            s.execute(delete(table).where(table.image_id.in_(ids)))
        s.execute(delete(Image).where(Image.batch_id == bid))
        s.delete(b)                     # its campaigns and their steps go with it
        s.commit()
    shutil.rmtree(IMAGES_DIR / b.name, ignore_errors=True)
    return {"ok": True}


@app.get("/api/batches")
def list_batches(_: User = Depends(staff_user)):
    """Every batch: its image count per status, its campaign in progress."""
    with Session() as s:
        out = []
        for b in s.scalars(select(Batch).order_by(Batch.name)):
            status = dict(s.execute(select(Image.status, func.count()).where(Image.batch_id == b.id).group_by(Image.status)).all())
            c = open_campaign(s, b.id)
            out.append({"id": b.id, "name": b.name, "total": sum(status.values()),
                        "annotated": status.get("annotated", 0) + status.get("approved", 0), "approved": status.get("approved", 0),
                        "campaign": c and {"id": c.id, "name": c.name}})
    return out


@app.get("/api/batches/{bid}/images")
def batch_images(bid: int, _: User = Depends(staff_user)):
    """A batch's images, to browse and correct them outside the tasks."""
    with Session() as s:
        b = s.get(Batch, bid)
        return {"batch": b.name if b else "", "images": [
            {"id": i.id, "filename": i.filename, "width": i.width, "height": i.height, "status": i.status}
            for i in s.scalars(select(Image).where(Image.batch_id == bid).order_by(Image.filename))]}


# ---------------------------------------------------------------- images + annotations
def _image(s, iid: int, user: User) -> Image:
    """The image, for staff or someone with a task on it."""
    img = s.get(Image, iid)
    if not img:
        raise HTTPException(404)
    if not is_staff(user) and not s.scalar(select(Task.id).where(Task.image_id == iid, Task.assignee_id == user.id).limit(1)):
        raise HTTPException(403, "not one of your tasks")
    return img


def _path(s, img: Image) -> Path:
    return IMAGES_DIR / s.get(Batch, img.batch_id).name / img.filename


@app.get("/api/images/{iid}/file")
def image_file(iid: int, user: User = Depends(current_user)):
    with Session() as s:
        path = _path(s, _image(s, iid, user))
    return FileResponse(path, headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/images/{iid}/annotation")
def get_annotation(iid: int, user: User = Depends(current_user)):
    with Session() as s:
        img = _image(s, iid, user)
        ann = s.get(Annotation, iid)
        return {"status": img.status, "data": ann.data if ann else None}


class Save(BaseModel):
    data: dict


@app.put("/api/images/{iid}/annotation")
def save_annotation(iid: int, body: Save, user: User = Depends(current_user)):
    """The annotation only: the tasks move the image's status (workflow.py)."""
    with Session() as s:
        _image(s, iid, user)
        ann = s.get(Annotation, iid)
        if ann:
            ann.data, ann.updated_by = body.data, user.id
        else:
            s.add(Annotation(image_id=iid, data=body.data, updated_by=user.id))
        s.commit()
    return {"ok": True}


EXPORT = {"all": ("todo", "annotated", "approved"), "annotated": ("annotated", "approved"), "approved": ("approved",)}


@app.get("/api/batches/{bid}/export")
def export(bid: int, val: float = 0.1, include: str = "approved", _: User = Depends(staff_user)):
    """include: approved (reviewed), annotated (submitted or approved) or all (an image without an
    annotation is a background image: an empty label file)."""
    with Session() as s:
        b = s.get(Batch, bid)
        if not b:
            raise HTTPException(404)
        q = select(Image, Annotation).outerjoin(Annotation, Annotation.image_id == Image.id) \
            .where(Image.batch_id == bid, Image.status.in_(EXPORT.get(include, EXPORT["approved"])))
        items = [(img.filename, img.width, img.height, ann.data if ann else {}) for img, ann in s.execute(q)]
    tmp = _tmp()
    write_zip(tmp, items, IMAGES_DIR / b.name, min(max(val, 0.0), 1.0))
    return FileResponse(tmp, filename=f"{b.name}-{include}-yolo.zip", media_type="application/zip",
                        background=BackgroundTask(tmp.unlink))


# ---------------------------------------------------------------- issues
def issue_json(s, i: Issue, user: User):
    """task_id: the user's task on its image (an open one first), to open it from the issue list."""
    img = s.get(Image, i.image_id)
    task = s.scalar(select(Task.id).where(Task.image_id == i.image_id, Task.assignee_id == user.id)
                    .order_by(Task.status.desc(), Task.id.desc()).limit(1))
    return {"id": i.id, "image_id": i.image_id, "batch_id": img.batch_id, "batch": s.get(Batch, img.batch_id).name,
            "filename": img.filename, "x": i.x, "y": i.y, "resolved": i.resolved, "messages": i.messages,
            "updated_at": i.updated_at.isoformat(), "task_id": task}


def _issue(s, id: int, user: User) -> Issue:
    i = s.get(Issue, id)
    if not i:
        raise HTTPException(404)
    _image(s, i.image_id, user)                       # the image's assignee or staff
    return i


@app.get("/api/issues")
def list_issues(user: User = Depends(current_user)):
    """Staff: every issue; the others: those on the images of their tasks."""
    with Session() as s:
        q = select(Issue).order_by(Issue.updated_at.desc())
        if not is_staff(user):
            q = q.where(Issue.image_id.in_(select(Task.image_id).where(Task.assignee_id == user.id)))
        return [issue_json(s, i, user) for i in s.scalars(q)]


@app.get("/api/images/{iid}/issues")
def image_issues(iid: int, user: User = Depends(current_user)):
    with Session() as s:
        _image(s, iid, user)
        return [issue_json(s, i, user) for i in s.scalars(select(Issue).where(Issue.image_id == iid).order_by(Issue.id))]


class Message(BaseModel):
    text: str


class NewIssue(Message):
    x: float
    y: float


def _message(user: User, text: str):
    if not text.strip():
        raise HTTPException(400, "empty message")
    return {"user": user.username, "text": text.strip(), "at": now().isoformat()}


@app.post("/api/images/{iid}/issues")
def create_issue(iid: int, body: NewIssue, user: User = Depends(current_user)):
    with Session() as s:
        _image(s, iid, user)
        i = Issue(image_id=iid, x=body.x, y=body.y, messages=[_message(user, body.text)])
        s.add(i)
        s.commit()
        return issue_json(s, i, user)


@app.post("/api/issues/{id}/messages")
def reply(id: int, body: Message, user: User = Depends(current_user)):
    with Session() as s:
        i = _issue(s, id, user)
        i.messages = [*i.messages, _message(user, body.text)]
        i.updated_at = now()
        s.commit()
        return issue_json(s, i, user)


class Resolve(BaseModel):
    resolved: bool


@app.post("/api/issues/{id}/resolve")
def resolve(id: int, body: Resolve, user: User = Depends(staff_user)):
    with Session() as s:
        i = _issue(s, id, user)
        i.resolved, i.updated_at = body.resolved, now()
        s.commit()
        return issue_json(s, i, user)


# ---------------------------------------------------------------- web app
class WebApp(StaticFiles):
    """The built app: index.html is re-checked on every load (so a new build is picked
    up at once); the hashed files under assets/ never change and are cached for good."""

    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        r.headers["Cache-Control"] = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
        return r


if STATIC_DIR.is_dir():
    app.mount("/", WebApp(directory=STATIC_DIR, html=True), name="app")
