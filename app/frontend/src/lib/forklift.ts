// The forklift annotation, all in 2D: the 4 roof corners clicked, then the truck's 4
// bottom corners dragged into place (on the truck itself, where its bottom edge turns
// the corner; wheels and forks apart). Each bottom corner hangs from the roof corner
// above it, drawn as a dotted link. The box is around the keypoints until adjusted by hand.

type P = [number, number]
export type Box = [number, number, number, number]   // x1, y1, x2, y2 (pixels)

/** What is stored for one forklift. */
export interface ForkliftAnn {
  id: string
  kp: P[]                           // the 8 keypoints in pixels (see NAMES)
  vis: Record<number, boolean>      // keypoint visible (absent: visible)
  box?: Box                         // set once adjusted by hand (absent: around the keypoints)
}

export const NAMES = [            // front = fork side, left = the driver's left
  'roof front-left', 'roof back-left', 'roof back-right', 'roof front-right',
  'bottom front-left', 'bottom back-left', 'bottom back-right', 'bottom front-right',
]
export const KEYPOINTS = NAMES.length
const DROP = 1.5                                     // a new forklift's lower points start this many roof sizes below the roof

/** The 8 keypoints of a new forklift from its 4 roof corners: the bottom corners straight below
 * them, to be dragged into place. */
export function fromRoof(roof: P[]): P[] {
  const size = (Math.hypot(roof[0][0] - roof[2][0], roof[0][1] - roof[2][1]) + Math.hypot(roof[1][0] - roof[3][0], roof[1][1] - roof[3][1])) / 2
  return [...roof.map((p) => [...p] as P), ...roof.map(([x, y]) => [x, y + DROP * size] as P)]
}

/** The forklift's box: as adjusted by hand, else around its keypoints. */
export function boxOf(f: ForkliftAnn): Box {
  if (f.box) return f.box
  const xs = f.kp.map((p) => p[0]), ys = f.kp.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** The forklift's exported box (boxOf, inside the image) and its 8 keypoints [x, y, v]
 * (hidden or outside the image: 0 0 0). */
export function exportForklift(ann: ForkliftAnn, W: number, H: number) {
  const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), hi)
  const [x1, y1, x2, y2] = boxOf(ann)
  const bbox = [clamp(x1, W), clamp(y1, H), clamp(x2, W), clamp(y2, H)]
  const keypoints = ann.kp.map(([x, y], i) => (ann.vis[i] !== false && x >= 0 && x <= W && y >= 0 && y <= H ? [x, y, 2] : [0, 0, 0]))
  return { bbox, keypoints }
}
