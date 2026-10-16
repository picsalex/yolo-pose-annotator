"""Mesh primitives and a GLB writer shared by the forklift generators
(tools/forklift_models.py here; the dhl repo's simulator has its own copy).

Conventions: meters, Y up, +Z forward. A Part is a mesh grouped by material;
write_glb takes the parts (name, Part), the node list and the root node.
"""
import json
import math
import struct

import numpy as np

# ---------------------------------------------------------------- materials
MATERIALS = {
    "yellow": ([0.93, 0.66, 0.10, 1], 0.1, 0.55),
    "charcoal": ([0.16, 0.17, 0.18, 1], 0.2, 0.6),
    "black": ([0.05, 0.05, 0.055, 1], 0.2, 0.6),
    "guard": ([0.50, 0.51, 0.52, 1], 0.4, 0.5),
    "tire": ([0.02, 0.02, 0.02, 1], 0.0, 0.95),
    "rim": ([0.22, 0.22, 0.23, 1], 0.5, 0.5),
    "steel": ([0.55, 0.56, 0.58, 1], 0.8, 0.35),
    "tank": ([0.80, 0.81, 0.82, 1], 0.9, 0.3),
    "seat": ([0.07, 0.07, 0.08, 1], 0.0, 0.9),
    "amber": ([1.0, 0.45, 0.0, 1], 0.0, 0.3),
    "keypoint": ([1.0, 0.0, 0.0, 1], 0.0, 0.4),
}


# ---------------------------------------------------------------- primitives
def box(x0, x1, y0, y1, z0, z1):
    """Axis-aligned box with flat normals."""
    p = np.array([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
                  [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], float)
    faces = [
        ([4, 5, 6, 7], [0, 0, 1]), ([1, 0, 3, 2], [0, 0, -1]),
        ([5, 1, 2, 6], [1, 0, 0]), ([0, 4, 7, 3], [-1, 0, 0]),
        ([7, 6, 2, 3], [0, 1, 0]), ([0, 1, 5, 4], [0, -1, 0]),
    ]
    pos, nrm, idx = [], [], []
    for ids, n in faces:
        b = len(pos)
        pos += [p[i] for i in ids]
        nrm += [n] * 4
        idx += [b, b + 1, b + 2, b, b + 2, b + 3]
    return np.array(pos), np.array(nrm, float), np.array(idx)


def beam(x0, x1, a, b, t):
    """Box spanning x0..x1 whose centreline runs from point a to b in the ZY
    plane (a, b given as (z, y)), with square-ish thickness t. Ends are
    extended by t/2 so consecutive segments join without gaps."""
    a, b = np.array(a, float), np.array(b, float)
    d = b - a
    L = np.linalg.norm(d)
    ang = math.atan2(d[1], d[0])          # angle from +Z towards +Y
    prim = box(x0, x1, -t / 2, t / 2, -t / 2, L + t / 2)
    return transform(prim, rot_x(-math.degrees(ang)), (0, a[1], a[0]))


def cylinder(r, h, axis="x", seg=32, center=(0, 0, 0)):
    """Capped cylinder centred on `center`, extending h/2 each way along axis."""
    a = np.linspace(0, 2 * math.pi, seg, endpoint=False)
    c, s = np.cos(a), np.sin(a)
    pos, nrm, idx = [], [], []
    for k in range(seg):
        for t in (-h / 2, h / 2):
            pos.append([t, r * c[k], r * s[k]])
            nrm.append([0, c[k], s[k]])
    for k in range(seg):
        a0, a1 = 2 * k, 2 * ((k + 1) % seg)
        idx += [a0, a1, a0 + 1, a1, a1 + 1, a0 + 1]
    for t, sign in ((-h / 2, -1), (h / 2, 1)):
        b = len(pos)
        pos.append([t, 0, 0]); nrm.append([sign, 0, 0])
        for k in range(seg):
            pos.append([t, r * c[k], r * s[k]]); nrm.append([sign, 0, 0])
        for k in range(seg):
            i0, i1 = b + 1 + k, b + 1 + (k + 1) % seg
            idx += [b, i1, i0] if sign > 0 else [b, i0, i1]
    pos, nrm = np.array(pos, float), np.array(nrm, float)
    perm = {"x": [0, 1, 2], "y": [2, 0, 1], "z": [1, 2, 0]}[axis]
    pos, nrm = pos[:, perm], nrm[:, perm]
    return pos + np.array(center, float), nrm, np.array(idx)


def ellipsoid(rx, ry, rz, center=(0, 0, 0), seg=24, rings=12):
    pos, nrm, idx = [], [], []
    for i in range(rings + 1):
        v = math.pi * i / rings
        for j in range(seg):
            u = 2 * math.pi * j / seg
            d = np.array([math.sin(v) * math.cos(u), math.cos(v), math.sin(v) * math.sin(u)])
            pos.append(d * [rx, ry, rz])
            n = d / [rx, ry, rz]
            nrm.append(n / (np.linalg.norm(n) or 1))
    for i in range(rings):
        for j in range(seg):
            a, b = i * seg + j, i * seg + (j + 1) % seg
            idx += [a, b, a + seg, b, b + seg, a + seg]
    return np.array(pos) + np.array(center, float), np.array(nrm), np.array(idx)


def torus(R, r, seg=40, tube=12):
    """Torus in the XZ plane (axis = Y)."""
    pos, nrm, idx = [], [], []
    for i in range(seg):
        u = 2 * math.pi * i / seg
        for j in range(tube):
            v = 2 * math.pi * j / tube
            nrm.append([math.cos(v) * math.cos(u), math.sin(v), math.cos(v) * math.sin(u)])
            pos.append([(R + r * math.cos(v)) * math.cos(u), r * math.sin(v),
                        (R + r * math.cos(v)) * math.sin(u)])
    for i in range(seg):
        for j in range(tube):
            a = i * tube + j
            b = ((i + 1) % seg) * tube + j
            c = ((i + 1) % seg) * tube + (j + 1) % tube
            d = i * tube + (j + 1) % tube
            idx += [a, d, b, b, d, c]
    return np.array(pos, float), np.array(nrm, float), np.array(idx)


def _triangulate(poly):
    """Ear-clipping triangulation of a simple CCW polygon (list of 2D points)."""
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def inside(p, a, b, c):
        return cross(a, b, p) >= 0 and cross(b, c, p) >= 0 and cross(c, a, p) >= 0

    ids, tris = list(range(len(poly))), []
    while len(ids) > 3:
        for k in range(len(ids)):
            i0, i1, i2 = ids[k - 1], ids[k], ids[(k + 1) % len(ids)]
            a, b, c = poly[i0], poly[i1], poly[i2]
            if cross(a, b, c) <= 1e-12:
                continue
            if any(inside(poly[j], a, b, c) for j in ids if j not in (i0, i1, i2)):
                continue
            tris.append((i0, i1, i2))
            ids.pop(k)
            break
        else:
            raise ValueError("triangulation failed")
    tris.append(tuple(ids))
    return tris


def extrude(profile, x0, x1):
    """Extrude a side-view profile [(z, y), ...] between x0 and x1."""
    prof = [tuple(p) for p in profile]
    area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(prof, prof[1:] + prof[:1]))
    if area < 0:
        prof = prof[::-1]
    pos, nrm, idx = [], [], []
    for x, sx in ((x0, -1), (x1, 1)):          # caps
        b = len(pos)
        pos += [[x, y, z] for z, y in prof]
        nrm += [[sx, 0, 0]] * len(prof)
        idx += [b + i for t in _triangulate(prof) for i in t]
    n = len(prof)
    for k in range(n):                          # side walls
        (za, ya), (zb, yb) = prof[k], prof[(k + 1) % n]
        dz, dy = zb - za, yb - ya
        L = math.hypot(dz, dy)
        out = [0, -dz / L, dy / L]
        b = len(pos)
        pos += [[x0, ya, za], [x0, yb, zb], [x1, yb, zb], [x1, ya, za]]
        nrm += [out] * 4
        idx += [b, b + 1, b + 2, b, b + 2, b + 3]
    return np.array(pos, float), np.array(nrm, float), np.array(idx)


def arc(cz, cy, r, a0, a1, n=12):
    """Points on a circle in the ZY plane, angles in degrees from +Z."""
    return [(cz + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)))
            for a in np.linspace(a0, a1, n)]


def transform(prim, rot=None, trans=(0, 0, 0)):
    p, n, i = prim
    if rot is not None:
        p, n = p @ rot.T, n @ rot.T
    return p + np.array(trans, float), n, i


def rot_x(deg):
    a = math.radians(deg)
    return np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])


def fix_winding(prim):
    """Make every triangle's winding agree with its vertex normals."""
    p, n, i = prim
    tri = i.reshape(-1, 3).copy()
    fn = np.cross(p[tri[:, 1]] - p[tri[:, 0]], p[tri[:, 2]] - p[tri[:, 0]])
    vn = n[tri].sum(axis=1)
    flip = (fn * vn).sum(axis=1) < 0
    tri[flip] = tri[flip][:, [0, 2, 1]]
    return p, n, tri.reshape(-1)


# ---------------------------------------------------------------- mesh builder
class Part:
    """A mesh made of several primitives grouped by material."""

    def __init__(self):
        self.groups = {}

    def add(self, mat, prim):
        p, n, i = fix_winding(prim)
        g = self.groups.setdefault(mat, [[], [], [], 0])
        g[0].append(p); g[1].append(n); g[2].append(i + g[3]); g[3] += len(p)
        return self




def write_glb(path, meshes_src, nodes, root, generator="make_forklift.py", materials=MATERIALS):
    """Write the scene (one mesh per Part, nodes referencing them by index) as GLB.
    materials: name -> (rgba, metallic, roughness), every name the parts use."""
    mat_index = {k: i for i, k in enumerate(materials)}
    buf = bytearray()
    buffer_views, accessors = [], []

    def add_accessor(arr, comp, typ, target, minmax=False):
        while len(buf) % 4:
            buf.append(0)
        data = arr.tobytes()
        buffer_views.append({"buffer": 0, "byteOffset": len(buf), "byteLength": len(data), "target": target})
        buf.extend(data)
        acc = {"bufferView": len(buffer_views) - 1, "componentType": comp,
               "count": int(arr.shape[0]), "type": typ}
        if minmax:
            acc["min"] = arr.min(axis=0).tolist()
            acc["max"] = arr.max(axis=0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    meshes = []
    for name, part in meshes_src:
        prims = []
        for mat, (ps, ns, iss, _) in part.groups.items():
            p = np.concatenate(ps).astype(np.float32)
            n = np.concatenate(ns).astype(np.float32)
            n /= np.linalg.norm(n, axis=1, keepdims=True)
            i = np.concatenate(iss).astype(np.uint32)
            prims.append({
                "attributes": {"POSITION": add_accessor(p, 5126, "VEC3", 34962, True),
                               "NORMAL": add_accessor(n, 5126, "VEC3", 34962)},
                "indices": add_accessor(i, 5125, "SCALAR", 34963),
                "material": mat_index[mat],
            })
        meshes.append({"name": name, "primitives": prims})

    mats = []
    for name, (color, metal, rough) in materials.items():
        m = {"name": name, "pbrMetallicRoughness": {
            "baseColorFactor": color, "metallicFactor": metal, "roughnessFactor": rough}}
        if name in ("amber", "keypoint"):
            m["emissiveFactor"] = color[:3]
        mats.append(m)

    gltf = {
        "asset": {"version": "2.0", "generator": generator},
        "scene": 0, "scenes": [{"name": "forklift", "nodes": [root]}],
        "nodes": nodes, "meshes": meshes, "materials": mats,
        "accessors": accessors, "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(buf)}],
    }

    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    while len(buf) % 4:
        buf.append(0)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(buf)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack("<II", len(buf), 0x004E4942)); f.write(buf)
    return 12 + 16 + len(js) + len(buf)
