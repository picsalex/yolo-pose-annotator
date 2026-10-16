"""Annotation campaigns. A campaign takes a batch's images through two steps, each done by
its own people (the same people can be in both): every image gets an annotate task; once
submitted it gets a review task, for someone else than its annotator. The review approves
the image (it is done) or rejects it with a comment: its annotate task goes back to its
annotator; once fixed, the same review task opens again (one per image).

Dispatch: a step's open tasks are shared between its people so that each has about as many,
in contiguous runs of filenames. Tasks someone already opened stay theirs; adding or removing
people only moves the others (a removed person's unfinished tasks go back to the pool)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, desc, func, select

from .auth import current_user, staff_user
from .db import Batch, Campaign, Image, Issue, Member, Session, Task, User, now

router = APIRouter()
STEPS = ("annotate", "review")


def people(s, cid: int, step: str) -> list[int]:
    return list(s.scalars(select(Member.user_id).where(Member.campaign_id == cid, Member.step == step).order_by(Member.user_id)))


def dispatch(s, cid: int, step: str):
    """Share the step's open tasks between its people again (see the module docstring)."""
    who = people(s, cid, step)
    tasks = s.scalars(select(Task).join(Image, Task.image_id == Image.id)
                      .where(Task.campaign_id == cid, Task.step == step, Task.status == "todo").order_by(Image.filename)).all()
    load, pool = dict.fromkeys(who, 0), []
    for t in tasks:
        if t.started_at and t.assignee_id in load:
            load[t.assignee_id] += 1
        else:
            t.started_at = None
            pool.append(t)
    n = len(who)
    left = {p: max(0, len(tasks) // n + (k < len(tasks) % n) - load[p]) for k, p in enumerate(who)}
    for t in pool:
        ok = [p for p in who if p != t.annotator_id]
        p = next((p for p in ok if left[p] > 0), None) or (min(ok, key=load.get) if ok else None)
        t.assignee_id = p
        if p is not None:
            load[p] += 1
            left[p] = max(0, left[p] - 1)


def assign_one(s, t: Task):
    """A new task to the step's least busy person (a review: not its annotator)."""
    ok = [p for p in people(s, t.campaign_id, t.step) if p != t.annotator_id]
    load = dict(s.execute(select(Task.assignee_id, func.count()).where(
        Task.campaign_id == t.campaign_id, Task.step == t.step, Task.status == "todo", Task.assignee_id.in_(ok))
        .group_by(Task.assignee_id)).all())
    t.assignee_id = min(ok, key=lambda p: load.get(p, 0)) if ok else None


def dispatch_all(s):
    """After someone left: every campaign's open tasks shared again."""
    for cid in s.scalars(select(Campaign.id)):
        for step in STEPS:
            dispatch(s, cid, step)


def open_campaign(s, batch_id: int) -> Campaign | None:
    """The batch's campaign still in progress (some task not done), if any."""
    return s.scalar(select(Campaign).join(Task, Task.campaign_id == Campaign.id)
                    .where(Campaign.batch_id == batch_id, Task.status == "todo").limit(1))


# ---------------------------------------------------------------- campaigns (staff)
def campaign_json(s, c: Campaign):
    status = dict(s.execute(select(Image.status, func.count()).where(Image.batch_id == c.batch_id).group_by(Image.status)).all())
    total = sum(status.values())
    per: dict[int, dict] = {}
    for uid, step, st, n in s.execute(select(Task.assignee_id, Task.step, Task.status, func.count())
                                      .where(Task.campaign_id == c.id).group_by(Task.assignee_id, Task.step, Task.status)):
        per.setdefault(uid, {s_: {"todo": 0, "done": 0} for s_ in STEPS})[step][st] += n
    names = dict(s.execute(select(User.id, User.username)).all())
    members = {step: people(s, c.id, step) for step in STEPS}
    for uid in members["annotate"] + members["review"]:
        per.setdefault(uid, {s_: {"todo": 0, "done": 0} for s_ in STEPS})
    rejected = s.scalar(select(func.coalesce(func.sum(Task.rounds), 0)).where(Task.campaign_id == c.id))
    return {"id": c.id, "name": c.name, "batch_id": c.batch_id, "batch": s.get(Batch, c.batch_id).name,
            "created_at": c.created_at.isoformat(), "members": members, "total": total,
            "annotated": status.get("annotated", 0) + status.get("approved", 0), "approved": status.get("approved", 0),
            "rejected": rejected, "done": total > 0 and status.get("approved", 0) == total,
            "people": [{"id": uid, "username": names.get(uid, "nobody yet") if uid else "nobody yet", **v} for uid, v in per.items()]}


class Members(BaseModel):
    annotate: list[int]
    review: list[int]


class NewCampaign(Members):
    batch_id: int
    name: str


def _set_members(s, cid: int, body: Members):
    known = set(s.scalars(select(User.id)))
    s.execute(delete(Member).where(Member.campaign_id == cid))
    for step in STEPS:
        for uid in set(getattr(body, step)) & known:
            s.add(Member(campaign_id=cid, user_id=uid, step=step))
    s.flush()


@router.get("/api/campaigns")
def list_campaigns(_: User = Depends(staff_user)):
    with Session() as s:
        return [campaign_json(s, c) for c in s.scalars(select(Campaign).order_by(desc(Campaign.created_at)))]


@router.post("/api/campaigns")
def create_campaign(body: NewCampaign, _: User = Depends(staff_user)):
    """Starts it: an annotate task per image of the batch, dispatched to the annotate step's people."""
    if not body.name.strip() or not body.annotate or not body.review:
        raise HTTPException(400, "a name, and people for both steps")
    with Session() as s:
        if not s.get(Batch, body.batch_id):
            raise HTTPException(404, "no such batch")
        if open_campaign(s, body.batch_id):
            raise HTTPException(409, "this batch already has a campaign in progress")
        c = Campaign(batch_id=body.batch_id, name=body.name.strip())
        s.add(c)
        s.flush()
        _set_members(s, c.id, body)
        for img in s.scalars(select(Image).where(Image.batch_id == body.batch_id)):
            img.status = "todo"
            s.add(Task(campaign_id=c.id, image_id=img.id, step="annotate"))
        s.flush()
        dispatch(s, c.id, "annotate")
        s.commit()
        return campaign_json(s, c)


@router.put("/api/campaigns/{cid}/members")
def set_members(cid: int, body: Members, _: User = Depends(staff_user)):
    """People added or removed: the open tasks are dispatched again."""
    with Session() as s:
        c = s.get(Campaign, cid)
        if not c:
            raise HTTPException(404)
        _set_members(s, cid, body)
        for step in STEPS:
            dispatch(s, cid, step)
        s.commit()
        return campaign_json(s, c)


@router.delete("/api/campaigns/{cid}")
def delete_campaign(cid: int, _: User = Depends(staff_user)):
    """Its tasks go; the annotations stay on the images."""
    with Session() as s:
        c = s.get(Campaign, cid)
        if not c:
            raise HTTPException(404)
        s.execute(delete(Task).where(Task.campaign_id == cid))
        s.execute(delete(Member).where(Member.campaign_id == cid))
        s.delete(c)
        s.commit()
    return {"ok": True}


# ---------------------------------------------------------------- tasks (everyone: their own)
# what the task list shows: todo (never opened), progress (opened), fix (sent back by the review), done
STATES = {
    "todo": (Task.status == "todo") & Task.started_at.is_(None) & Task.comment.is_(None),
    "progress": (Task.status == "todo") & Task.started_at.isnot(None) & Task.comment.is_(None),
    "fix": (Task.status == "todo") & Task.comment.isnot(None),
    "done": Task.status == "done",
}


def state_of(t: Task) -> str:
    return "done" if t.status == "done" else "fix" if t.comment else "progress" if t.started_at else "todo"


def task_json(t: Task, img: Image, batch: Batch, campaign: str, issues: int = 0):
    at = t.done_at or t.started_at
    return {"id": t.id, "step": t.step, "state": state_of(t), "result": t.result, "comment": t.comment,
            "image_id": img.id, "filename": img.filename, "width": img.width, "height": img.height,
            "batch_id": batch.id, "batch": batch.name, "campaign": campaign, "open_issues": issues,
            "updated_at": at.isoformat() if at else None}


def _mine(user: User):
    """My tasks, with their image, batch, campaign name and open issue count."""
    issues = select(Issue.image_id, func.count().label("n")).where(Issue.resolved.is_(False)).group_by(Issue.image_id).subquery()
    return (select(Task, Image, Batch, Campaign.name, func.coalesce(issues.c.n, 0))
            .join(Image, Task.image_id == Image.id).join(Batch, Image.batch_id == Batch.id)
            .join(Campaign, Task.campaign_id == Campaign.id).outerjoin(issues, issues.c.image_id == Image.id)
            .where(Task.assignee_id == user.id))


PAGE = 50                         # tasks per page of the list, and per editor queue
SORTS = {"filename": Image.filename, "batch": Batch.name, "updated": func.coalesce(Task.done_at, Task.started_at), "step": Task.step}


@router.get("/api/tasks")
def list_tasks(step: str = "", state: str = "", batch: int = 0, q: str = "", sort: str = "filename", order: str = "asc",
               page: int = 1, size: int = 50, user: User = Depends(current_user)):
    """My tasks, filtered (step, state, batch, filename search), sorted and paginated; with the count per
    state (same filters but the state) and the batches I have tasks in."""
    with Session() as s:
        base = _mine(user)
        if step in STEPS:
            base = base.where(Task.step == step)
        if batch:
            base = base.where(Image.batch_id == batch)
        if q.strip():
            base = base.where(Image.filename.icontains(q.strip()))
        counts = {k: s.scalar(select(func.count()).select_from(base.where(cond).subquery())) for k, cond in STATES.items()}
        if state in STATES:
            base = base.where(STATES[state])
        total = s.scalar(select(func.count()).select_from(base.subquery()))
        col = SORTS.get(sort, Image.filename)
        rows = s.execute(base.order_by(col.desc() if order == "desc" else col, Image.filename, Task.id)
                         .limit(min(max(size, 1), PAGE)).offset((max(page, 1) - 1) * min(max(size, 1), PAGE))).all()
        batches = s.execute(select(Batch.id, Batch.name).join(Image, Image.batch_id == Batch.id).join(Task, Task.image_id == Image.id)
                            .where(Task.assignee_id == user.id).distinct().order_by(Batch.name)).all()
        return {"items": [task_json(*r) for r in rows], "total": total, "counts": counts,
                "batches": [{"id": i, "name": n} for i, n in batches]}


@router.get("/api/tasks/queue")
def task_queue(task: int = 0, after: int = 0, user: User = Depends(current_user)):
    """What the editor goes through, PAGE tasks at a time: my open tasks (by batch and filename) from task
    `task` (included), or the next ones after task `after`; more: whether others follow."""
    with Session() as s:
        rows = s.execute(_mine(user).where((Task.status == "todo") | Task.id.in_([task, after]))
                         .order_by(Batch.name, Image.filename, Task.step)).all()
        ids = [r[0].id for r in rows]
        start = ids.index(task) if task in ids else ids.index(after) + 1 if after in ids else 0
        return {"items": [task_json(*r) for r in rows[start:start + PAGE]], "more": start + PAGE < len(rows)}


def _task(s, tid: int, user: User, step: str) -> Task:
    t = s.get(Task, tid)
    if not t or t.assignee_id != user.id:
        raise HTTPException(404, "not one of your tasks")
    if t.step != step or t.status != "todo":
        raise HTTPException(409, "this task is not open")
    return t


@router.post("/api/tasks/{tid}/start")
def start(tid: int, user: User = Depends(current_user)):
    """Worked on by its assignee (its annotation changed): it stays theirs when the step's people change."""
    with Session() as s:
        t = s.get(Task, tid)
        if t and t.assignee_id == user.id and t.status == "todo" and not t.started_at:
            t.started_at = now()
            s.commit()
    return {"ok": True}


@router.post("/api/tasks/{tid}/submit")
def submit(tid: int, user: User = Depends(current_user)):
    """An annotation done: the image goes to review."""
    with Session() as s:
        t = _task(s, tid, user, "annotate")
        t.status, t.done_at, t.comment = "done", now(), None
        s.get(Image, t.image_id).status = "annotated"
        # its review: the one that sent it back, open again (with the same reviewer if they still can), or a new one
        r = s.scalar(select(Task).where(Task.campaign_id == t.campaign_id, Task.image_id == t.image_id, Task.step == "review"))
        if r:
            r.status, r.result, r.done_at, r.started_at, r.annotator_id = "todo", None, None, None, user.id
            if r.assignee_id == user.id or r.assignee_id not in people(s, t.campaign_id, "review"):
                assign_one(s, r)
        else:
            r = Task(campaign_id=t.campaign_id, image_id=t.image_id, step="review", annotator_id=user.id)
            s.add(r)
            s.flush()
            assign_one(s, r)
        s.commit()
    return {"ok": True}


@router.post("/api/tasks/{tid}/unapprove")
def unapprove(tid: int, user: User = Depends(current_user)):
    """An approval taken back by its reviewer: the review is open again, the image back to annotated."""
    with Session() as s:
        t = s.get(Task, tid)
        if not t or t.assignee_id != user.id:
            raise HTTPException(404, "not one of your tasks")
        if t.step != "review" or t.result != "approved":
            raise HTTPException(409, "only an approved review can be cancelled")
        t.status, t.result, t.done_at, t.started_at = "todo", None, None, t.started_at or now()
        s.get(Image, t.image_id).status = "annotated"
        s.commit()
    return {"ok": True}


class Review(BaseModel):
    approved: bool
    comment: str = ""


@router.post("/api/tasks/{tid}/review")
def review(tid: int, body: Review, user: User = Depends(current_user)):
    """Approved: the image is done. Rejected: back to its annotator, with the comment."""
    if not body.approved and not body.comment.strip():
        raise HTTPException(400, "say why it is rejected")
    with Session() as s:
        t = _task(s, tid, user, "review")
        t.status, t.done_at, t.result = "done", now(), "approved" if body.approved else "rejected"
        img = s.get(Image, t.image_id)
        img.status = "approved" if body.approved else "todo"
        if not body.approved:
            t.rounds += 1
            a = s.scalar(select(Task).where(Task.campaign_id == t.campaign_id, Task.image_id == t.image_id,
                                            Task.step == "annotate").order_by(desc(Task.id)).limit(1))
            a.status, a.done_at, a.comment = "todo", None, body.comment.strip()
            a.started_at = a.started_at or now()                  # it stays with its annotator
            s.flush()
            if a.assignee_id not in people(s, t.campaign_id, "annotate"):
                dispatch(s, t.campaign_id, "annotate")
        s.commit()
    return {"ok": True}
