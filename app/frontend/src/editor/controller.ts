// Canvas editor: draws the image, the forklifts, the people and the issue pins, and handles
// every mouse / keyboard interaction. Kept outside React so dragging a point redraws
// without re-rendering components.
import { type Box, type ForkliftAnn, NAMES, boxOf, exportForklift, fromRoof } from '@/lib/forklift'
import { type Model, hiddenPoints } from '@/lib/visibility'

export interface Human { id: string; box: Box; kpts: [number, number, number][] }
export interface Ann { forklifts: ForkliftAnn[]; humans: Human[] }
type Hit =
  | { kind: 'fk'; id: string; i: number }          // a forklift keypoint
  | { kind: 'hu'; id: string; i: number }          // a person keypoint
  | { kind: 'box'; id: string; sx: number; sy: number }   // a corner / edge of the selected one's box: the box sides it moves (-1: none)

export const ROOF_PROMPTS = [
  'top-front-left (roof corner on the fork side, driver\'s left)',
  'top-back-left',
  'top-back-right',
  'top-front-right',
]
const PERSON_KEYPOINTS = ['middle of the head', 'waist', 'left foot', 'right foot']
const PERSON_LABELS = ['H', 'W', 'L', 'R']        // drawn next to each point (left / right: the person's own)
const PERSON_EDGES = [[0, 1], [1, 2], [1, 3]]

// a standing person facing the camera, in box units (the person's left is on the image right):
// a person drawn by hand starts with its keypoints here, hidden until dragged into place
const PERSON_TEMPLATE = [[0.5, 0.07], [0.5, 0.53], [0.62, 0.98], [0.38, 0.98]]
/** Each class's colour: its boxes, a person's keypoints, the layers panel. */
export const COLORS = { forklift: '#FF64DA', person: '#00FFFF' }
const LINES = '#e5e7eb'                            // a forklift's roof outline, a person's skeleton
const HIT_RADIUS = 9
// the box handles: the box sides each one moves (x: 0 left / 2 right, y: 1 top / 3 bottom, -1: none)
const CORNERS = [[0, 1], [2, 1], [2, 3], [0, 3]], EDGES = [[-1, 1], [2, -1], [-1, 3], [0, -1]]
/** The resize cursor of a handle. */
const resizeCursor = (sx: number, sy: number) =>
  sx < 0 ? 'ns-resize' : sy < 0 ? 'ew-resize' : (sx === 0) === (sy === 1) ? 'nwse-resize' : 'nesw-resize'
const PIN_RADIUS = 9
/** An issue pinned on the image (id -1: the one being written). */
interface Pin { id: number; x: number; y: number; label: string; resolved: boolean }
const LOUPE = { size: 160, zoom: 4, margin: 12 }   // magnifier while a point is placed or dragged (screen px)
const uid = () => Math.random().toString(36).slice(2, 10)

export interface EditorState {
  mode: 'idle' | 'roof' | 'human' | 'comment'
  roofStep: number
  canUndo: boolean
  canRedo: boolean
  selected: string[]                                // ids of the selected forklifts / people
  forklifts: { id: string; visible: number; hidden: boolean }[]
  humans: { id: string; visible: number; hidden: boolean }[]
  hover: string
}

export class Editor {
  private ctx: CanvasRenderingContext2D
  private img: HTMLImageElement | null = null
  W = 0
  H = 0
  ann: Ann = { forklifts: [], humans: [] }
  private loaded = ''                                // the annotation as loaded (JSON), to tell an edit
  model: Model | null = null                        // pre-hides a new forklift's keypoints (none: all visible)
  private scale = 1
  private ox = 0
  private oy = 0
  private dpr = window.devicePixelRatio || 1
  mode: EditorState['mode'] = 'idle'
  private pendingRoof: [number, number][] = []
  selected: string[] = []                           // a click selects one, a drag on empty space an area
  private marquee: Box | null = null                 // that area while it is dragged (x1, y1: where it began)
  private hover: Hit | null = null
  private hoverBox: string | null = null        // the forklift / person under the cursor (its box is highlighted)
  private drag: Hit | null = null
  private shift: { from: [number, number]; kp: [number, number][] } | null = null   // Shift+drag: all lower points together
  private pan: { x: number; y: number } | null = null
  private space = false                                  // Space held: the hand (pan) instead of the current tool
  // a selected forklift / person dragged by its body, moved as a whole (from: where the drag began)
  private moving: { from: [number, number]; orig: (ForkliftAnn | Human)[]; moved: boolean } | null = null
  private newBox: Box | null = null                  // a person's box while it is drawn (x1, y1: where it began)
  private cursor: [number, number] = [0, 0]
  private undoStack: string[] = []
  private redoStack: string[] = []
  private hidden = new Set<string>()          // instances not drawn (view only, not saved)
  private highlight: string | null = null     // instance hovered in the side panel
  private raf = 0
  private pins: Pin[] = []
  private activePin: number | null = null
  onChange: (s: EditorState) => void = () => {}
  onPin: (id: number) => void = () => {}                  // an issue pin clicked
  onComment: (x: number, y: number) => void = () => {}    // the comment tool clicked a spot

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!
  }

  // ------------------------------------------------------------ loading / saving
  load(img: HTMLImageElement, ann: Ann | null) {
    this.img = img
    this.W = img.naturalWidth
    this.H = img.naturalHeight
    this.ann = { forklifts: ann?.forklifts ?? [], humans: ann?.humans ?? [] }
    this.undoStack = []
    this.redoStack = []
    this.selected = []
    this.hidden.clear()
    this.highlight = null
    this.mode = 'idle'
    this.pendingRoof = []
    for (const { id } of [...this.ann.forklifts, ...this.ann.humans]) this.contain(id)   // as changed() leaves it
    this.loaded = JSON.stringify(this.ann)
    this.fitView()
  }

  /** Has the annotation changed since it was loaded (back to how it was: no)? */
  edited() { return JSON.stringify(this.ann) !== this.loaded }

  /** What is saved: the annotation plus, per forklift, its exported box and 8 keypoints. */
  serialize() {
    return {
      humans: this.ann.humans,
      forklifts: this.ann.forklifts.map((f) => ({ ...f, derived: exportForklift(f, this.W, this.H) })),
    }
  }

  /** Background image: nothing on it. */
  clearAll() {
    this.snapshot()
    this.ann = { forklifts: [], humans: [] }
    this.selected = []
    this.changed()
  }

  setPins(pins: Pin[], active: number | null) { this.pins = pins; this.activePin = active; this.requestDraw() }

  private forklift(id: string | undefined) { return this.ann.forklifts.find((f) => f.id === id) }
  private human(id: string | undefined) { return this.ann.humans.find((h) => h.id === id) }
  /** The selected one when there is exactly one (its box shows its handles). */
  private get one() { return this.selected.length === 1 ? this.selected[0] : null }
  /** The box of a forklift or person, as drawn and exported. */
  private boxOf(id: string): Box | undefined {
    const f = this.forklift(id)
    return f ? boxOf(f) : this.human(id)?.box
  }

  // ------------------------------------------------------------ view
  private toImage(sx: number, sy: number): [number, number] {
    return [(sx - this.ox) / this.scale, (sy - this.oy) / this.scale]
  }
  // nothing goes outside the image: every point and box edge is kept inside it
  private inImage = ([x, y]: number[]): [number, number] => [Math.min(Math.max(x, 0), this.W), Math.min(Math.max(y, 0), this.H)]
  /** A move (dx, dy) cut short so that all the points stay inside the image. */
  private within(pts: number[][], dx: number, dy: number): [number, number] {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
    return [Math.min(Math.max(dx, -Math.min(...xs)), this.W - Math.max(...xs)), Math.min(Math.max(dy, -Math.min(...ys)), this.H - Math.max(...ys))]
  }
  private toScreen(x: number, y: number): [number, number] {
    return [this.ox + x * this.scale, this.oy + y * this.scale]
  }

  fitView() {
    const r = this.canvas.getBoundingClientRect()
    if (!this.W || !r.width) return
    this.scale = Math.min(r.width / this.W, r.height / this.H) * 0.98
    this.ox = (r.width - this.W * this.scale) / 2
    this.oy = (r.height - this.H * this.scale) / 2
    this.changed()
  }

  resize() {
    const r = this.canvas.getBoundingClientRect()
    this.canvas.width = Math.round(r.width * this.dpr)
    this.canvas.height = Math.round(r.height * this.dpr)
    this.requestDraw()
  }

  // ------------------------------------------------------------ undo
  private snapshot() {
    this.undoStack.push(JSON.stringify(this.ann))
    if (this.undoStack.length > 200) this.undoStack.shift()
    this.redoStack = []
  }
  private restore(json: string) {
    this.ann = JSON.parse(json)
    this.selected = this.selected.filter((id) => this.boxOf(id))
    this.changed()
  }
  undo() { const s = this.undoStack.pop(); if (s) { this.redoStack.push(JSON.stringify(this.ann)); this.restore(s) } }
  redo() { const s = this.redoStack.pop(); if (s) { this.undoStack.push(JSON.stringify(this.ann)); this.restore(s) } }

  // ------------------------------------------------------------ hit testing
  private hitTest(sx: number, sy: number): Hit | null {
    let best: Hit | null = null
    let bestD = HIT_RADIUS
    const consider = (x: number, y: number, h: Hit, bonus: number) => {
      const [px, py] = this.toScreen(x, y)
      const d = Math.hypot(px - sx, py - sy) - bonus
      if (d < bestD) { bestD = d; best = h }
    }
    const sel = this.one
    for (const f of this.ann.forklifts) {
      if (this.hidden.has(f.id)) continue
      f.kp.forEach(([x, y], i) => consider(x, y, { kind: 'fk', id: f.id, i }, sel === f.id ? 3 : 0))
    }
    for (const h of this.ann.humans) {
      if (this.hidden.has(h.id)) continue
      h.kpts.forEach(([x, y, v], i) => { if (v || sel === h.id) consider(x, y, { kind: 'hu', id: h.id, i }, sel === h.id ? 3 : 0) })
    }
    if (sel && !this.hidden.has(sel)) {                        // the selected one's box handles (its points first)
      const b = this.boxOf(sel)!
      for (const [hx, hy] of CORNERS) consider(b[hx], b[hy], { kind: 'box', id: sel, sx: hx, sy: hy }, 2)
      // an edge: anywhere along it (the nearest point of the edge)
      const [x1, y1] = this.toImage(sx, sy), clamp = (v: number, a: number, c: number) => Math.min(Math.max(v, Math.min(a, c)), Math.max(a, c))
      for (const [hx, hy] of EDGES) {
        const x = hx < 0 ? clamp(x1, b[0], b[2]) : b[hx], y = hy < 0 ? clamp(y1, b[1], b[3]) : b[hy]
        consider(x, y, { kind: 'box', id: sel, sx: hx, sy: hy }, 0)
      }
    }
    return best
  }

  /** The forklift / person whose box is under (x, y), people first (drawn on top). */
  private instanceAt(x: number, y: number): string | null {
    return this.inArea([x, y, x, y]).reverse()[0] ?? null
  }

  /** The shown forklifts / people whose box touches the area (x1, y1, x2, y2 in any order). */
  private inArea([ax, ay, bx, by]: Box): string[] {
    return [...this.ann.forklifts, ...this.ann.humans].map((a) => a.id).filter((id) => {
      const [x1, y1, x2, y2] = this.boxOf(id)!
      return !this.hidden.has(id) && x1 <= Math.max(ax, bx) && x2 >= Math.min(ax, bx) && y1 <= Math.max(ay, by) && y2 >= Math.min(ay, by)
    })
  }

  // ------------------------------------------------------------ mouse
  /** Space pressed / released: the hand while it is held. */
  setSpace(held: boolean) { this.space = held; this.updateCursor() }

  /** The mouse cursor: a hand while Space is held (closed while panning), a crosshair for the drawing tools,
   * a move cursor over what the select tool can drag. */
  private updateCursor() {
    const h = this.drag ?? this.hover
    this.canvas.style.cursor = this.pan ? 'grabbing' : this.space ? 'grab' : this.mode !== 'idle' ? 'crosshair'
      : h?.kind === 'box' ? resizeCursor(h.sx, h.sy) : h ? 'pointer' : this.moving || this.hoverBox ? 'move' : 'default'
  }

  pointerDown(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect()
    const sx = e.clientX - r.left, sy = e.clientY - r.top
    const [x, y] = this.inImage(this.toImage(sx, sy))
    if (e.button === 1 || e.button === 2 || this.space) { this.pan = { x: sx, y: sy }; this.updateCursor(); return }
    if (this.mode === 'roof') {
      this.pendingRoof.push([x, y])
      if (this.pendingRoof.length === 4) {
        this.snapshot()
        const vis = this.model ? hiddenPoints(this.model, this.pendingRoof, this.W, this.H) : {}
        const f: ForkliftAnn = { id: uid(), kp: fromRoof(this.pendingRoof).map(this.inImage), vis }
        this.ann.forklifts.push(f)
        this.selected = [f.id]
        this.mode = 'idle'
        this.pendingRoof = []
      }
      this.changed()
      return
    }
    if (this.mode === 'human') { this.newBox = [x, y, x, y]; return }
    if (this.mode === 'comment') { this.mode = 'idle'; this.changed(); this.onComment(x, y); return }
    const hit = this.hitTest(sx, sy)
    const pin = hit ? undefined : this.pins.find((p) => { const [px, py] = this.toScreen(p.x, p.y); return Math.hypot(px - sx, py - sy) < PIN_RADIUS })
    if (pin) { this.onPin(pin.id); return }
    if (hit) {
      this.snapshot()
      this.drag = hit
      const f = hit.kind === 'fk' && hit.i >= 4 && e.shiftKey ? this.forklift(hit.id) : undefined
      this.shift = f ? { from: [x, y], kp: f.kp.map((p) => [...p] as [number, number]) } : null
      if (hit.kind === 'box') { const f = this.forklift(hit.id); if (f) f.box = [...boxOf(f)] }   // the box is set by hand from now on
      this.selected = [hit.id]
      this.changed()
      return
    }
    // select tool: a click selects what is under the cursor (or keeps the selection it belongs to) and
    // dragging moves the selection whole; on empty space, dragging selects the area
    const id = this.instanceAt(x, y)
    if (id) {
      if (!this.selected.includes(id)) this.selected = [id]
      this.moving = { from: [x, y], orig: this.selected.map((s) => structuredClone(this.forklift(s) ?? this.human(s)!)), moved: false }
    } else {
      this.selected = []
      this.marquee = [x, y, x, y]
    }
    this.changed()
  }

  pointerMove(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect()
    const sx = e.clientX - r.left, sy = e.clientY - r.top
    const [x, y] = this.inImage(this.toImage(sx, sy))
    this.cursor = [x, y]
    if (this.pan) {
      this.ox += sx - this.pan.x
      this.oy += sy - this.pan.y
      this.pan = { x: sx, y: sy }
      this.requestDraw()
      return
    }
    const area = this.newBox ?? this.marquee
    if (area) { area[2] = x; area[3] = y; this.requestDraw(); return }
    const m = this.moving
    if (m) {
      if (!m.moved) { this.snapshot(); m.moved = true }          // a plain click is no undo step
      const pts = m.orig.flatMap((o) => { const b = 'kp' in o ? boxOf(o) : o.box; return [...('kp' in o ? o.kp : o.kpts), [b[0], b[1]], [b[2], b[3]]] })
      const [dx, dy] = this.within(pts, x - m.from[0], y - m.from[1])
      const box = (b: Box): Box => [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy]
      for (const o of m.orig) {
        const f = this.forklift(o.id), h = this.human(o.id)
        if (f && 'kp' in o) {
          f.kp = o.kp.map(([px, py]) => [px + dx, py + dy])
          if (o.box) f.box = box(o.box)
        } else if (h && 'kpts' in o) {
          h.box = box(o.box)
          h.kpts = o.kpts.map(([px, py, v]) => [px + dx, py + dy, v])
        }
      }
      this.requestDraw()
      return
    }
    const d = this.drag
    if (d?.kind === 'fk') {
      const f = this.forklift(d.id)!, sh = this.shift
      if (sh) {
        const [dx, dy] = this.within(sh.kp.slice(4), x - sh.from[0], y - sh.from[1])
        f.kp = sh.kp.map(([px, py], k) => (k < 4 ? [px, py] : [px + dx, py + dy]))
      }
      else { f.kp[d.i] = [x, y]; delete f.vis[d.i] }             // a hidden point dragged into place: visible
    } else if (d?.kind === 'hu') this.human(d.id)!.kpts[d.i] = [x, y, 2]
    else if (d) {
      const b = this.boxOf(d.id)!
      if (d.sx >= 0) b[d.sx] = x
      if (d.sy >= 0) b[d.sy] = y
    }
    if (d) { this.contain(d.id); this.requestDraw(); return }
    const idle = this.mode === 'idle' && !this.space
    const hover = idle ? this.hitTest(sx, sy) : null, hoverBox = hover?.id ?? (idle ? this.instanceAt(x, y) : null) ?? null
    if (JSON.stringify(hover) !== JSON.stringify(this.hover) || hoverBox !== this.hoverBox) { this.hover = hover; this.hoverBox = hoverBox; this.changed() }
    if (this.mode !== 'idle') this.requestDraw()
  }

  /** The cursor left the canvas: nothing is hovered any more. */
  pointerLeave() {
    if (this.drag || this.moving || this.pan || this.marquee || (!this.hover && !this.hoverBox)) return
    this.hover = null
    this.hoverBox = null
    this.changed()
  }

  pointerUp() {
    const d = this.drag
    if (d) {
      this.drag = null
      this.shift = null
      if (d.kind === 'box') {                                 // a side dragged past the other one
        const b = this.boxOf(d.id)!
        b.splice(0, 4, Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3]))
      }
      this.changed()
    }
    if (this.newBox) {
      const [x, y, x2, y2] = this.newBox
      this.newBox = null
      if (Math.abs(x2 - x) > 4 && Math.abs(y2 - y) > 4) {
        this.snapshot()
        const box: Box = [Math.min(x, x2), Math.min(y, y2), Math.max(x, x2), Math.max(y, y2)]
        const h: Human = { id: uid(), box, kpts: PERSON_TEMPLATE.map(([u, v]) =>
          [box[0] + u * (box[2] - box[0]), box[1] + v * (box[3] - box[1]), 0] as [number, number, number]) }
        this.ann.humans.push(h)
        this.selected = [h.id]
      }
      this.mode = 'idle'
      this.changed()
    }
    if (this.marquee) {
      const [x1, y1, x2, y2] = this.marquee
      if (Math.abs(x2 - x1) * this.scale > 3 || Math.abs(y2 - y1) * this.scale > 3) this.selected = this.inArea(this.marquee)
      this.marquee = null
      this.changed()
    }
    if (this.moving?.moved) this.changed()
    this.moving = null
    this.pan = null
    this.updateCursor()
  }

  /** Scroll or trackpad pinch (a wheel event with ctrlKey): the image zooms, not the page. */
  wheel(e: WheelEvent) {
    e.preventDefault()
    const r = this.canvas.getBoundingClientRect()
    this.zoom(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top)
  }

  /** Zoom by k around the screen point (sx, sy): the cursor, or the canvas's centre. */
  zoom(k: number, sx = this.canvas.clientWidth / 2, sy = this.canvas.clientHeight / 2) {
    const s = Math.min(Math.max(this.scale * k, 0.02), 40)
    this.ox = sx - ((sx - this.ox) * s) / this.scale
    this.oy = sy - ((sy - this.oy) * s) / this.scale
    this.scale = s
    this.requestDraw()
  }

  // ------------------------------------------------------------ keyboard actions
  startForklift() { this.mode = 'roof'; this.pendingRoof = []; this.selected = []; this.changed() }
  startHuman() { this.mode = 'human'; this.selected = []; this.changed() }
  startComment() { this.mode = 'comment'; this.pendingRoof = []; this.changed() }
  /** D: back to select / move. */
  startDrag() { this.mode = 'idle'; this.pendingRoof = []; this.newBox = null; this.changed() }
  cancel() {
    if (this.mode !== 'idle') this.startDrag()
    else { this.selected = []; this.changed() }
  }

  /** Del: the selected forklifts / people go. */
  deleteSelection() {
    const gone = new Set(this.selected)
    if (!gone.size) return
    this.snapshot()
    this.ann.forklifts = this.ann.forklifts.filter((f) => !gone.has(f.id))
    this.ann.humans = this.ann.humans.filter((h) => !gone.has(h.id))
    if (this.highlight && gone.has(this.highlight)) this.highlight = null    // its side panel row is gone (no mouse-leave)
    this.selected = []
    this.changed()
  }

  /** V: flip the hovered keypoint between visible and hidden. */
  toggleVisibility() {
    const h = this.hover
    if (!h || h.kind === 'box') return
    this.snapshot()
    if (h.kind === 'fk') {
      const f = this.forklift(h.id)!
      f.vis = { ...f.vis, [h.i]: f.vis[h.i] === false }
    } else {
      const k = this.human(h.id)!.kpts[h.i]
      k[2] = k[2] ? 0 : 2
    }
    this.changed()
  }

  /** B: the selected forklifts' boxes back around their keypoints. */
  resetBox() {
    const set = this.ann.forklifts.filter((f) => f.box && this.selected.includes(f.id))
    if (!set.length) return
    this.snapshot()
    for (const f of set) delete f.box
    this.changed()
  }

  // ------------------------------------------------------------ side panel

  /** A side-panel row clicked: that one selected (add: added to / taken out of the selection). */
  select(id: string, add = false) {
    this.hidden.delete(id)
    this.selected = !add ? [id] : this.selected.includes(id) ? this.selected.filter((s) => s !== id) : [...this.selected, id]
    this.changed()
  }

  /** ⌘A: every shown forklift / person. */
  selectAll() { this.selected = [...this.ann.forklifts, ...this.ann.humans].map((a) => a.id).filter((id) => !this.hidden.has(id)); this.changed() }

  setHighlight(id: string | null) { this.highlight = id; this.requestDraw() }

  showAll() { this.hidden.clear(); this.changed() }
  /** Show / hide these instances (view only): the layers panel's eyes, X (the selection). */
  setHidden(ids: string[], hide: boolean) {
    for (const id of ids) if (hide) this.hidden.add(id); else this.hidden.delete(id)
    if (hide) this.selected = this.selected.filter((s) => !ids.includes(s))
    this.changed()
  }

  // ------------------------------------------------------------ state for React + drawing
  /** A box never leaves out a keypoint: a forklift's box (when set by hand) or a person's grows to hold
   * its keypoints (a person's visible ones: the hidden ones are placeholders), and a corner dragged
   * inward stops at them. */
  private contain(id: string) {
    const f = this.forklift(id), h = this.human(id), b = f ? f.box : h?.box
    if (!b) return
    for (const [x, y] of f ? f.kp : h!.kpts.filter((k) => k[2])) {
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y)
    }
  }

  private changed() {
    for (const { id } of [...this.ann.forklifts, ...this.ann.humans]) this.contain(id)   // after a load, undo, V…
    this.requestDraw()
    const fk = this.ann.forklifts.map((f) => ({ id: f.id, visible: f.kp.filter((_, i) => f.vis[i] !== false).length, hidden: this.hidden.has(f.id) }))
    const hu = this.ann.humans.map((h) => ({ id: h.id, visible: h.kpts.filter((k) => k[2]).length, hidden: this.hidden.has(h.id) }))
    let hover = ''
    const h = this.hover
    if (h?.kind === 'fk') hover = `${h.i} ${NAMES[h.i]} (${h.i < 4 ? '' : 'Shift+drag: all 4 bottom corners; '}V visible / hidden)`
    else if (h?.kind === 'hu') hover = `${PERSON_LABELS[h.i]} ${PERSON_KEYPOINTS[h.i]}`
    else if (h) hover = `box ${h.sx >= 0 && h.sy >= 0 ? 'corner' : 'edge'} (drag${this.forklift(h.id) ? '; B: back around the keypoints' : ''})`
    this.updateCursor()
    this.onChange({ mode: this.mode, roofStep: this.pendingRoof.length, selected: this.selected, forklifts: fk, humans: hu, hover,
      canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 })
  }

  requestDraw() {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw() })
  }

  private draw() {
    const c = this.ctx
    const { dpr } = this
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, this.canvas.width, this.canvas.height)
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (!this.img) return
    c.imageSmoothingEnabled = this.scale < 2
    c.drawImage(this.img, this.ox, this.oy, this.W * this.scale, this.H * this.scale)

    // the instances to emphasise (the others are dimmed): the one highlighted in the side panel, else the
    // selected ones; while a new forklift / person is drawn, the one being drawn (every existing one is dimmed)
    const focus = this.mode === 'roof' || this.mode === 'human' ? ['new'] : this.highlight ? [this.highlight] : this.selected
    for (const h of this.ann.humans) if (!this.hidden.has(h.id)) this.drawHuman(h, focus)
    for (const f of this.ann.forklifts) if (!this.hidden.has(f.id)) this.drawForklift(f, focus)
    for (const p of this.pins) this.drawPin(p)
    for (const [b, color, dash] of [[this.marquee, '#9ca3af', [4, 3]], [this.newBox, COLORS.person, []]] as const) {
      if (b) this.path([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], true, color, 1.5, [...dash])
    }

    if (this.mode === 'roof') {
      this.path([...this.pendingRoof, this.cursor], false, '#22c55e', 1.5, [4, 4])
      this.pendingRoof.forEach(([x, y], i) => this.dot(x, y, '#22c55e', true, String(i)))
    }
    if (this.mode === 'roof' || this.drag) this.drawLoupe()
  }

  /** A polyline through image points (closed: a polygon). */
  private path(pts: [number, number][], closed: boolean, stroke: string, width: number, dash: number[] = []) {
    const c = this.ctx
    c.beginPath()
    pts.forEach(([x, y], i) => { const [px, py] = this.toScreen(x, y); if (i) c.lineTo(px, py); else c.moveTo(px, py) })
    if (closed) c.closePath()
    c.setLineDash(dash)
    c.strokeStyle = stroke
    c.lineWidth = width
    c.stroke()
    c.setLineDash([])
  }

  /** The image around the cursor, magnified, in the canvas's bottom-left corner (bottom-right while the
   * cursor is near it): the roof corners place the whole truck, so they are worth placing to the pixel. */
  private drawLoupe() {
    const c = this.ctx, { size, zoom, margin } = LOUPE
    const [cx, cy] = this.toScreen(...this.cursor)
    const r = this.canvas.getBoundingClientRect()
    const ly = r.height - margin - size
    const near = cx < 2 * margin + size + 40 && cy > ly - 40
    const lx = near ? r.width - margin - size : margin
    const half = size / 2 / (this.scale * zoom)                // image pixels shown either side
    c.save()
    c.beginPath()
    c.rect(lx, ly, size, size)
    c.clip()
    c.fillStyle = '#000'
    c.fillRect(lx, ly, size, size)
    c.imageSmoothingEnabled = false
    c.drawImage(this.img!, this.cursor[0] - half, this.cursor[1] - half, 2 * half, 2 * half, lx, ly, size, size)
    c.strokeStyle = 'rgba(34,197,94,0.9)'
    c.lineWidth = 1
    c.beginPath()
    c.moveTo(lx + size / 2, ly); c.lineTo(lx + size / 2, ly + size)
    c.moveTo(lx, ly + size / 2); c.lineTo(lx + size, ly + size / 2)
    c.stroke()
    c.restore()
    c.strokeStyle = '#ffffff'
    c.lineWidth = 1.5
    c.strokeRect(lx, ly, size, size)
  }

  private dot(x: number, y: number, fill: string, ring: boolean, label?: string, r = 5) {
    const c = this.ctx
    const [px, py] = this.toScreen(x, y)
    c.beginPath()
    c.arc(px, py, r, 0, Math.PI * 2)
    c.fillStyle = fill
    c.fill()
    if (ring) { c.lineWidth = 2; c.strokeStyle = '#ffffff'; c.stroke() }
    if (label) {
      c.font = '600 11px ui-sans-serif, system-ui'
      c.lineWidth = 3
      c.strokeStyle = 'rgba(0,0,0,0.8)'
      c.strokeText(label, px + r + 2, py - r - 1)
      c.fillStyle = '#ffffff'
      c.fillText(label, px + r + 2, py - r - 1)
    }
  }

  /** An issue pin: a numbered disc (violet open, grey resolved), larger while its issue is open in the panel. */
  private drawPin(p: Pin) {
    const r = p.id === this.activePin ? PIN_RADIUS + 2 : PIN_RADIUS
    this.dot(p.x, p.y, p.resolved ? '#64748b' : '#8b5cf6', true, undefined, r)
    const [px, py] = this.toScreen(p.x, p.y), c = this.ctx
    c.font = '700 10px ui-sans-serif, system-ui'
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillStyle = '#ffffff'
    c.fillText(p.label, px, py + 0.5)
    c.textAlign = 'start'
    c.textBaseline = 'alphabetic'
  }

  /** An instance's box (thicker when selected, highlighted under the cursor), with its 8 handles when it is
   * the only one selected (the hovered handle larger). */
  private drawBox(id: string, b: Box, color: string, dash: number[] = []) {
    const [x1, y1, x2, y2] = b, lit = this.hoverBox === id, c = this.ctx, selected = this.selected.includes(id)
    this.path([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], true, color, (selected ? 2 : 1.2) + (lit ? 1 : 0), dash)
    if (lit) {
      const [px, py] = this.toScreen(x1, y1), [qx, qy] = this.toScreen(x2, y2)
      c.fillStyle = `${color}1f`
      c.fillRect(px, py, qx - px, qy - py)
    }
    if (this.one === id) for (const [hx, hy] of [...CORNERS, ...EDGES]) {
      const h = this.hover?.kind === 'box' && this.hover.id === id && this.hover.sx === hx && this.hover.sy === hy ? 6 : hx < 0 || hy < 0 ? 3 : 4
      const [px, py] = this.toScreen(hx < 0 ? (x1 + x2) / 2 : b[hx], hy < 0 ? (y1 + y2) / 2 : b[hy])
      c.fillStyle = color
      c.fillRect(px - h, py - h, 2 * h, 2 * h)
    }
  }

  /** A forklift: its box (pink, dashed until adjusted by hand), and in focus its roof (white), its bottom
   * outline (grey, 4-5-6-7), each bottom corner joined to the roof corner above it by a dotted line; its
   * keypoints (green visible, grey hidden; white ring: roof corner). */
  private drawForklift(f: ForkliftAnn, focus: string[]) {
    const c = this.ctx, kp = f.kp
    // in focus (selected, highlighted in the side panel, or a point / corner of it hovered): the lines are drawn;
    // otherwise only its box and keypoints, a little transparent (more while another one is focused)
    const focused = this.selected.includes(f.id) || this.highlight === f.id || this.hoverBox === f.id
    c.globalAlpha = focused ? 1 : focus.length && !focus.includes(f.id) ? 0.3 : 0.7
    this.drawBox(f.id, boxOf(f), COLORS.forklift, f.box ? [] : [6, 4])
    if (focused) {
      // outline edges: solid between visible points, dotted when one end is hidden
      const outline = (idx: number[], color: string) => idx.forEach((a, k) => {
        const b = idx[(k + 1) % idx.length], hidden = f.vis[a] === false || f.vis[b] === false
        this.path([kp[a], kp[b]], false, color, 1.6, hidden ? [4, 4] : [])
      })
      outline([0, 1, 2, 3], LINES)
      outline([4, 5, 6, 7], '#94a3b8')
      for (let i = 0; i < 4; i++) this.path([kp[i], kp[i + 4]], false, 'rgba(229,231,235,0.6)', 1, [4, 4])
    }
    kp.forEach(([x, y], i) => {
      const hovered = this.hover?.kind === 'fk' && this.hover.id === f.id && this.hover.i === i
      this.dot(x, y, f.vis[i] !== false ? '#22c55e' : 'rgba(148,163,184,0.75)', i < 4, String(i), hovered ? 7 : 5)
    })
    c.globalAlpha = 1
  }

  private drawHuman(h: Human, focus: string[]) {
    const c = this.ctx
    const selected = this.selected.includes(h.id) || this.highlight === h.id
    c.globalAlpha = focus.length && !focus.includes(h.id) ? 0.3 : 1
    this.drawBox(h.id, h.box, COLORS.person)
    c.lineWidth = 1.2
    c.beginPath()
    for (const [a, b] of PERSON_EDGES) {
      const ka = h.kpts[a], kb = h.kpts[b]
      if (!ka?.[2] || !kb?.[2]) continue
      const [ax, ay] = this.toScreen(ka[0], ka[1]), [bx, by] = this.toScreen(kb[0], kb[1])
      c.moveTo(ax, ay)
      c.lineTo(bx, by)
    }
    c.strokeStyle = LINES
    c.stroke()
    h.kpts.forEach(([x, y, v], i) => {
      if (!v && !selected) return
      const hovered = this.hover?.kind === 'hu' && this.hover.id === h.id && this.hover.i === i
      this.dot(x, y, v ? COLORS.person : 'rgba(148,163,184,0.6)', false, PERSON_LABELS[i], hovered ? 6.5 : 4.5)
    })
    c.globalAlpha = 1
  }
}
