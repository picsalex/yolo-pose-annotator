"""Dataset export in the Ultralytics YOLO pose format (2 classes, 8 keypoints each)."""
import zipfile
import zlib
from pathlib import Path

NUM_KPTS = 8                  # YOLO needs one kpt_shape for all classes: the forklift's 8
CLASSES = {"forklift": 0, "person": 1}
KPT_CONF = 0.5                # a COCO keypoint counts as visible above this

DATA_YAML = """\
# Exported by Studio.
# Both classes have 8 keypoints (YOLO needs one kpt_shape for all classes).
#   forklift: 1-4 = roof corners (front-left, back-left, back-right, front-right),
#             5-8 = bottom corners on the truck (same order; wheels and forks apart)
#             front = fork side, left = the driver's left
#   person:   1 = middle of the head, 2 = waist, 3 = left foot, 4 = right foot,
#             5-8 unused (0 0 0)
# Keypoints not visible are 0 0 0.
# No flip_idx: the two classes would need different left/right swaps, so YOLO turns
# horizontal-flip augmentation off (fliplr=0) for this dataset.
path: .
train: images/train
val: images/val
kpt_shape: [8, 3]
names:
  0: forklift
  1: person
"""


# people annotated by early versions of Studio (17 COCO keypoints, from a YOLO pose model)
def coco_to_person(k) -> list[list[float]]:
    """17 COCO keypoints (x, y, conf) -> Studio's 4: middle of the head (mean of the
    visible nose / eyes / ears), waist (between the hips), feet (each ankle pushed a
    little further from its knee, towards the floor). [x, y, v], v = 2 or 0."""
    def seen(*idx):
        return [k[i] for i in idx if k[i][2] >= KPT_CONF]

    def mean(pts):
        return [sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), 2] if pts else [0, 0, 0]

    def foot(ankle, knee):
        a = k[ankle]
        if a[2] < KPT_CONF:
            return [0, 0, 0]
        n = k[knee]
        if n[2] < KPT_CONF:
            return [a[0], a[1], 2]
        return [a[0] + 0.2 * (a[0] - n[0]), a[1] + 0.2 * (a[1] - n[1]), 2]

    out = [mean(seen(0, 1, 2, 3, 4)), mean(seen(11, 12)), foot(15, 13), foot(16, 14)]
    return [[round(float(x), 1), round(float(y), 1), v] for x, y, v in out]


def _line(cls: int, box, kpts, W: int, H: int) -> str | None:
    x1, y1, x2, y2 = (min(max(box[0], 0), W), min(max(box[1], 0), H),
                      min(max(box[2], 0), W), min(max(box[3], 0), H))
    if x2 - x1 < 1 or y2 - y1 < 1:
        return None
    vals = [cls, (x1 + x2) / 2 / W, (y1 + y2) / 2 / H, (x2 - x1) / W, (y2 - y1) / H]
    kpts = list(kpts)[:NUM_KPTS] + [[0, 0, 0]] * (NUM_KPTS - len(kpts))
    for x, y, v in kpts:
        vals += [0, 0, 0] if not v else [x / W, y / H, int(v)]
    return " ".join(f"{v:.6f}" if isinstance(v, float) else str(v) for v in vals)


def labels_for(data: dict, W: int, H: int) -> list[str] | None:
    """The image's label lines; None when a forklift was saved with an older keypoint
    layout (open the image in the editor once: it is converted, to be checked and saved)."""
    lines = []
    for fk in data.get("forklifts", []):
        d = fk.get("derived")
        if not d or len(d["keypoints"]) != NUM_KPTS:
            return None
        lines.append(_line(CLASSES["forklift"], d["bbox"], d["keypoints"], W, H))
    for h in data.get("humans", []):
        kpts = h["kpts"]
        if len(kpts) == 17:                     # annotations made with the 17 COCO keypoints
            kpts = coco_to_person([[x, y, 1.0 if v else 0.0] for x, y, v in kpts])
        lines.append(_line(CLASSES["person"], h["box"], kpts, W, H))
    return [l for l in lines if l]


def write_zip(out: Path, items, images_dir: Path, val_fraction: float):
    """items: (relative image path, width, height, annotation data). Images whose
    path hashes below val_fraction go to val, the rest to train (stable split).
    Images with a forklift in an older keypoint layout are left out (a forklift without
    labels would teach YOLO it is background) and listed in NEEDS_REVIEW.txt."""
    review = []
    with zipfile.ZipFile(out, "w") as zf:
        zf.writestr("data.yaml", DATA_YAML)
        for rel, W, H, data in items:
            labels = labels_for(data, W, H)
            if labels is None:
                review.append(rel)
                continue
            split = "val" if zlib.crc32(rel.encode()) % 1000 < val_fraction * 1000 else "train"
            name = rel.replace("/", "__")
            zf.write(images_dir / rel, f"images/{split}/{name}", compress_type=zipfile.ZIP_STORED)
            zf.writestr(f"labels/{split}/{Path(name).stem}.txt", "".join(f"{l}\n" for l in labels),   # background image: empty
                        compress_type=zipfile.ZIP_DEFLATED)
        if review:
            zf.writestr("NEEDS_REVIEW.txt", "Left out: forklifts saved with an older keypoint layout. Open these\n"
                        "images in Studio, check the bottom corners and save:\n" + "\n".join(review) + "\n")
