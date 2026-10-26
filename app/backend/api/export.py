"""Batch export in the Ultralytics YOLO pose format (3 classes, 8 keypoints each)."""
import zipfile
import zlib
from pathlib import Path

NUM_KPTS = 8                  # YOLO needs one kpt_shape for all classes: the forklift's 8
CLASSES = {"forklift": 0, "person": 1, "driver": 2}

DATA_YAML = """\
# Exported by Studio.
# Every class has 8 keypoints (YOLO needs one kpt_shape for all classes).
#   forklift: 1-4 = roof corners (front-left, back-left, back-right, front-right),
#             5-8 = bottom corners on the truck (same order; wheels and forks apart)
#             front = fork side, left = the driver's left
#   person:   1 = middle of the head, 2 = waist, 3 = left foot, 4 = right foot,
#             5-8 unused (0 0 0)
#   driver:   a person driving a forklift, same keypoints as a person
# Keypoints not visible are 0 0 0.
# No flip_idx: the classes would need different left/right swaps, so YOLO turns
# horizontal-flip augmentation off (fliplr=0) for this dataset.
path: .
train: images/train
val: images/val
kpt_shape: [8, 3]
names:
  0: forklift
  1: person
  2: driver
"""


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


def labels_for(data: dict, W: int, H: int) -> list[str]:
    """The image's label lines (none: a background image). A forklift's box and keypoints are
    those the editor saved with it (derived)."""
    lines = [_line(CLASSES["forklift"], fk["derived"]["bbox"], fk["derived"]["keypoints"], W, H) for fk in data.get("forklifts", [])]
    lines += [_line(CLASSES["driver" if h.get("driver") else "person"], h["box"], h["kpts"], W, H) for h in data.get("humans", [])]
    return [l for l in lines if l]


def write_zip(out: Path, items, images_dir: Path, val_fraction: float):
    """items: (relative image path, width, height, annotation data). Images whose
    path hashes below val_fraction go to val, the rest to train (stable split)."""
    with zipfile.ZipFile(out, "w") as zf:
        zf.writestr("data.yaml", DATA_YAML)
        for rel, W, H, data in items:
            labels = labels_for(data, W, H)
            split = "val" if zlib.crc32(rel.encode()) % 1000 < val_fraction * 1000 else "train"
            name = rel.replace("/", "__")
            zf.write(images_dir / rel, f"images/{split}/{name}", compress_type=zipfile.ZIP_STORED)
            zf.writestr(f"labels/{split}/{Path(name).stem}.txt", "".join(f"{l}\n" for l in labels),   # background image: empty
                        compress_type=zipfile.ZIP_DEFLATED)
