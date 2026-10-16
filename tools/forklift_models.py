"""The forklift models Studio can fit, built as GLB files from published spec sheets.

Each model follows the forklift simulator's conventions (dhl repo, simulation/make_forklift.py):
metres, Y up, ground at y = 0, +Z forward (fork side), +X = the driver's left,
the overhead guard roof exactly horizontal. Node names give the part groups
tools/make_forklift_asset.py uses (overhead_guard*, wheel_*, fork_*,
mast*, carriage, the rest = body) and the 11 keypoints are nodes named
kp_<index>_<name>. The origin is on the floor below the front axle.

Keypoints, as the annotators click them:
  0-3   roof corners (top of the flat roof, outer edge)
  4, 8  front tyre, outer sidewall, where it touches the floor
  5, 7  4 wheels: rear tyre, outer sidewall, on the floor.
        3 wheels: the floor below the counterweight's rear outer corner
  6     bottom of the counterweight, rear centre (3 wheels: between the legs' bottoms)
  9, 10 fork tips (top front edge of the blade)

Usage (from the repo root, with tools/requirements.txt installed): python -m tools.forklift_models [out_dir]
"""
import math
import sys
from pathlib import Path

import numpy as np

from tools.forklift_mesh import (MATERIALS, Part, arc, beam, box, cylinder, ellipsoid,
                           extrude, rot_x, torus, transform, write_glb)

OUT_DIR = Path(__file__).resolve().parent / "forklifts"
MATS = {**MATERIALS,
        "grey": ([0.42, 0.43, 0.44, 1], 0.2, 0.6),
        "red": ([0.78, 0.10, 0.08, 1], 0.1, 0.5)}
KP_NAMES = ["top-front-left", "top-back-left", "top-back-right", "top-front-right",
            "bottom-front-left", "bottom-back-left", "bottom-back-middle", "bottom-back-right",
            "bottom-front-right", "bottom-fork-right", "bottom-fork-left"]
POST = 0.07                # overhead guard tube


# ---------------------------------------------------------------- shared parts
def arch(cz, r_tire, y_floor, clearance=0.04, z_cut=None, n=14):
    """Wheel arch in a side profile, from the floor behind the wheel over it to the
    floor in front, or up to z_cut (a body face that stops before the tyre does)."""
    r = r_tire + clearance
    a = math.degrees(math.asin((r_tire - y_floor) / r))
    end = -a if z_cut is None else math.degrees(math.acos((z_cut - cz) / r))
    return arc(cz, r_tire, r, 180 + a, end, n)


def extrude_z(profile, z0, z1):
    """Extrude a rear-view profile [(x, y), ...] between z0 and z1."""
    p, n, i = extrude(profile, z0, z1)           # x <- z, profile x -> z
    swap = np.array([[0, 0, 1], [0, 1, 0], [1, 0, 0]], float)
    return p @ swap.T, n @ swap.T, i


def wheel(r, w):
    part = Part()
    part.add("tire", cylinder(r, w, "x", seg=40))
    part.add("rim", cylinder(r * 0.60, w + 0.002, "x", seg=32))     # rim and hub: (almost) flush with the tyre,
    part.add("black", cylinder(r * 0.22, w + 0.004, "x", seg=16))   # so the overall width is the spec's
    return part


def fork(length, width, thick, z0):
    """One fork in carriage space: y = 0 is the blade's top surface, the shank's
    front face (the fork face) at z0, the blade reaching z0 + length."""
    part = Part()
    part.add("steel", box(-width / 2, width / 2, 0.0, 0.48, z0, z0 + thick))
    part.add("steel", box(-width / 2, width / 2, -thick, 0.0, z0, z0 + length))
    part.add("black", box(-width / 2 - 0.005, width / 2 + 0.005, 0.30, 0.48, z0 - 0.04, z0))
    return part


def mast_parts(rail_x, rail_top, carriage_hw, lbr_top, dz=0.0, head=None):
    """Outer and inner mast (mast space: y from the tilt pivot) and the carriage with
    its load backrest (carriage space, y = 0 at the forks' top surface, moved dz
    forward); head: a plate on the mast top {hw, y0, y1 (mast space), z0 (its back)}."""
    outer, inner, car = Part(), Part(), Part()
    if head:
        outer.add("black", box(-head["hw"], head["hw"], head["y0"], head["y1"], head["z0"], 0.07))
    for x in (-rail_x, rail_x):
        outer.add("black", box(x - 0.045, x + 0.045, -0.25, rail_top, -0.07, 0.07))
        xi = x - math.copysign(0.08, x)                                       # inner rail, inside the outer one
        inner.add("black", box(xi - 0.035, xi + 0.035, -0.20, rail_top - 0.04, -0.02, 0.08))
    for y in (-0.10, rail_top * 0.5, rail_top - 0.10):
        outer.add("black", box(-rail_x, rail_x, y, y + 0.10, -0.06, -0.02))
    outer.add("charcoal", cylinder(0.055, rail_top * 0.75, "y", center=(0, rail_top * 0.3, -0.11)))
    for x in (-rail_x * 0.7, rail_x * 0.7):                                   # tilt cylinders
        outer.add("charcoal", cylinder(0.035, 0.40, "z", center=(x, 0.50, -0.28)))
    for x in (-0.10, 0.10):                                                   # lift chains
        inner.add("charcoal", box(x - 0.015, x + 0.015, -0.10, rail_top - 0.12, 0.085, 0.10))
    car.add("black", box(-carriage_hw, carriage_hw, 0.02, 0.12, 0.10 + dz, 0.15 + dz))
    car.add("black", box(-carriage_hw, carriage_hw, 0.36, 0.46, 0.10 + dz, 0.15 + dz))
    for x in (-0.20, 0.20):
        car.add("black", box(x - 0.05, x + 0.05, 0.02, 0.46, 0.09 + dz, 0.15 + dz))
    for x in np.linspace(-carriage_hw + 0.04, carriage_hw - 0.04, 5):       # load backrest
        car.add("black", box(x - 0.02, x + 0.02, 0.46, lbr_top, 0.11 + dz, 0.14 + dz))
    car.add("black", box(-carriage_hw, carriage_hw, lbr_top - 0.08, lbr_top, 0.10 + dz, 0.15 + dz))
    return outer, inner, car


def roof_grid(part, hw, z0, z1, y, mat="guard", xf=None):
    """Flat roof: outer frame, longitudinal and lateral slats, solid rear plate
    (xf: a transform applied to every piece, e.g. to tilt the roof)."""
    add = (lambda prim: part.add(mat, xf(prim))) if xf else (lambda prim: part.add(mat, prim))
    add(box(-hw, hw, y - POST, y, z0, z0 + POST))
    add(box(-hw, hw, y - POST, y, z1 - POST, z1))
    for x in (-hw, hw):
        add(box(min(x, x - math.copysign(POST, x)), max(x, x - math.copysign(POST, x)), y - POST, y, z0, z1))
    add(box(-hw, hw, y - 0.03, y, z0, z0 + 0.25))
    for x in np.linspace(-hw * 0.6, hw * 0.6, 5):
        add(box(x - 0.018, x + 0.018, y - 0.05, y - 0.005, z0, z1))
    for z in np.linspace(z0 + 0.40, z1 - 0.20, 4):
        add(box(-hw, hw, y - 0.045, y - 0.005, z - 0.018, z + 0.018))


def polyline_post(part, x, pts, mat="guard", w=POST, t=POST):
    """A guard tube w wide (across), t thick, along a side-view polyline [(z, y), ...]."""
    for a, b in zip(pts, pts[1:]):
        part.add(mat, beam(x - w / 2, x + w / 2, a, b, t))


def rrect(z0, z1, hw, r_back, r_front, n=6):
    """Plan outline [(z, x), ...] of the rectangle z0..z1 by -hw..hw, back (z0) and
    front (z1) corners rounded; always 4 n points, so outlines can be lofted."""
    pts = []
    for cz, cx, r, a0 in ((z1 - r_front, hw - r_front, r_front, 0), (z0 + r_back, hw - r_back, r_back, 90),
                          (z0 + r_back, -hw + r_back, r_back, 180), (z1 - r_front, -hw + r_front, r_front, 270)):
        pts += [(cz + r * math.cos(math.radians(a)), cx + r * math.sin(math.radians(a)))
                for a in np.linspace(a0, a0 + 90, n)]
    return pts


def inset(outline, d, front=True):
    """The outline moved inwards by about d (towards its centre line; front=False
    keeps the front edge where it is, for a shell that joins the body in front)."""
    z1 = max(z for z, _ in outline)
    zc = (min(z for z, _ in outline) + z1) / 2
    out = []
    for z, x in outline:
        zn = z if (not front and z > zc) else z - math.copysign(d, z - zc)
        out.append((zn, x - math.copysign(d, x)))
    return out


def loft(sections):
    """A solid through horizontal plan outlines [(y, [(z, x), ...]), ...] (same point
    count each, bottom to top): flat side faces between them, capped at both ends."""
    pos, nrm, idx = [], [], []
    for (ya, A), (yb, B) in zip(sections, sections[1:]):
        cz = np.mean([z for z, _ in A]); cx = np.mean([x for _, x in A])
        for k in range(len(A)):
            k1 = (k + 1) % len(A)
            q = [(A[k][1], ya, A[k][0]), (A[k1][1], ya, A[k1][0]), (B[k1][1], yb, B[k1][0]), (B[k][1], yb, B[k][0])]
            q = np.array(q, float)
            n = np.cross(q[1] - q[0], q[3] - q[0])
            if np.linalg.norm(n) < 1e-12:
                n = np.cross(q[2] - q[1], q[0] - q[1])
            if np.linalg.norm(n) < 1e-12:
                continue
            n /= np.linalg.norm(n)
            out = q.mean(0) - np.array([cx, q[:, 1].mean(), cz])
            if n @ out < 0:
                n = -n
            b = len(pos)
            pos += q.tolist(); nrm += [n.tolist()] * 4
            idx += [b, b + 1, b + 2, b, b + 2, b + 3]
    for (y, P), up in ((sections[0], -1), (sections[-1], 1)):      # caps: fans (the outlines are convex)
        b = len(pos)
        pos.append([np.mean([x for _, x in P]), y, np.mean([z for z, _ in P])]); nrm.append([0, up, 0])
        pos += [[x, y, z] for z, x in P]; nrm += [[0, up, 0]] * len(P)
        idx += [i for k in range(len(P)) for i in (b, b + 1 + k, b + 1 + (k + 1) % len(P))]
    return np.array(pos, float), np.array(nrm, float), np.array(idx)


def steering(part, base, lean, length=0.44):
    rot = rot_x(-lean)
    d = rot @ np.array([0, 1, 0])
    base = np.array(base, float)
    part.add("black", transform(cylinder(0.035, length, "y"), rot, base + d * length / 2))
    c = base + d * length
    part.add("black", transform(torus(0.16, 0.018), rot, c))
    part.add("black", transform(box(-0.16, 0.16, -0.01, 0.01, -0.015, 0.015), rot, c))
    part.add("black", transform(cylinder(0.04, 0.035, "y"), rot, c))


def seat(part, z_front, z_back, y, back_h=0.58):
    part.add("seat", box(-0.24, 0.24, y, y + 0.11, z_back, z_front))
    part.add("seat", transform(box(-0.24, 0.24, 0.0, back_h, -0.06, 0.04), rot_x(-10), (0, y + 0.09, z_back + 0.02)))
    for sx in (-1, 1):
        part.add("seat", box(sx * 0.24 - 0.03, sx * 0.24 + 0.03, y + 0.11, y + 0.29, z_back + 0.02, z_back + 0.25))


class Scene:
    """Meshes and nodes of one GLB, assembled like the simulator's make_forklift.py."""

    def __init__(self):
        self.meshes, self.nodes = [], []
        self.marker = self.mesh("keypoint", Part().add("keypoint", ellipsoid(0.035, 0.035, 0.035, seg=16, rings=8)))

    def mesh(self, name, part):
        self.meshes.append((name, part))
        return len(self.meshes) - 1

    def node(self, name, mesh=None, t=(0, 0, 0), children=(), extras=None):
        n = {"name": name}
        if mesh is not None:
            n["mesh"] = mesh
        if any(t):
            n["translation"] = [float(v) for v in t]
        if children:
            n["children"] = list(children)
        if extras:
            n["extras"] = extras
        self.nodes.append(n)
        return len(self.nodes) - 1

    def kp(self, i, pos):
        return self.node(f"kp_{i:02d}_{KP_NAMES[i]}", self.marker, pos, extras={"keypoint_index": i})


def assemble(spec, static, wheels, kps, out):
    """Common scene graph: static parts, wheels, the mast / carriage / forks chain
    (forks lowered, blades just above the floor) and the keypoints."""
    s = Scene()
    mast_z = spec.get("mast_z", spec["fork_face_z"] - 0.167)
    fork_z0 = spec["fork_face_z"] - mast_z            # fork face in carriage space
    pivot = (0.0, 0.30, mast_z)
    head = spec.get("head_plate")
    if head:
        head = {**head, "y0": head["y0"] - pivot[1], "y1": head["y1"] - pivot[1], "z0": head["z0"] - mast_z}
    outer, inner, car = mast_parts(spec["rail_x"], spec["mast_top"] - pivot[1], spec["carriage_hw"],
                                   spec["lbr_top"] - spec["fork_top"], dz=fork_z0 - 0.167, head=head)
    fpart = s.mesh("fork", fork(spec["fork_len"], spec["fork_w"], spec["fork_t"], fork_z0))
    tip = (0.0, 0.0, fork_z0 + spec["fork_len"])
    fl = s.node("fork_left", fpart, (spec["fork_x"], 0, 0), [s.kp(10, tip)])
    fr = s.node("fork_right", fpart, (-spec["fork_x"], 0, 0), [s.kp(9, tip)])
    carn = s.node("carriage", s.mesh("carriage", car), (0, spec["fork_top"] - pivot[1], 0), [fl, fr])
    innern = s.node("mast_inner", s.mesh("mast_inner", inner), (0, 0, 0), [carn])
    mastn = s.node("mast", s.mesh("mast_outer", outer), pivot, [innern])
    static_n = [s.node(name, s.mesh(name, part)) for name, part in static]
    wheel_n = []
    for name, part, t in wheels:
        wheel_n.append(s.node(name, s.mesh(name, part), t))
    kp_n = [s.kp(i, p) for i, p in sorted(kps.items())]
    root = s.node("forklift", None, (0, 0, 0), static_n + wheel_n + [mastn] + kp_n, extras={
        "model": spec["id"], "keypoint_names": KP_NAMES, "units": "meters", "up": "+Y",
        "forward": "+Z (fork side)", "left": "+X", "ground_y": 0.0, "roof_top_y": spec["roof_y"],
        "fork_face_z": spec["fork_face_z"], "fork_length": spec["fork_len"]})
    out.parent.mkdir(parents=True, exist_ok=True)
    size = write_glb(out, s.meshes, s.nodes, root, generator="tools/forklift_models.py", materials=MATS)
    print(f"wrote {out}: {size} bytes, {len(s.nodes)} nodes")


# ---------------------------------------------------------------- Crown C-5 1000-50
# Crown C-5 1000-50, LPG, cushion tyres (spec sheet "C-5 Series IC Cushion Tire"):
# head length 92.7" (2355 mm), width 42.9" (1090), overhead guard 83.5" (2121),
# mast lowered with load backrest 83" (2108), wheelbase 55.9" (1420), front axle to
# fork face 16.4" (417), tread 35.9" (912), tyres 21x7x15 front / 16x6x10.5 rear,
# forks 42 x 4 x 1.8", fork spread 36".
# Shapes traced from the spec sheet's side drawing (to scale, 2.447 mm per pixel at
# 300 dpi; the (Z, Y) points below are in metres, front axle at Z = 0) and checked
# against the brochure photo. The C-5's look:
#  - the guard is one tube per side: the rear post starts on the fender above the
#    rear wheel, bows backwards past the seat, meets the roof at a sharp rear
#    corner; the roof dips slightly to the front, then bends down in a wide curve
#    into the front post, which leans back ~17 deg and stands on the cowl;
#  - the roof panel ends at a front cross tube where the bend starts (the front
#    roof corners); a light bar sits on the rear cross tube (the rear corners);
#  - black lower body with deep wheel arches, the split to the yellow (cream on
#    stock trucks) upper body rising from the step to the rear;
#  - counterweight: rounded rear corners, a black bumper sticking out below 0.60 m;
#  - LPG tank across the top of the counterweight, sticking out on the left;
#  - mast-top plate projecting backwards, steering column leaning back from the cowl.
CROWN = {
    "id": "crown_c5", "name": "Crown C-5 LPG",
    "description": "4 wheels, one-piece arched guard, rounded counterweight, gas tank on the back",
    "fork_face_z": 0.417, "mast_z": 0.19, "roof_y": 2.112, "mast_top": 2.05, "rail_x": 0.38,
    "carriage_hw": 0.508, "lbr_top": 1.30, "fork_len": 1.067, "fork_w": 0.102, "fork_t": 0.046,
    "fork_x": 0.406, "fork_top": 0.025 + 0.046,
    "head_plate": {"hw": 0.30, "y0": 1.98, "y1": 2.112, "z0": -0.117},
}


def build_crown(out):
    REAR_AXLE, REAR_END, FRONT_FACE = -1.419, -1.936, 0.046
    FR, FW, RR, RW, TRACK = 0.267, 0.178, 0.203, 0.152, 0.456   # tyres 21x7x15 / 16x6x10.5
    HW = 0.52                                         # body sides
    GX, GW = 0.475, 0.07                              # guard tube centre (x), width across
    Y0 = 0.124                                        # underside between the wheels (ground clearance 4.9")
    ROOF_BACK = (-1.297, 2.112)                       # rear roof corner (top outer edge)
    ROOF_FRONT = (-0.533, 2.070)                      # front roof corner: front edge of the flat roof
    CW_FRONT, CW_BACK = -1.50, -1.88                  # counterweight upper block
    SPLIT_BACK, SPLIT_FRONT = (-1.32, 0.65), (-0.29, 0.41)    # black / yellow split, step line

    def split_y(z):                                   # height of the black / yellow split at z
        (za, ya), (zb, yb) = SPLIT_BACK, SPLIT_FRONT
        return ya + (z - za) * (yb - ya) / (zb - za)

    # black lower body: wheel arches, step line, front fenders up to the cowl
    body = Part()
    profile = ([(-1.66, Y0)] + arch(REAR_AXLE, RR, Y0, clearance=0.045)
               + arch(0.0, FR, Y0, clearance=0.05, z_cut=FRONT_FACE)
               + [(FRONT_FACE, 0.71), (-0.10, 0.71), (-0.20, 0.60), SPLIT_FRONT, SPLIT_BACK,
                  (-1.50, split_y(-1.50)), (-1.66, 0.60)])
    body.add("charcoal", extrude(profile, -HW, HW))
    # rear bumper, behind the rear wheels, rounded corners
    bump = rrect(REAR_END, -1.66, HW + 0.01, 0.20, 0.005)
    body.add("charcoal", loft([(0.095, inset(bump, 0.04)), (0.18, bump), (0.60, bump)]))
    body.add("black", box(-0.06, 0.06, 0.40, 0.50, REAR_END - 0.003, REAR_END + 0.02))         # tow pin housing
    # operator floor ramp (inside), step treads along the step line
    body.add("black", transform(box(-0.40, 0.40, -0.02, 0.0, 0.0, 0.83), rot_x(-8.6), (0, 0.585, -0.83)))
    for sx in (-1, 1):
        x0, x1 = sorted((sx * (HW - 0.12), sx * (HW + 0.008)))
        L = math.dist(SPLIT_BACK, SPLIT_FRONT)
        ang = math.degrees(math.atan2(SPLIT_FRONT[1] - SPLIT_BACK[1], SPLIT_FRONT[0] - SPLIT_BACK[0]))
        body.add("grey", transform(box(x0, x1, -0.025, 0.0, 0.0, L * 0.75), rot_x(-ang),
                                   (0, *reversed([SPLIT_BACK[0] + (SPLIT_FRONT[0] - SPLIT_BACK[0]) * 0.2,
                                                  split_y(SPLIT_BACK[0] + (SPLIT_FRONT[0] - SPLIT_BACK[0]) * 0.2)]))))

    # yellow upper body: the seat cover (front face at -0.61) and the counterweight
    shell = Part()
    cover = [(-0.607, split_y(-0.607)), (-0.607, 0.86), (-0.66, 0.93), (-0.72, 0.99),
             (CW_FRONT - 0.02, 1.045), (CW_FRONT - 0.02, split_y(CW_FRONT - 0.02))]
    shell.add("yellow", extrude(cover, -HW + 0.005, HW - 0.005))
    plan = rrect(CW_BACK, CW_FRONT, HW + 0.005, 0.20, 0.005)
    shell.add("yellow", loft([(0.60, plan), (1.06, plan), (1.09, inset(plan, 0.03, front=False)),
                              (1.10, inset(plan, 0.07, front=False))]))
    for y in np.linspace(0.74, 0.92, 5):                                   # rear grille
        shell.add("black", box(-0.24, 0.24, y, y + 0.022, CW_BACK - 0.008, CW_BACK + 0.02))
    for x in (-0.38, 0.38):                                                 # tail lights
        shell.add("amber", box(x - 0.06, x + 0.06, 0.95, 1.01, CW_BACK + 0.015, CW_BACK + 0.04))

    # the guard: one tube per side (rear post, roof rail, front bend and post)
    guard = Part()
    rear_post = [(-1.199, 0.443), (-1.287, 0.675), (-1.370, 0.859), (-1.424, 1.030), (-1.444, 1.250),
                 (-1.439, 1.471), (-1.409, 1.691), (-1.346, 1.911), (-1.290, 2.040), (-1.250, 2.082)]
    rail = [(-1.250, 2.087), (ROOF_FRONT[0], 2.046), (-0.436, 2.004)]
    front_post = [(-0.436, 2.004), (-0.301, 1.862), (-0.203, 1.715), (-0.130, 1.520), (-0.064, 1.299),
                  (-0.015, 1.006), (0.012, 0.724)]
    for sx in (-1, 1):
        polyline_post(guard, sx * GX, rear_post, w=GW, t=0.085)
        polyline_post(guard, sx * GX, rail, w=GW, t=0.05)
        polyline_post(guard, sx * GX, front_post, w=GW, t=0.07)
    roof = Part()                                      # roof panel, built flat then laid on the rails
    L = math.dist(ROOF_BACK, ROOF_FRONT)
    slope = math.degrees(math.atan2(ROOF_BACK[1] - ROOF_FRONT[1], ROOF_FRONT[0] - ROOF_BACK[0]))
    lay = lambda prim: transform(prim, rot_x(slope), (0, ROOF_BACK[1], ROOF_BACK[0]))
    roof_grid(roof, GX + GW / 2, 0.0, L, 0.0, xf=lay)
    for z0 in (0.0, L - 0.06):                                              # rear / front cross tubes
        roof.add("guard", lay(box(-(GX + GW / 2), GX + GW / 2, -0.06, 0.0, z0, z0 + 0.06)))
    lights = Part()
    for sx in (-1, 1):                                                      # light bar on the rear tube
        lights.add("black", box(sx * 0.22 - 0.12, sx * 0.22 + 0.12, ROOF_BACK[1], ROOF_BACK[1] + 0.07,
                                ROOF_BACK[0] - 0.01, ROOF_BACK[0] + 0.07))
        lights.add("amber", box(sx * 0.22 - 0.09, sx * 0.22 + 0.09, ROOF_BACK[1] + 0.012, ROOF_BACK[1] + 0.058,
                                ROOF_BACK[0] - 0.016, ROOF_BACK[0] - 0.01))

    # LPG tank across the counterweight, sticking out on the left, on its bracket
    lpg = Part()
    tank, r = (0.06, 1.31, -1.62), 0.135
    lpg.add("tank", cylinder(r, 0.64, "x", 32, tank))
    for sx in (-1, 1):
        lpg.add("tank", ellipsoid(0.055, r, r, (tank[0] + sx * 0.32, tank[1], tank[2])))
        lpg.add("black", box(tank[0] + sx * 0.18 - 0.02, tank[0] + sx * 0.18 + 0.02, 1.10, tank[1] + r + 0.01,
                             tank[2] - r - 0.01, tank[2] + r + 0.01))
    lpg.add("steel", box(-0.32, 0.40, 1.10, 1.17, tank[2] - 0.13, tank[2] + 0.13))
    lpg.add("tank", cylinder(0.03, 0.07, "x", 12, (tank[0] + 0.40, tank[1] + 0.05, tank[2])))      # valve

    # cab: cowl, steering pedestal and column, levers, seat (high back), armrest
    cab = Part()
    cab.add("charcoal", extrude([(FRONT_FACE - 0.01, 0.60), (FRONT_FACE - 0.01, 0.76), (-0.06, 0.80),
                                 (-0.20, 0.72), (-0.20, 0.60)], -0.42, 0.42))
    cab.add("charcoal", extrude([(-0.20, 0.70), (-0.22, 0.95), (-0.15, 1.01), (-0.04, 1.00), (-0.03, 0.76)],
                                -0.13, 0.13))
    steering(cab, (0, 1.006, -0.142), 27, 0.42)
    for x in (-0.32, -0.27, -0.22):                                         # hydraulic levers (driver's right)
        cab.add("amber", transform(cylinder(0.012, 0.22, "y"), rot_x(-20), (x, 1.02, -0.10)))
    seat(cab, -0.62, -1.06, 0.99, back_h=0.46)
    cab.add("seat", box(-0.36, -0.26, 1.20, 1.25, -1.00, -0.72))           # armrest

    wheels = [("wheel_front_left", wheel(FR, FW), (TRACK, FR, 0.0)),
              ("wheel_front_right", wheel(FR, FW), (-TRACK, FR, 0.0)),
              ("wheel_rear_left", wheel(RR, RW), (TRACK, RR, REAR_AXLE)),
              ("wheel_rear_right", wheel(RR, RW), (-TRACK, RR, REAR_AXLE))]
    gx = GX + GW / 2
    kps = {0: (gx, ROOF_FRONT[1], ROOF_FRONT[0]), 1: (gx, ROOF_BACK[1], ROOF_BACK[0]),
           2: (-gx, ROOF_BACK[1], ROOF_BACK[0]), 3: (-gx, ROOF_FRONT[1], ROOF_FRONT[0]),
           4: (TRACK + FW / 2, 0.0, 0.0), 5: (TRACK + RW / 2, 0.0, REAR_AXLE), 6: (0.0, 0.12, REAR_END),
           7: (-(TRACK + RW / 2), 0.0, REAR_AXLE), 8: (-(TRACK + FW / 2), 0.0, 0.0)}
    static = [("body", body), ("counterweight", shell), ("overhead_guard", guard), ("overhead_guard_roof", roof),
              ("overhead_guard_lights", lights), ("lpg_tank", lpg), ("cab", cab)]
    assemble(CROWN, static, wheels, kps, out)


# ---------------------------------------------------------------- Toyota 8FBE18U
# Toyota 8FBE18U, 3-wheel electric (Toyota 3-wheel electric spec): length to fork
# face 74.2" (1885 mm), width 41.5" (1054), overhead guard 81" (2057), mast lowered
# 77.6" (1971), wheelbase 51.6" (1311), front axle to fork face 13.8" (351), tread
# 34.5" front / 6.9" rear (twin steer wheels), tyres 18x7x12.125 front / 15x5x11.25
# rear, forks 42 x 4 x 1.4". Shape from side and rear photos: a tall block
# counterweight at the back, the twin rear wheels in a notch between its two legs,
# a grille slot across its back, the battery open to the sides
# under its seat cover, a grey frame band all along the bottom, a low step, an
# instrument console in front of the operator, and the guard: straight vertical
# rear posts on the counterweight, a long flat roof, front posts rising from the
# front fenders and bending into the roof in a wide curve.
TOYOTA = {
    "id": "toyota_3w", "name": "Toyota 8FBE 3-wheel",
    "description": "Electric, tall rear counterweight, open battery bay, curved front posts",
    "fork_face_z": 0.351, "roof_y": 2.057, "mast_top": 1.971, "rail_x": 0.34, "carriage_hw": 0.50,
    "lbr_top": 1.34, "fork_len": 1.067, "fork_w": 0.102, "fork_t": 0.036, "fork_x": 0.38,
    "fork_top": 0.025 + 0.036,
}


def build_toyota(out):
    REAR_AXLE, REAR_END, FRONT_FACE = -1.311, -1.534, 0.10
    FR, FW, RR, RW, TRACK, RTRACK = 0.229, 0.178, 0.190, 0.127, 0.438, 0.0875
    HW, ROOF_Y, ROOF_HW = 0.50, TOYOTA["roof_y"], 0.49
    ROOF_Z0, ROOF_Z1 = -1.47, -0.51                  # flat roof, back / front edge
    Y0, BAND, CW_FRONT, CW_TOP = 0.084, 0.34, -1.09, 1.00
    BAT_FRONT, DECK = -0.46, 0.48                     # battery bay front, step / fender height

    frame = Part()                                    # grey band along the bottom, fenders, step
    profile = ([(CW_FRONT, Y0)] + arch(0.0, FR, Y0, clearance=0.03, z_cut=FRONT_FACE)
               + [(FRONT_FACE, DECK), (BAT_FRONT, DECK), (BAT_FRONT, BAND), (CW_FRONT, BAND)])
    frame.add("grey", extrude(profile, -HW, HW))
    frame.add("yellow", box(-HW, HW, DECK - 0.02, DECK + 0.02, BAT_FRONT, -0.16))     # step plate
    frame.add("black", box(-0.40, 0.40, DECK + 0.02, DECK + 0.025, BAT_FRONT + 0.02, -0.18))

    cw = Part()                                       # counterweight: two legs around the wheel notch, block above
    NW, NT, LEGS = 0.19, 0.42, 0.50                   # notch half-width and top, top of the legs
    corner = lambda cx, a0, a1: [(x, y) for y, x in arc(NT - 0.08, cx, 0.08, a0, a1, 5)]   # arc() gives (y, x) here
    notch = ([(-HW, Y0), (-NW, Y0)] + corner(-NW + 0.08, -90, 0) + corner(NW - 0.08, 0, 90)
             + [(NW, Y0), (HW, Y0), (HW, LEGS), (-HW, LEGS)])
    cw.add("yellow", extrude_z(notch, REAR_END, CW_FRONT))
    plan = rrect(REAR_END, CW_FRONT, HW, 0.10, 0.005)
    cw.add("yellow", loft([(LEGS, plan), (CW_TOP, plan), (CW_TOP + 0.04, inset(plan, 0.03, front=False))]))
    for y in (0.58, 0.64):                                                   # grille slots across the back
        cw.add("black", box(-0.25, 0.25, y, y + 0.035, REAR_END - 0.003, REAR_END + 0.02))
    for sx in (-1, 1):                                                       # side vents
        for y in np.linspace(0.54, 0.66, 4):
            cw.add("black", box(min(sx * HW, sx * (HW + 0.006)), max(sx * HW, sx * (HW + 0.006)),
                                y, y + 0.018, -1.33, -1.14))
    for x in (-0.36, 0.36):                                                  # tail lights
        cw.add("amber", box(x - 0.05, x + 0.05, 0.86, 0.92, REAR_END - 0.003, REAR_END + 0.02))

    bay = Part()                                      # battery, open to the sides, under its cover
    bay.add("black", box(-0.44, 0.44, BAND, 0.74, CW_FRONT + 0.02, BAT_FRONT))
    bay.add("charcoal", box(-0.40, 0.40, 0.74, 0.745, CW_FRONT + 0.06, BAT_FRONT - 0.04))
    hood = Part()
    hood.add("yellow", extrude([(CW_FRONT, 0.74), (CW_FRONT, 0.99), (-0.42, 0.97), (-0.35, 0.94),
                                (-0.33, 0.86), (-0.33, 0.74)], -HW, HW))

    console = Part()                                  # instrument console + steering
    console.add("grey", extrude([(-0.24, DECK), (-0.20, 1.04), (-0.12, 1.10), (0.0, 1.10), (0.05, 0.96),
                                 (0.06, DECK)], -0.22, 0.22))
    steering(console, (0, 1.06, -0.12), 48, 0.30)
    for x in (-0.30, -0.25, -0.20):                                         # hydraulic levers
        console.add("black", transform(cylinder(0.012, 0.22, "y"), rot_x(-25), (x, 1.10, -0.10)))
    seat(console, -0.50, -0.95, 0.98, back_h=0.48)

    guard = Part()                                    # front posts: fender -> wide bend -> roof
    rguard = Part()                                   # rear posts: straight, on the counterweight
    ry, pw = ROOF_Y - POST / 2, 0.065
    front = [(0.05, DECK)] + arc(ROOF_Z1, ry - 0.38, 0.38, 10, 90, 10)
    for x in (-(ROOF_HW - pw / 2), ROOF_HW - pw / 2):
        polyline_post(guard, x, front, w=pw, t=pw)
        rguard.add("red", box(x - 0.04, x + 0.04, CW_TOP, ROOF_Y - POST, -1.39, -1.31))
    roof_grid(guard, ROOF_HW, ROOF_Z0, ROOF_Z1, ROOF_Y)
    guard.add("guard", box(-ROOF_HW, ROOF_HW, ROOF_Y - 0.12, ROOF_Y - POST, -1.39, -1.31))   # rear cross beam

    wheels = [("wheel_front_left", wheel(FR, FW), (TRACK, FR, 0.0)),
              ("wheel_front_right", wheel(FR, FW), (-TRACK, FR, 0.0)),
              ("wheel_rear_left", wheel(RR, RW), (RTRACK, RR, REAR_AXLE)),
              ("wheel_rear_right", wheel(RR, RW), (-RTRACK, RR, REAR_AXLE))]
    kps = {0: (ROOF_HW, ROOF_Y, ROOF_Z1), 1: (ROOF_HW, ROOF_Y, ROOF_Z0),
           2: (-ROOF_HW, ROOF_Y, ROOF_Z0), 3: (-ROOF_HW, ROOF_Y, ROOF_Z1),
           4: (TRACK + FW / 2, 0.0, 0.0), 5: (HW, 0.0, REAR_END), 6: (0.0, Y0, REAR_END),
           7: (-HW, 0.0, REAR_END), 8: (-(TRACK + FW / 2), 0.0, 0.0)}
    static = [("body", frame), ("counterweight", cw), ("battery", bay), ("hood", hood), ("cab", console),
              ("overhead_guard", guard), ("overhead_guard_rear", rguard)]
    assemble(TOYOTA, static, wheels, kps, out)


MODELS = [(CROWN, build_crown), (TOYOTA, build_toyota)]


def main(out_dir=OUT_DIR):
    for spec, build in MODELS:
        build(Path(out_dir) / f"{spec['id']}.glb")


if __name__ == "__main__":
    main(*sys.argv[1:])
