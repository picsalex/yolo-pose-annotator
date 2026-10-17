"""Convert the 3D forklift model the annotation tool uses (crown_c5, from
tools/forklift_models.py) into its asset, app/frontend/public/forklifts/crown_c5.json.

Everything is expressed in roof units, the frame the browser fits a camera in:
a = x / roof half-width (+1 = left roof edge), b = (z - roof centre) / roof
half-length (+1 = front roof edge), t = height / roof height (1 = roof top).

The asset holds the roof corners and the truck's triangles, each vertex with its
part: the browser fits the roof to the 4 clicked corners and tells which
keypoints the truck hides from the camera (lib/visibility.ts).

Usage (from the repo root, with tools/requirements.txt installed):
    python -m tools.make_forklift_asset
"""
import json
from pathlib import Path

import numpy as np

from tools import forklift_models
from tools.glb import load_model

REPO = Path(__file__).resolve().parents[1]
FRONTEND = REPO / "app" / "frontend"
OUT_DIR = FRONTEND / "public" / "forklifts"
MODEL = "crown_c5"
GROUPS = ("body", "roof", "wheels", "forks", "mast")


def group_of(name):
    for prefix, group in (("overhead_guard", "roof"), ("wheel_", "wheels"), ("fork_", "forks"),
                          ("mast", "mast"), ("carriage", "mast")):
        if name.startswith(prefix):
            return group
    return "body"


def convert(glb):
    model = load_model(glb)
    kp = np.array([k.position for k in model.keypoints])
    roof = kp[:4]
    hw, zc = np.abs(roof[:, 0]).mean(), roof[:, 2].mean()
    hl, h = (roof[:, 2].max() - roof[:, 2].min()) / 2, roof[:, 1].mean()
    to_roof = lambda p: np.column_stack([p[:, 0] / hw, (p[:, 2] - zc) / hl, p[:, 1] / h])

    verts, tris, vgroup = [], [], []
    for name, mesh, _ in model.parts:
        tri = mesh.triangulate().clean()
        base = sum(len(v) for v in verts)
        g = GROUPS.index(group_of(name))
        pts = np.asarray(tri.points)
        verts.append(pts)
        vgroup += [g] * len(pts)
        faces = tri.faces.reshape(-1, 4)[:, 1:]
        tris.append(faces + base)
    V = to_roof(np.concatenate(verts))
    T = np.concatenate(tris)
    G = np.array(vgroup)

    return {
        "roofDims": [hw, hl, h],                       # metres: half-width, half-length, height
        "keypoints": np.round(to_roof(roof), 5).tolist(),   # the 4 roof corners
        "vertices": np.round(V, 4).ravel().tolist(),   # flat a, b, t
        "groups": G.tolist(),                          # per vertex, index into groupNames
        "groupNames": list(GROUPS),
        "triangles": T.ravel().tolist(),
    }


def write(asset, out):
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(asset, separators=(",", ":")))
    print(f"wrote {out.relative_to(REPO)}: {len(asset['vertices']) // 3} vertices, "
          f"{len(asset['triangles']) // 3} triangles, {out.stat().st_size / 1e3:.0f} kB")


def main():
    forklift_models.main()
    write(convert(forklift_models.OUT_DIR / f"{MODEL}.glb"), OUT_DIR / f"{MODEL}.json")


if __name__ == "__main__":
    main()
