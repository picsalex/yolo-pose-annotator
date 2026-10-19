import {
  ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, ImageOff, Keyboard, Loader2, MessageSquarePlus, MousePointer2,
  Maximize, Redo2, Save, Trash2, Truck, Undo2, UserRound, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ask, dialogOpen } from '@/components/dialog'
import { IssueThread, textarea } from '@/components/issue-thread'
import { ThemeToggle } from '@/components/theme-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { type Ann, type EditorState, COLORS, Editor, ROOF_PROMPTS } from '@/editor/controller'
import { type Issue, type QueueImage, STEP, type Task, type User, api, isStaff } from '@/lib/api'
import { loadModel } from '@/lib/visibility'
import type { Theme } from '@/lib/theme'
import { KEYPOINTS } from '@/lib/forklift'
import { cn } from '@/lib/utils'

const imageCache = new Map<number, Promise<HTMLImageElement>>()
function loadImage(id: number): Promise<HTMLImageElement> {
  let p = imageCache.get(id)
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = `/api/images/${id}/file`
    })
    imageCache.set(id, p)
    if (imageCache.size > 12) imageCache.delete(imageCache.keys().next().value!)
  }
  return p
}

const SHORTCUTS: [string, [string, string][]][] = [
  ['Tools', [
    ['D', 'select / move (drag on empty space: select an area)'],
    ['F', 'forklift: click its 4 roof corners'],
    ['P', 'person: drag its box'],
    ['C', 'comment: pin an issue'],
  ]],
  ['Edit', [
    ['V', 'hovered point visible / hidden'],
    ['⇧ drag', 'the 4 bottom corners together'],
    ['B', 'forklift box back around its points'],
    ['⌘A', 'select all (⌘ / ⇧ click a side-panel row: add / remove it)'],
    ['Del', 'delete the selection'],
    ['⌘Z / ⇧⌘Z', 'undo / redo'],
  ]],
  ['View', [
    ['Space', 'hold to pan'],
    ['scroll / pinch', 'zoom'],
    ['+ / − / 0', 'zoom in / out / fit the image'],
    ['X / ⇧X', 'hide the selection / show all'],
  ]],
  ['Image', [
    ['↵', 'submit (review: approve), then next'],
    ['← / →', 'previous / next image'],
    ['⌘S', 'save'],
  ]],
]

/** An image of the editor's queue: my open tasks (from task taskId), or a batch's images (staff). */
type Item = QueueImage & { task?: Task }
const STATES: Record<string, string> = { todo: 'to do', progress: 'in progress', fix: 'to fix', done: 'done' }

export default function Annotate({ user, batchId, imageId, taskId, issueId, theme, onToggleTheme }: {
  user: User; batchId?: number; imageId?: number; taskId?: number; issueId?: number; theme: Theme; onToggleTheme: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const [queue, setQueue] = useState<Item[] | null>(null)
  const [title, setTitle] = useState('')
  const [index, setIndex] = useState(0)
  const [state, setState] = useState<EditorState | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')
  const [issues, setIssues] = useState<Issue[]>([])                 // pinned on the current image
  const [activeIssue, setActiveIssue] = useState<number | null>(null)
  const [draft, setDraft] = useState<{ x: number; y: number; text: string } | null>(null)   // a new issue being written
  const [help, setHelp] = useState(false)                           // the shortcuts popup
  const [tab, setTab] = useState<'shapes' | 'issues'>(issueId ? 'issues' : 'shapes')
  const loadedRef = useRef<number | null>(null)

  // the queue: my open tasks, from the one opened; or a batch's images, from imageId (else the first not approved)
  const isStart = (it: Item) => (taskId ? it.task?.id === taskId : it.id === imageId)
  const [more, setMore] = useState(false)                           // my tasks: 50 at a time, more after these
  const tasks = useCallback(async (query: string) => {
    const r = await api<{ items: Task[]; more: boolean }>(`/api/tasks/queue?${query}`)
    setMore(r.more)
    return r.items.map((t): Item => ({ id: t.image_id, filename: t.filename, width: t.width, height: t.height, status: t.state, task: t }))
  }, [])
  useEffect(() => {
    const load = taskId
      ? tasks(`task=${taskId}`).then((items) => ({ title: '', items }))   // tasks: the step's pill says it
      : api<{ batch: string; images: QueueImage[] }>(`/api/batches/${batchId}/images`).then(({ batch, images }) => ({ title: batch, items: images as Item[] }))
    load.then(({ title, items }) => {
      setTitle(title)
      setQueue(items)
      const at = items.findIndex(taskId || imageId ? isStart : (i) => i.status !== 'approved')
      setIndex(Math.max(at, 0))
    }).catch((e) => setError(e.message))
  }, [batchId, imageId, taskId, tasks])

  // editor
  useEffect(() => {
    const canvas = canvasRef.current!, ed = new Editor(canvas), wheel = (e: WheelEvent) => ed.wheel(e)
    ed.onChange = setState
    ed.onPin = (id) => { setActiveIssue((a) => (a === id ? null : id)); setTab('issues') }
    ed.onComment = (x, y) => { setDraft({ x, y, text: '' }); setActiveIssue(null); setTab('issues') }
    editorRef.current = ed
    loadModel().then((m) => { ed.model = m }).catch(() => {})    // without it, new points start visible
    ed.resize()
    const ro = new ResizeObserver(() => ed.resize())
    ro.observe(canvas)
    canvas.addEventListener('wheel', wheel, { passive: false })   // not passive (React's is): it may stop the page's zoom
    return () => { ro.disconnect(); canvas.removeEventListener('wheel', wheel) }
  }, [])

  const current = queue?.[index]

  // load the current image + annotation, prefetch the next ones
  useEffect(() => {
    if (!current) return
    let cancelled = false
    const run = async () => {
      setBusy('Loading')
      try {
        const [img, ann, iss] = await Promise.all([
          loadImage(current.id),
          api<{ data: Ann | null }>(`/api/images/${current.id}/annotation`),
          api<Issue[]>(`/api/images/${current.id}/issues`),
        ])
        if (cancelled) return
        editorRef.current!.load(img, ann.data)
        setIssues(iss)
        setActiveIssue(isStart(current) && issueId ? issueId : null)      // opened from the Issues page
        setDraft(null)
        loadedRef.current = current.id
        window.history.replaceState(null, '', current.task ? `#/task/${current.task.id}` : `#/annotate/${batchId}/${current.id}`)
        setError('')
      } catch (e) {
        setError(`could not load ${current.filename}: ${(e as Error).message}`)
      } finally {
        if (!cancelled) setBusy('')
      }
      for (const q of queue!.slice(index + 1, index + 3)) loadImage(q.id).catch(() => {})
    }
    run()
    return () => { cancelled = true }
  }, [current, batchId, index, queue, imageId, taskId, issueId])

  // the issue pins on the canvas
  useEffect(() => {
    // resolved issues leave the canvas, unless opened in the side panel
    const pins = issues.map((i, k) => ({ id: i.id, x: i.x, y: i.y, label: String(k + 1), resolved: i.resolved }))
      .filter((p) => !p.resolved || p.id === activeIssue)
    if (draft) pins.push({ id: -1, x: draft.x, y: draft.y, label: '+', resolved: false })
    editorRef.current?.setPins(pins, draft ? -1 : activeIssue)
  }, [issues, activeIssue, draft])

  const postIssue = async () => {
    if (!current || !draft) return
    try {
      const i = await api<Issue>(`/api/images/${current.id}/issues`, { body: { x: draft.x, y: draft.y, text: draft.text } })
      setIssues((list) => [...list, i])
      setActiveIssue(i.id)
      setDraft(null)
    } catch (e) { setError((e as Error).message) }
  }

  /** Saved; a task still to do that was worked on (its annotation changed) is now in progress: it stays mine. */
  const save = useCallback(async () => {
    const ed = editorRef.current
    if (!ed || !current || loadedRef.current !== current.id) return
    await api(`/api/images/${current.id}/annotation`, { method: 'PUT', body: { data: ed.serialize() } })
    if (current.task?.state === 'todo' && ed.edited()) {
      await api(`/api/tasks/${current.task.id}/start`, { method: 'POST' })
      setQueue((q) => q!.map((it) => (it === current ? { ...it, task: { ...it.task!, state: 'progress' } } : it)))
    }
  }, [current])

  // closing the tab, reloading or typing another address: save what is there (status unchanged)
  useEffect(() => {
    const leave = () => {
      const ed = editorRef.current
      if (!ed || !current || loadedRef.current !== current.id) return
      fetch(`/api/images/${current.id}/annotation`, {
        method: 'PUT', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: ed.serialize() }),
      })
      if (current.task?.state === 'todo' && ed.edited())
        fetch(`/api/tasks/${current.task.id}/start`, { method: 'POST', keepalive: true })
    }
    window.addEventListener('pagehide', leave)
    window.addEventListener('hashchange', leave)
    return () => { window.removeEventListener('pagehide', leave); window.removeEventListener('hashchange', leave) }
  }, [current])

  /** The next image; past the last of the queue, my next 50 tasks (if any). */
  const forward = useCallback(async () => {
    if (!queue) return
    if (index < queue.length - 1) { setIndex(index + 1); return }
    const last = queue[queue.length - 1].task
    if (!last || !more) return
    const items = await tasks(`after=${last.id}`)
    if (items.length) { setQueue(items); setIndex(0) }
  }, [index, more, queue, tasks])

  /** Leave the image (← / →): saved, the task left as it is. */
  const goTo = useCallback(async (next: number) => {
    if (!queue) return
    try { await save() } catch (e) { setError(`save failed: ${(e as Error).message}`); return }
    if (next > index) await forward()
    else setIndex(Math.max(next, 0))
  }, [forward, index, queue, save])

  const task = current?.task, live = task && task.state !== 'done' ? task : null   // the image's task, when still open
  /** ↵: saved, then an open annotate task submitted (to review) or an open review approved (or rejected,
   * with a comment for the annotator); then the next image. */
  const finish = useCallback(async (approved = true, comment = '') => {
    if (!queue || !current) return
    try {
      await save()
      if (live) {
        await api(`/api/tasks/${live.id}/${live.step === 'annotate' ? 'submit' : 'review'}`, { body: live.step === 'annotate' ? {} : { approved, comment } })
        const result = live.step === 'review' ? (approved ? 'approved' : 'rejected') : null
        setQueue((q) => q!.map((it) => (it === current ? { ...it, task: { ...live, state: 'done', result } } : it)))
      }
    } catch (e) { setError((e as Error).message); return }
    await forward()
  }, [current, forward, live, queue, save])

  /** An approved review taken back: open again, the image back to annotated. */
  const unapprove = async () => {
    if (!task) return
    try {
      await api(`/api/tasks/${task.id}/unapprove`, { method: 'POST' })
      setQueue((q) => q!.map((it) => (it === current ? { ...it, task: { ...task, state: 'progress', result: null } } : it)))
    } catch (e) { setError((e as Error).message) }
  }

  const reject = async () => {
    const why = await ask({ title: 'Reject', message: 'It goes back to its annotator with this comment.', danger: true,
      confirm: 'Reject', input: { multiline: true, placeholder: 'What to fix' } })
    if (why?.trim()) finish(false, why.trim())
  }

  /** ⌘S: saved, nothing else. */
  const saveNow = useCallback(async () => {
    try {
      await save()
      setFlash('Saved')
      setTimeout(() => setFlash(''), 1200)
    } catch (e) { setError(`save failed: ${(e as Error).message}`) }
  }, [save])

  /** Background image: nothing to annotate. Its annotations are removed (an empty label file in the
   * export), then as ↵: submitted / approved, and the next image. */
  const markBackground = useCallback(async () => {
    const ed = editorRef.current
    if (!ed || !current) return
    const n = ed.ann.forklifts.length + ed.ann.humans.length
    const then = live ? (live.step === 'annotate' ? ' It is then submitted.' : ' It is then approved.') : ''
    const message = `You are marking this image as a background image: there is nothing on it to annotate, and it is exported with an empty label file.${
      n ? ` Its ${n} annotation${n > 1 ? 's are' : ' is'} deleted.` : ''}${then} Are you sure?`
    if (await ask({ title: 'Background image', message, confirm: 'Mark as background', danger: n > 0 }) === null) return
    ed.clearAll()
    await finish()
  }, [current, finish, live])

  // keyboard
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const ed = editorRef.current
      if (!ed || dialogOpen() || ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) return
      const mod = e.metaKey || e.ctrlKey
      if (e.key === ' ') { if (!e.repeat) ed.setSpace(true); e.preventDefault(); return }
      if (e.key === '?') { setHelp((h) => !h); return }
      if (e.key === 'Escape' && help) { setHelp(false); return }
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) ed.redo(); else ed.undo(); return }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); return }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); ed.selectAll(); return }
      if (mod && ['+', '=', '-', '0'].includes(e.key)) e.preventDefault()   // the image zooms, not the page
      else if (mod) return
      switch (e.key) {
        case 'd': case 'D': ed.startDrag(); break
        case 'f': case 'F': ed.startForklift(); break
        case 'c': case 'C': ed.startComment(); break
        case 'p': case 'P': ed.startHuman(); break
        case 'v': case 'V': ed.toggleVisibility(); break
        case 'b': case 'B': ed.resetBox(); break
        case 'x': ed.setHidden(ed.selected, true); break
        case 'X': ed.showAll(); break
        case '0': ed.fitView(); break
        case '+': case '=': ed.zoom(1.25); break
        case '-': ed.zoom(0.8); break
        case 'Escape': ed.cancel(); break
        case 'Delete': case 'Backspace': ed.deleteSelection(); break
        case 'Enter': e.preventDefault(); finish(); break
        case 'ArrowRight': e.preventDefault(); goTo(index + 1); break
        case 'ArrowLeft': e.preventDefault(); goTo(index - 1); break
        default: return
      }
    }
    const up = (e: KeyboardEvent) => { if (e.key === ' ') editorRef.current?.setSpace(false) }
    const blur = () => editorRef.current?.setSpace(false)          // Space released in another window
    // a pinch (ctrl + wheel; Safari: gesture events) never zooms the page around the studio
    const pinch = (e: Event) => { if (!(e instanceof WheelEvent) || e.ctrlKey) e.preventDefault() }
    const on: [string, EventListener, AddEventListenerOptions?][] = [['keydown', down as EventListener], ['keyup', up as EventListener],
      ['blur', blur], ['wheel', pinch, { passive: false }], ['gesturestart', pinch], ['gesturechange', pinch]]
    for (const [type, f, o] of on) window.addEventListener(type, f, o)
    return () => { for (const [type, f] of on) window.removeEventListener(type, f) }
  }, [finish, goTo, help, index, saveNow])

  const ed = editorRef.current
  const left = queue?.filter((q) => (q.task ? q.task.state !== 'done' : q.status !== 'approved')).length ?? 0
  const prompt = state?.mode === 'roof'
    ? `Click roof corner ${state.roofStep + 1}/4: ${state.roofStep} ${ROOF_PROMPTS[state.roofStep]}   (Esc to cancel)`
    : state?.mode === 'human' ? 'Drag a box around the person   (Esc to cancel)'
    : state?.mode === 'comment' ? 'Click the spot the issue is about   (Esc to cancel)' : ''
  const mode = state?.mode ?? 'idle'
  const TOOLS: ({ icon: typeof Truck; label: string; active?: boolean; disabled?: boolean; run: () => void } | null)[] = [
    { icon: MousePointer2, label: 'Select / move (D)', active: mode === 'idle', run: () => ed?.startDrag() },
    { icon: Truck, label: 'Forklift: click its 4 roof corners (F)', active: mode === 'roof', run: () => ed?.startForklift() },
    { icon: UserRound, label: 'Person: drag a box (P)', active: mode === 'human', run: () => ed?.startHuman() },
    null,
    { icon: MessageSquarePlus, label: 'Comment: pin an issue on the image (C)', active: mode === 'comment', run: () => ed?.startComment() },
    { icon: Undo2, label: 'Undo (⌘Z)', disabled: !state?.canUndo, run: () => ed?.undo() },
    { icon: Redo2, label: 'Redo (⇧⌘Z)', disabled: !state?.canRedo, run: () => ed?.redo() },
    null,
    { icon: ZoomIn, label: 'Zoom in (+)', run: () => ed?.zoom(1.25) },
    { icon: ZoomOut, label: 'Zoom out (−)', run: () => ed?.zoom(0.8) },
    { icon: Maximize, label: 'Fit the image (0)', run: () => ed?.fitView() },
    null,
    { icon: ImageOff, label: 'Background image: nothing to annotate (saved with an empty label file)', disabled: !current, run: markBackground },
    null,
    { icon: Keyboard, label: 'Keyboard shortcuts (?)', active: help, run: () => setHelp(!help) },
  ]

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button variant="ghost" size="icon" title={taskId ? 'Back to my tasks' : 'Back to the batches'}
          onClick={async () => { await save().catch(() => {}); window.location.hash = taskId ? '/' : '/admin' }}>
          <ArrowLeft />
        </Button>
        {task ? <span className="rounded px-2 py-0.5 text-xs font-semibold text-white" style={{ background: STEP[task.step].color }}>{STEP[task.step].doing}</span>
          : <span className="font-medium">{title}</span>}
        {current && <span className="truncate text-sm text-muted-foreground">{task ? `${task.batch} / ` : ''}{current.filename}</span>}
        {task ? <Badge variant={task.state === 'done' ? 'success' : task.state === 'fix' ? 'destructive' : 'outline'}>
          {task.result ?? STATES[task.state]}</Badge>
          : current && <Badge variant={current.status === 'approved' ? 'success' : 'outline'}>{current.status}</Badge>}
        <span className="text-sm text-muted-foreground">{queue ? `${index + 1} / ${queue.length} · ${left} ${taskId ? 'open' : 'not approved'}` : ''}</span>
        {busy && <span className="flex items-center gap-1 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{busy}</span>}
        {flash && <Badge variant="success"><Check />{flash}</Badge>}
        {error && <span className="truncate text-sm text-destructive">{error}</span>}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={saveNow} disabled={!current} title="Save">
            <Save />Save <Kbd>⌘S</Kbd>
          </Button>
          <Button size="sm" variant="outline" onClick={() => goTo(index - 1)} disabled={!index} title="Previous image (←)"><ChevronLeft /></Button>
          <Button size="sm" variant="outline" onClick={() => goTo(index + 1)} disabled={!queue || (index >= queue.length - 1 && !more)} title="Next image (→)"><ChevronRight /></Button>
          {task?.step === 'review' && task.result === 'approved' && (
            <Button size="sm" variant="outline" onClick={unapprove} title="Open this review again">Cancel approval</Button>
          )}
          {live?.step === 'review' && <Button size="sm" variant="outline" onClick={reject} title="Send it back to its annotator">Reject</Button>}
          <Button size="sm" onClick={() => finish()} disabled={!queue?.length}
            title={live ? (live.step === 'annotate' ? 'Save, submit to review, next image' : 'Save, approve, next image') : 'Save, next image'}>
            {live ? (live.step === 'annotate' ? 'Submit' : 'Approve') : 'Next'} <Kbd className="bg-primary-foreground/20 text-primary-foreground">↵</Kbd>
          </Button>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-neutral-200 dark:bg-neutral-950">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 size-full"
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); ed?.pointerDown(e.nativeEvent) }}
            onPointerMove={(e) => ed?.pointerMove(e.nativeEvent)}
            onPointerUp={() => ed?.pointerUp()}
            onPointerLeave={() => ed?.pointerLeave()}
            onContextMenu={(e) => e.preventDefault()}
          />
          {live?.comment && !prompt && (
            <div className="pointer-events-none absolute top-3 left-1/2 max-w-[60%] -translate-x-1/2 rounded-md bg-destructive px-3 py-1.5 text-sm text-white">
              Sent back by the review: {live.comment}
            </div>
          )}
          {prompt && (
            <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-md bg-black/75 px-3 py-1.5 text-sm text-white">{prompt}</div>
          )}
          {state?.hover && (
            <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-black/75 px-2 py-1 text-xs text-white">{state.hover}</div>
          )}
          {queue && !queue.length && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">{taskId ? 'No open tasks.' : 'No images in this batch.'}</div>
          )}
          <nav className="absolute top-1/2 right-3 flex -translate-y-1/2 flex-col items-center gap-1 rounded-2xl border bg-background/95 p-1.5 shadow-lg">
            {TOOLS.map((t, k) => t ? (
              <Button key={k} size="icon" variant="ghost" title={t.label} disabled={t.disabled} onClick={t.run}
                className={cn('rounded-xl', t.active ? 'bg-[#042AFF] text-white hover:bg-[#042AFF] hover:text-white' : 'hover:bg-[#042AFF]/15')}><t.icon /></Button>
            ) : <div key={k} className="my-1 h-px w-6 bg-border" />)}
          </nav>
          {help && <ShortcutsPopup onClose={() => setHelp(false)} />}
        </div>
        <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l p-3 text-sm">
          <div className="flex items-center border-b">
            {([['shapes', 'Shapes', state ? state.forklifts.length + state.humans.length : 0], ['issues', 'Issues', issues.filter((i) => !i.resolved).length]] as const).map(([k, title, n]) => (
              <button key={k} type="button" onClick={() => setTab(k)}
                className={cn('-mb-px flex items-center gap-1.5 border-b-2 px-3 pb-2 font-medium', tab === k ? 'border-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                {title}<span className="font-normal text-muted-foreground">{n}</span>
              </button>
            ))}
          </div>
          {tab === 'shapes' && state && <Layers state={state} ed={ed} />}
          {tab === 'issues' && <section className="grid grid-cols-1 gap-2">
            {!issues.length && !draft && <p className="text-muted-foreground">No issues. Pin one with the comment tool (C).</p>}
            {draft && (
              <div className="grid gap-2 rounded-md border border-[#7D24FF] p-2">
                <textarea autoFocus className={textarea} placeholder="What is the question?" value={draft.text}
                  onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
                <div className="flex gap-2">
                  <Button size="sm" disabled={!draft.text.trim()} onClick={postIssue}>Post</Button>
                  <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                </div>
              </div>
            )}
            {issues.map((i, k) => (
              <div key={i.id} className={cn('rounded-md border', activeIssue === i.id && 'border-[#7D24FF]')}>
                <button type="button" className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-accent/60"
                  onClick={() => setActiveIssue(activeIssue === i.id ? null : i.id)}>
                  <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white',
                    i.resolved ? 'bg-[#9E9E9E]' : 'bg-[#7D24FF]')}>{k + 1}</span>
                  {activeIssue === i.id
                    ? <span className="text-muted-foreground">{i.resolved ? 'resolved' : 'open'}</span>
                    : <span className="min-w-0 flex-1 truncate">{i.messages[0].text}</span>}
                </button>
                {activeIssue === i.id && (
                  <div className="border-t p-2">
                    <IssueThread issue={i} staff={isStaff(user)} onChange={(n) => setIssues((list) => list.map((x) => (x.id === n.id ? n : x)))} />
                  </div>
                )}
              </div>
            ))}
          </section>}
        </aside>
      </div>
    </div>
  )
}

/** The keyboard shortcuts and what the colours mean (the toolbar's keyboard button, or ?). */
function ShortcutsPopup({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="grid max-h-[90%] w-[min(720px,90%)] gap-3 overflow-y-auto rounded-xl border bg-background p-4 text-sm shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-medium">Keyboard shortcuts <span className="font-normal text-muted-foreground">(?)</span></h3>
          <Button variant="ghost" size="icon" className="size-7" onClick={onClose} title="Close (Esc)"><X /></Button>
        </div>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {SHORTCUTS.map(([group, keys]) => (
            <div key={group} className="grid content-start gap-1.5">
              <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{group}</h4>
              {keys.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-2"><Kbd>{k}</Kbd><span className="text-right text-muted-foreground">{v}</span></div>
              ))}
            </div>
          ))}
        </div>
        <div className="border-t pt-3 text-xs text-muted-foreground">Points: <span style={{ color: COLORS.visible }}>green</span> visible, grey hidden (exported as 0 0 0), white ring = roof corner. Forklift: 0-3 roof corners, 4-7 bottom corners on the truck (under 0-3: where its bottom edge turns the corner, not on a wheel or fork). <span style={{ color: COLORS.forklift }}>Pink</span>: a forklift's box, dashed while it follows the points; <span style={{ color: COLORS.person }}>cyan</span>: a person's. <span style={{ color: COLORS.issue }}>Violet</span> pins: open issues (a resolved one shows, grey, only while opened in the side panel). People: H head, W waist, L left foot, R right foot (the person's own left / right).</div>
      </div>
    </div>
  )
}

/** The shapes (forklifts and people), Photoshop-style: a group per class (eye, fold, count) and a compact row per
 * instance (eye, class colour, name, visible points; delete on hover). A row click selects (⌘ / ⇧: adds
 * or removes), hovering highlights it on the image. */
function Layers({ state, ed }: { state: EditorState; ed: Editor | null }) {
  const [fold, setFold] = useState<Record<string, boolean>>({ forklifts: true, people: true })   // groups start folded
  const groups = [
    { key: 'forklifts', title: 'Forklifts', name: 'Forklift', color: COLORS.forklift, of: KEYPOINTS, items: state.forklifts },
    { key: 'people', title: 'People', name: 'Person', color: COLORS.person, of: 4, items: state.humans },
  ]
  const all = [...state.forklifts, ...state.humans]
  const eye = (hidden: boolean, ids: string[], title: string) => (
    <button type="button" title={title} disabled={!ids.length} onClick={(e) => { e.stopPropagation(); ed?.setHidden(ids, !hidden) }}
      className="flex size-8 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40">
      {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
    </button>
  )
  const stripe = (color: string) => <span className="h-full w-1 shrink-0" style={{ background: color }} />
  return (
    <section className="grid grid-cols-1 gap-2">
      {!all.length && <p className="text-muted-foreground">No shapes yet. Draw a forklift (F) or a person (P).</p>}
      <div className={cn('divide-y overflow-hidden rounded-md border', !all.length && 'hidden')}>
        {groups.filter((g) => g.items.length).flatMap((g) => {
          const ids = g.items.map((it) => it.id)
          return [
            <div key={g.key} className="flex h-8 items-center bg-muted/40">
              {eye(ids.length > 0 && g.items.every((it) => it.hidden), ids, `Show / hide the ${g.title.toLowerCase()}`)}
              {stripe(g.color)}
              <button type="button" className="flex h-full flex-1 items-center gap-1 px-2 text-left font-medium" onClick={() => setFold({ ...fold, [g.key]: !fold[g.key] })}>
                <ChevronDown className={cn('size-3.5 transition-transform', fold[g.key] && '-rotate-90')} />{g.title}
                <span className="ml-auto font-normal text-muted-foreground">{g.items.length}</span>
              </button>
            </div>,
            ...(fold[g.key] ? [] : g.items.map((it, k) => (
              <div key={it.id} onClick={(e) => ed?.select(it.id, e.metaKey || e.ctrlKey || e.shiftKey)}
                onMouseEnter={() => ed?.setHighlight(it.id)} onMouseLeave={() => ed?.setHighlight(null)}
                className={cn('group flex h-8 cursor-pointer items-center', state.selected.includes(it.id) ? 'bg-accent' : 'hover:bg-accent/50',
                  it.hidden && 'opacity-50')}>
                {eye(it.hidden, [it.id], 'Show / hide (X)')}
                {stripe(g.color)}
                <span className="flex-1 truncate pl-6">{g.name} {k + 1}</span>
                <span className="text-xs text-muted-foreground" title="visible keypoints">{it.visible}/{g.of}</span>
                <button type="button" title="Delete (Del)" onClick={(e) => { e.stopPropagation(); ed?.select(it.id); ed?.deleteSelection() }}
                  className="invisible flex size-8 items-center justify-center text-muted-foreground group-hover:visible hover:text-destructive">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))),
          ]
        })}
      </div>
    </section>
  )
}
