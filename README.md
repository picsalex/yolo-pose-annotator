# yolo-pose-annotator (Studio)

Keypoint annotation for forklifts and people, exported in the Ultralytics YOLO
pose format.

```bash
docker compose up --build
```

Open http://localhost:8080 and sign in as **admin**: on the first start its password is
random and printed in the logs (`docker compose logs app`), unless `ADMIN_PASSWORD` sets
it. Change it on the Admin page.
The sun / moon button switches between the light and dark theme (saved per user).

## Deploying

One container (the image built from `app/`, port 8000; `docker-compose.yml` maps it
to 8080). Everything to keep lives in two folders, each on persistent storage:

| Volume (compose) | Mounted at | Holds | Size |
|---|---|---|---|
| `studio-db` | `/data/db` | the SQLite database: users, annotations, campaigns, tasks, issues | small (MBs) |
| `studio-images` | `/data/images` | the batches, one folder per uploaded zip; also the temporary zip of an upload or an export while it runs | the images, plus room for the biggest zip (x2 while it unpacks) |

`STUDIO_IMAGES=/some/host/folder docker compose up` puts the images in a host
folder (or mounted storage) instead of the `studio-images` volume.

Environment:

| Variable | Value |
|---|---|
| `SECRET_KEY` | signs the sessions. Empty: a random one is generated and kept in `/data/db/secret_key`. When set, a long random string (`python3 -c "import secrets; print(secrets.token_urlsafe(48))"`); changing it signs everyone out |
| `ADMIN_PASSWORD` | the first admin's password, used once on the first start (empty: a random one, printed in the logs) |
| `MAX_UPLOAD_GB` | the biggest zip accepted (default 5) |
| `DATABASE_URL` | `sqlite:////data/db/studio.db` (set in the image) |
| `IMAGES_DIR` | `/data/images` (set in the image) |

Uploads: a zip (up to ~2 GB) is sent in one request, then unpacked before the
response. A reverse proxy in front must let it through: request body limit
above the biggest zip (nginx `client_max_body_size 3g;`) and a read timeout long
enough to unpack it (`proxy_read_timeout 600s;`). `GET /api/health` answers when
the app is up (the image's health check uses it).

Security, when it is reachable from the internet:

- In the app: no default password (see above) nor known session key; passwords of
  8 characters or more, bcrypt-hashed; a new password ends that user's sessions;
  10 failed sign-ins from one address (30 on one username) block it for 15 minutes;
  session cookie `HttpOnly`, `SameSite=Lax`, and `Secure` behind HTTPS; strict
  security headers (CSP, no framing, nosniff); no public API docs; uploads capped
  (`MAX_UPLOAD_GB`) and refused when unpacking would fill the disk; the container
  runs as an unprivileged user (uid 10001).
- To do when deploying: serve it **only over HTTPS**, through a reverse proxy
  (add HSTS there), and do not publish the container's port to the internet
  directly (the app trusts the proxy's `X-Forwarded-*` headers: the client's
  address and https). Sign in once, then change the admin password.

Backups: copy `/data/images`, and the database with a consistent snapshot while
it runs:

```bash
docker compose exec app python -c "import sqlite3; sqlite3.connect('/data/db/studio.db').backup(sqlite3.connect('/data/db/backup.db'))"
```

## Roles

| Role | Can |
|---|---|
| annotator | work on their tasks (annotate, review), open issues on those images and reply |
| manager | everything an admin can, except creating, changing or deleting admins, and deleting batches |
| admin | everything |

Everyone has **My tasks** and **Issues**; managers and admins ("staff") also have
**Campaigns** and **Admin**, see every issue, and can browse any batch (Admin, **Open**).

## Workflow

1. **Batches:** on the Admin page, choose a `.zip` of images (any folders inside;
   a single top folder is dropped) and a batch name: a new one, or an existing
   one to add the images to (files already there are kept). It is unpacked into
   `images/<batch-name>/`. An admin can delete a batch (its images,
   annotations, issues and campaigns): type its name to confirm.
2. **Campaign:** on the Campaigns page, name it, pick a batch (one campaign in
   progress per batch) and the people of each step, annotation and review (the
   same people can be in both). Starting it creates a task per image, shared
   between the annotation step's people in contiguous runs of filenames.
   - An image submitted by its annotator gets a review task, for someone of the
     review step other than its annotator (it waits when nobody else can take it).
   - The reviewer approves it (the image is done), possibly after correcting it,
     or rejects it with a comment: it goes back to its annotator ("to fix", the
     comment shown above the image), then to review again.
   - **People** on a campaign adds or removes people on the way: the tasks nobody
     started yet are shared again between the step's people (a task starts, "in
     progress", once its annotation is changed and saved: opening it is not enough); someone removed gives
     back their unfinished ones (deleting a user does the same).
   - The campaign shows its progress (annotated, approved, sent back) and, per
     person, their tasks to do and done in each step. Deleting it removes its
     tasks; the annotations stay on the images.
3. **My tasks:** every task of the signed-in user, one row per image and step:
   filter by state (to do, in progress, to fix, done), step, batch and filename,
   sort by a column, 50 per page. **Continue** or a row opens the editor, which
   goes through the open tasks, 50 at a time (the next 50 load past the last). **↵** saves the image and submits it (a review:
   approves it; **Reject** asks for the comment; an approved review can be taken
   back with **Cancel approval**), then opens the next; **← / →**
   move between images without submitting; **Save** (⌘S) only saves.
   **Background image** (last toolbar button) is for an image with nothing to
   annotate: after a confirmation it removes what is on it (exported with an
   empty label file), then submits / approves it like ↵.
   The tools float on the right of the image: select / move, forklift, person,
   comment, undo, redo, background image, and the keyboard
   button, which lists every shortcut (also **?**). With the select tool a click
   selects a forklift / person and dragging it moves it whole; a drag on empty
   space selects every box it touches (move, hide or delete them together); hold **Space** to
   pan with the hand. The side panel lists the **layers**, Photoshop-style: a
   group per class (forklifts, people) with an eye, a count and a fold, then a
   compact row per object (eye, class colour, name, visible keypoints; delete on
   hover); a row click selects it (⌘ / Ctrl / Shift: adds or removes). Below,
   the image's issues. Confirmations (background image, reject, deletions) open
   in the app, like the shortcuts: ↵ confirms, Esc cancels.
4. **Issues:** the **Comment** tool (C) pins a question on a spot of the image.
   The **Issues** tab lists them (staff: all of them; annotators: those on the
   images of their tasks), open / resolved / all, **Open the image** jumps to it;
   both sides can reply, staff resolve or reopen. The task list shows each
   image's open issue count.
5. **Export:** **Download** (Admin, per batch) gives a zip (`images/`, `labels/`,
   `data.yaml`, train / val split by the % you set) of the approved images, of the
   annotated or approved ones, or of every image (one not annotated is exported
   as a background image: an empty label file).

## Annotating a forklift

A forklift is 8 keypoints: the 4 roof corners (0 front-left, 1 back-left,
2 back-right, 3 front-right; front = fork side, left = the driver's left) and the
truck's 4 bottom corners below them (4 front-left, 5 back-left, 6 back-right,
7 front-right). A bottom corner is on the truck itself, where its bottom edge turns
the corner: not on a wheel, not on a fork, not on the floor. On a rounded back
(Crown counterweight), it is where the curve meets the side. On a 3-wheel truck,
the back corners are the counterweight's, whatever the wheels.

1. Press **F** and click the 4 roof corners in order (a magnifier shows the
   pixels under the cursor). The 4 bottom corners appear below the roof. The
   ones the truck itself hides start hidden (grey): the Crown C-5 3D model is
   fitted to the roof (assuming a plain 90 deg lens, mounted level) and each
   point is checked against it. That is the only use of a 3D model.
2. **Drag** each keypoint where it is. Every point moves on its own; a dotted line
   joins each bottom corner to the roof corner above it, and the bottom outline
   joins 4-5-6-7.
   **Shift+drag** a bottom corner to move the 4 of them together.
   A box always holds its keypoints: a corner dragged inward stops at them, a point
   dragged out of its box takes the box with it (a person: its visible points).
   Keypoints and boxes never leave the image: dragged past an edge, they stop on it
   (a part of the truck out of the picture: put its point on the edge and hide it with V).
3. **V** on a point flips it visible / hidden. Hidden points (grey) are exported
   as 0 0 0. Flip the ones hidden by something else (a load, a person, another
   truck), or wrongly guessed.
4. **The box** (pink, the YOLO bounding box) surrounds the keypoints and
   follows them (dashed) until you drag one of its corners on the selected
   forklift: from then on it is yours (solid) and stays where you put it, e.g.
   to take in the forks. **B** puts it back around the keypoints. A person's box
   (cyan) is adjusted the same way.
5. Only the forklift in focus (selected, hovered in the side panel, or one of
   its points hovered) shows its box and lines; the others show only their
   keypoints, a little transparent.
6. **Several trucks close together:** hovering or clicking a layer row
   highlights that truck and dims the others; its eye (or **X** on the selected
   ones) hides an annotation from view, a group's eye the whole class, **Shift+X**
   shows them all again. Hidden annotations are still saved and exported.

| Key | Action |
|---|---|
| D / Esc | select / move (leave the current tool): click selects, drag moves the selection whole, drag on empty space selects every box it touches |
| Space (hold) | pan with the hand |
| ? | the shortcuts popup |
| F | new forklift (4 roof clicks) |
| drag | move a keypoint |
| Shift + drag 4-7 | move the 4 bottom corners together |
| V | visible-hidden the hovered point |
| drag a box corner or edge | resize the selected forklift's / person's box (hovering a box highlights it) |
| B | the selected forklift's box back around its keypoints |
| P | new person: drag a box, then drag its 4 keypoints into place |
| C | comment: click the spot, write the issue in the side panel |
| X / Shift+X | hide the selection / show all |
| ⌘A / Ctrl+A | select every shown forklift / person (⌘, Ctrl or Shift + click a side-panel row: add / remove it) |
| Del | delete the selection |
| 0 | fit the image |
| ⌘Z / ⇧⌘Z | undo / redo |
| Ctrl / Cmd + S | save, mark the image done |
| Enter or → | save, next image (done if it holds an annotation) |
| ← | previous image |
| scroll, right-drag | zoom, pan |

## Export format

`data.yaml` has 2 classes, `0: forklift` and `1: person`, both with 8
keypoints (`kpt_shape: [8, 3]`), because YOLO needs one shape for all classes:

| Class | Keypoints |
|---|---|
| forklift | 1-4 roof corners (front-left, back-left, back-right, front-right), 5-8 bottom corners on the truck (same order) |
| person | 1 middle of the head, 2 waist, 3 left foot, 4 right foot, 5-8 0 0 0 |

- A keypoint that is hidden or outside the image is `0 0 0`.
- Each box is exported as drawn (a forklift's: around its keypoints unless adjusted by hand), clipped to the image.
- There is no `flip_idx`: the two classes would need different left/right swaps,
  so YOLO disables horizontal-flip augmentation for this dataset.

## Development (without Docker)

```bash
# API on :8000 with SQLite (images from ./images)
cd app/backend
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/uvicorn api.main:app --reload

# web app on :5173, proxying /api to :8000
cd app/frontend && npm install && npm run dev
npm test                           # forklift keypoints, pre-hiding, export
```

## Forklift models

The editor only uses `crown_c5`, to pre-hide the keypoints the truck hides
(`lib/visibility.ts`: the bottom corners are, among its body vertices in its lowest
40 cm, wheels and forks apart, the ones furthest toward each corner; the same rule
as the forklift simulator, `simulation/simulate.py` in the dhl repo).

| Model | Built from | Roof corners 0-3 | The model file's own rear keypoints 5 / 7 (older layout, not annotated) |
|---|---|---|---|
| `crown_c5` Crown C-5 LPG | Crown C-5 1000-50 spec sheet (cushion tyres): 2355 mm to the fork face, 1090 mm wide, guard 2121 mm, wheelbase 1420 mm; shapes traced from its to-scale side drawing | back: the sharp corner where the rear posts meet the roof; front: the front edge of the flat roof panel, where the guard starts bending down | rear tyres, outer sidewall, on the floor |
| `toyota_3w` Toyota 8FBE 3-wheel | Toyota 8FBE18U spec: 1885 mm to the fork face, 1054 mm wide, guard 2057 mm, wheelbase 1311 mm, twin rear steer wheels; shapes from side and rear photos | the corners of the flat roof (front: where the front posts' curve starts) | the floor below the counterweight's rear outer corners (there are no side rear wheels); 6 = between the bottoms of the two legs around the rear wheel notch |

The models are built in `tools/forklift_models.py` (one function per model, the
shared mesh primitives in `tools/forklift_mesh.py`, GLB files in `tools/forklifts/`);
the one the editor uses is converted to `app/frontend/public/forklifts/crown_c5.json`:

```bash
pip install -r tools/requirements.txt          # numpy, trimesh, pyvista
python -m tools.make_forklift_asset            # from the repo root
```

To add a model: write its spec + build function in `tools/forklift_models.py`
(same node names and keypoint conventions), add it to `MODELS`, run the command
above (`MODEL` in `tools/make_forklift_asset.py` picks the one the editor uses). The simulator (dhl repo) keeps its own copy of the GLB files in
`simulation/forklifts/`: copy new or changed ones there.

## Layout

```
.
├── docker-compose.yml       the app (port 8080) and its two volumes (studio-db, studio-images)
├── images/                  batches when developing without Docker (Docker: the studio-images volume)
├── tools/forklift_models.py       the forklift models (GLB in tools/forklifts/)
├── tools/make_forklift_asset.py   GLB -> the editor's model asset (public/forklifts/)
├── tools/forklift_mesh.py, glb.py mesh primitives / GLB loader for the two above
└── app/
    ├── Dockerfile           builds the web app, then the API image serving it
    ├── backend/api/         FastAPI: auth, users, batches, annotations, issues, export;
    │                        workflow.py: campaigns, task dispatch, submit / review
    └── frontend/src/
        ├── lib/forklift.ts  forklift keypoints, roof anchors, export
        ├── lib/visibility.ts  roof fit of the 3D model, pre-hidden keypoints
        ├── editor/          canvas editor
        └── pages/           login, my tasks, issues, campaigns, admin, annotate
```
