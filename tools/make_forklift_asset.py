"""Convert the 3D forklift models (tools/forklift_models.py) into the
annotation tool's overlay assets (app/frontend/public/forklifts/<id>.json, listed
in index.json).

Everything is expressed in roof units, the frame the browser fits a camera in:
a = x / roof half-width (+1 = left roof edge), b = (z - roof centre) / roof
half-length (+1 = front roof edge), t = height / roof height (1 = roof top).

An asset holds the 11 keypoints, the wireframe (feature edges, drawn as the
overlay), the triangles (to tell which keypoints the truck hides from the
camera, and for the model picker's preview, coloured), which vertices belong to
the forks (they stretch with the fork-length fit) and the parts used for the
floor footprint.

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
GROUPS = ("body", "roof", "wheels", "forks", "mast")


def group_of(name):
    for prefix, group in (("overhead_guard", "roof"), ("wheel_", "wheels"), ("fork_", "forks"),
                          ("mast", "mast"), ("carriage", "mast")):
        if name.startswith(prefix):
            return group
    return "body"


def convert(glb, spec):
    model = load_model(glb)
    kp = np.array([k.position for k in model.keypoints])
    roof = kp[:4]
    hw, zc = np.abs(roof[:, 0]).mean(), roof[:, 2].mean()
    hl, h = (roof[:, 2].max() - roof[:, 2].min()) / 2, roof[:, 1].mean()
    to_roof = lambda p: np.column_stack([p[:, 0] / hw, (p[:, 2] - zc) / hl, p[:, 1] / h])

    verts, tris, edges, vgroup, tcolor, palette = [], [], [], [], [], []
    for name, mesh, rgba in model.parts:
        tri = mesh.triangulate().clean()
        base = sum(len(v) for v in verts)
        g = GROUPS.index(group_of(name))
        pts = np.asarray(tri.points)
        verts.append(pts)
        vgroup += [g] * len(pts)
        faces = tri.faces.reshape(-1, 4)[:, 1:]
        tris.append(faces + base)
        color = "#%02x%02x%02x" % tuple(int(round(c * 255)) for c in rgba[:3])
        if color not in palette:
            palette.append(color)
        tcolor += [palette.index(color)] * len(faces)
        fe = tri.extract_feature_edges(feature_angle=35, boundary_edges=True,
                                       non_manifold_edges=False, manifold_edges=False)
        if fe.n_lines:
            # map the feature-edge points back to this part's vertices
            lines = fe.lines.reshape(-1, 3)[:, 1:]
            fpts = np.asarray(fe.points)
            idx = np.argmin(((fpts[:, None] - pts[None]) ** 2).sum(-1), axis=1)
            edges.append(idx[lines] + base)
    V = to_roof(np.concatenate(verts))
    T = np.concatenate(tris)
    E = np.unique(np.sort(np.concatenate(edges), axis=1), axis=0)
    G = np.array(vgroup)

    body = G != GROUPS.index("forks")
    return {
        "id": spec["id"],
        "name": spec["name"],
        "description": spec["description"],
        "names": [k.name for k in model.keypoints],
        "roofDims": [hw, hl, h],                       # metres: half-width, half-length, height
        "keypoints": np.round(to_roof(kp), 5).tolist(),
        "vertices": np.round(V, 4).ravel().tolist(),   # flat a, b, t
        "groups": G.tolist(),                          # per vertex, index into groupNames
        "groupNames": list(GROUPS),
        "triangles": T.ravel().tolist(),
        "triColors": tcolor,                           # per triangle, index into palette (preview)
        "palette": palette,
        "edges": E.ravel().tolist(),
        "forkShankB": round(float((spec["fork_face_z"] - zc) / hl), 5),   # fork blades start here
        "forkWidth": spec["fork_w"],                   # metres, one fork
        "footprint": {                                 # floor rectangle around the truck, forks apart
            "halfWidth": round(float(np.abs(V[:, 0]).max()), 5),
            "back": round(float(V[:, 1].min()), 5),
            "bodyFront": round(float(V[body, 1].max()), 5),
        },
    }


def write(asset, out):
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(asset, separators=(",", ":")))
    print(f"wrote {out.relative_to(REPO)}: {len(asset['vertices']) // 3} vertices, "
          f"{len(asset['triangles']) // 3} triangles, {out.stat().st_size / 1e3:.0f} kB")


def main():
    forklift_models.main()
    index = []
    for spec, _ in forklift_models.MODELS:
        asset = convert(forklift_models.OUT_DIR / f"{spec['id']}.glb", spec)
        write(asset, OUT_DIR / f"{spec['id']}.json")
        index.append({k: spec[k] for k in ("id", "name", "description")})
    (OUT_DIR / "index.json").write_text(json.dumps(index, indent=1))


if __name__ == "__main__":
    main()
