// Which keypoints of a new forklift the truck itself hides: the 3D model's roof is fitted
// to the 4 clicked roof corners (a plain 90 deg lens, mounted level), then each lower
// keypoint is hidden when a triangle of the truck lies between it and the camera. Only
// this pre-hiding uses the model; the keypoints themselves are placed in 2D.

/** The model, in truck metres (X = driver's left, Y = up, Z = forward). */
export interface Model {
  roof: number[][]              // the 4 roof corners
  points: number[][]            // keypoints 4-7: the bottom corners (FL, BL, BR, FR)
  vertices: Float32Array        // flat x, y, z
  triangles: Uint32Array
}

export const MODEL = 'crown_c5'
const HFOV = 90                 // degrees
const ROLL_PRIOR = 0.02         // radians (~1 deg): the camera's x axis stays horizontal
const EPS = 0.05                // metres: points lie on the surface they sit on
const LOW = 0.4                 // metres: the bottom band of the truck its bottom corners sit on

/** A model asset (public/forklifts/<id>.json, roof units) -> Model. */
export function parseModel(a: any): Model {
  const [hw, hl, h] = a.roofDims
  const metric = ([u, v, t]: number[]) => [u * hw, t * h, v * hl]
  const V: number[] = a.vertices, G: number[] = a.groups, K: number[][] = a.keypoints
  // the bottom corners (as in the dhl repo's simulator, simulation/simulate.py): among the body vertices (wheels and forks
  // apart) in the truck's bottom LOW metres, the one furthest toward each corner (FL, BL, BR, FR)
  const vertices = new Float32Array(V.length)
  for (let i = 0; i < V.length; i += 3) vertices.set(metric([V[i], V[i + 1], V[i + 2]]), i)
  const skip = [a.groupNames.indexOf('wheels'), a.groupNames.indexOf('forks')]
  const body: number[][] = []
  for (let i = 0; i < G.length; i++) if (!skip.includes(G[i])) body.push([vertices[3 * i], vertices[3 * i + 1], vertices[3 * i + 2]])
  const floor = Math.min(...body.map((p) => p[1]))
  const low = body.filter((p) => p[1] <= floor + LOW)
  const hwl = Math.max(...low.map((p) => Math.abs(p[0]))), z0 = Math.min(...low.map((p) => p[2])), z1 = Math.max(...low.map((p) => p[2]))
  const corner = (sx: number, sz: number) => low.reduce((best, p) => {
    const score = (q: number[]) => (sx * q[0]) / hwl + (sz * (q[2] - (z0 + z1) / 2)) / ((z1 - z0) / 2)
    return score(p) > score(best) ? p : best
  })
  return {
    roof: K.slice(0, 4).map(metric),
    points: [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)],
    vertices,
    triangles: Uint32Array.from(a.triangles),
  }
}

export async function loadModel(): Promise<Model> {
  return parseModel(await (await fetch(`/forklifts/${MODEL}.json`)).json())
}

/** Visibility of keypoints 4-7 for a roof clicked in a W x H image (false: hidden by the truck or
 * outside the image). Empty when the roof cannot be fitted. */
export function hiddenPoints(m: Model, roof: [number, number][], W: number, H: number): Record<number, boolean> {
  const cam = { W, H, f: W / 2 / Math.tan((HFOV * Math.PI) / 360) }
  const pose = fitRoof(m, cam, roof)
  if (!pose) return {}
  const n = m.vertices.length / 3, proj = new Float32Array(2 * n), depth = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    const [x, y, z] = project(cam, pose, [m.vertices[3 * k], m.vertices[3 * k + 1], m.vertices[3 * k + 2]])
    proj[2 * k] = x; proj[2 * k + 1] = y; depth[k] = z
  }
  const vis: Record<number, boolean> = {}
  m.points.forEach((X, k) => {
    const [x, y, z] = project(cam, pose, X)
    vis[k + 4] = x >= 0 && x < W && y >= 0 && y < H && !occluded(m.triangles, proj, depth, x, y, z)
  })
  return vis
}

/** Is pixel (x, y) at depth z behind some triangle of the truck? */
function occluded(T: Uint32Array, proj: Float32Array, depth: Float32Array, x: number, y: number, z: number): boolean {
  for (let t = 0; t < T.length; t += 3) {
    const i0 = T[t], i1 = T[t + 1], i2 = T[t + 2]
    const ax = proj[2 * i0], ay = proj[2 * i0 + 1], bx = proj[2 * i1], by = proj[2 * i1 + 1]
    const cx = proj[2 * i2], cy = proj[2 * i2 + 1]
    if ((x < ax && x < bx && x < cx) || (x > ax && x > bx && x > cx)) continue
    if ((y < ay && y < by && y < cy) || (y > ay && y > by && y > cy)) continue
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (!(Math.abs(det) > 1e-9)) continue
    const l0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det
    const l1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det
    const l2 = 1 - l0 - l1
    if (l0 < 0 || l1 < 0 || l2 < 0) continue
    const inv = l0 / depth[i0] + l1 / depth[i1] + l2 / depth[i2]      // perspective-correct depth
    if (inv > 0 && 1 / inv < z - EPS) return true
  }
  return false
}

// ------------------------------------------------------------------ the roof fit
interface Cam { W: number; H: number; f: number }
export interface Pose { R: number[]; t: number[] }                    // truck -> camera, R row-major 3x3

/** Truck metres -> pixel and depth (metres). */
export function project(c: Cam, { R, t }: Pose, X: number[]): [number, number, number] {
  const xc = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0]
  const yc = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1]
  const zc = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2]
  if (zc < 1e-3) return [NaN, NaN, zc]
  return [(c.f * xc) / zc + c.W / 2, (c.f * yc) / zc + c.H / 2, zc]
}

/** Solve A x = b (Gaussian elimination, partial pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    ;[M[p], M[c]] = [M[c], M[p]]
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / (M[c][c] || 1e-14)
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  const x = new Array(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]
    x[r] = s / (M[r][r] || 1e-14)
  }
  return x
}

function rodrigues(w: number[]): number[] {
  const th = Math.hypot(w[0], w[1], w[2])
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const [x, y, z] = w.map((v) => v / th)
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C]
}
const matmul = (A: number[], B: number[]) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) =>
  A[3 * r] * B[c] + A[3 * r + 1] * B[3 + c] + A[3 * r + 2] * B[6 + c]))
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** A first pose from the roof corners alone, a known rectangle seen from afar (weak perspective):
 * the affine map from the roof (X, Z) to the image gives two rows of the rotation up to their
 * middle terms and the scale (= 1 / distance); those follow from the rows being orthonormal,
 * with the truck's up pointing up in the image. */
function initialPose(m: Model, c: Cam, roof: [number, number][]): Pose | null {
  const pts = roof.map(([x, y], i) => ({ u: [(x - c.W / 2) / c.f, (y - c.H / 2) / c.f], P: m.roof[i] }))
  const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0]
  for (const { u, P } of pts) {
    const v = [P[0], P[2], 1]
    for (let i = 0; i < 3; i++) {
      bx[i] += v[i] * u[0]; by[i] += v[i] * u[1]
      for (let j = 0; j < 3; j++) N[i][j] += v[i] * v[j]
    }
  }
  const a = solve(N, bx), b = solve(N, by)
  const aa = a[0] ** 2 + a[1] ** 2, bb = b[0] ** 2 + b[1] ** 2, ab = a[0] * b[0] + a[1] * b[1]
  const s2 = (aa + bb + Math.sqrt((aa - bb) ** 2 + 4 * ab * ab)) / 2
  if (!(s2 > 1e-18)) return null
  const s = Math.sqrt(s2)
  const q = -Math.sqrt(Math.max(s2 - bb, 0)), p = Math.sign(ab || 1) * Math.sqrt(Math.max(s2 - aa, 0))
  const r0 = [a[0] / s, p / s, a[1] / s], r1 = [b[0] / s, q / s, b[1] / s], r2 = cross(r0, r1)
  // the roof's centre lies on the ray through its image, at distance 1 / s
  const Pc = [0, 1, 2].map((j) => pts.reduce((t, e) => t + e.P[j], 0) / 4)
  const uc = [0, 1].map((j) => pts.reduce((t, e) => t + e.u[j], 0) / 4)
  const tz = 1 / s
  return { R: [...r0, ...r1, ...r2], t: [uc[0] * tz - dot(r0, Pc), uc[1] * tz - dot(r1, Pc), tz - dot(r2, Pc)] }
}

/** The pose turned by yaw about the truck's vertical axis through the roof centre. */
function turned(m: Model, pose: Pose, yaw: number): Pose {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  const R = matmul(pose.R, [c, 0, s, 0, 1, 0, -s, 0, c])
  const h = m.roof[0][1]
  return { R, t: [0, 1, 2].map((r) => pose.t[r] + pose.R[3 * r + 1] * h - R[3 * r + 1] * h) }
}

/** The truck's pose from its 4 roof corners. The fit has local minima (a mirrored or half-turned
 * roof matches the corners too), so it starts from the first guess turned 4 ways, keeps the best. */
function fitRoof(m: Model, c: Cam, roof: [number, number][]): Pose | null {
  const init = initialPose(m, c, roof)
  if (!init) return null
  let best: { pose: Pose; cost: number } | null = null
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const r = refine(m, c, roof, turned(m, init, yaw))
    if (!best || r.cost < best.cost) best = r
  }
  return best!.pose
}

/** Levenberg-Marquardt from one start. Parameters: rotation update (3), translation (3). */
function refine(m: Model, c: Cam, roof: [number, number][], pose: Pose) {
  let span = 0                                       // pixel noise: 1% of the roof's size in the image
  for (const a of roof) for (const b of roof) span = Math.max(span, Math.hypot(a[0] - b[0], a[1] - b[1]))
  const sigma = Math.max(1, 0.01 * span)
  const params = () => [0, 0, 0, ...pose.t]
  const unpack = (p: number[]): Pose => ({ R: matmul(rodrigues(p.slice(0, 3)), pose.R), t: p.slice(3, 6) })
  const residuals = (p: number[]) => {
    const ps = unpack(p), r: number[] = []
    roof.forEach(([u, v], i) => {
      const [x, y, z] = project(c, ps, m.roof[i])
      // behind the camera: a penalty that still points the way back in front
      if (Number.isFinite(x)) r.push((x - u) / sigma, (y - v) / sigma)
      else r.push(1e3 + (0.5 - z) * 1e3, 1e3)
    })
    r.push(ps.R[1] / ROLL_PRIOR)                     // the camera's x axis . the floor's up
    return r
  }
  const cost = (r: number[]) => r.reduce((s, v) => s + v * v, 0)
  let lambda = 1e-2, p = params(), r = residuals(p), cst = cost(r)
  for (let it = 0; it < 40; it++) {
    const J: number[][] = []
    for (let k = 0; k < p.length; k++) {
      const h = 1e-6 * Math.max(1, Math.abs(p[k]))
      const rq = residuals(p.map((v, i) => (i === k ? v + h : v)))
      J.push(rq.map((v, i) => (v - r[i]) / h))
    }
    const A = J.map((Ji) => J.map((Jk) => Ji.reduce((s, v, e) => s + v * Jk[e], 0)))
    const g = J.map((Ji) => -Ji.reduce((s, v, e) => s + v * r[e], 0))
    let improved = false
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const step = solve(A.map((row, i) => row.map((v, k) => (i === k ? v * (1 + lambda) + 1e-9 : v))), g)
      const cq = cost(residuals(p.map((v, i) => v + step[i])))
      if (cq < cst) {
        pose = unpack(p.map((v, i) => v + step[i]))   // re-centre the rotation on the new pose
        p = params()
        r = residuals(p)
        if (cst - cq < 1e-9 * Math.max(cq, 1)) it = 40
        cst = cq
        lambda = Math.max(lambda / 3, 1e-7)
        improved = true
      } else lambda *= 4
    }
    if (!improved) break
  }
  return { pose, cost: cst }
}
