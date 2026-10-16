// In-app dialogs, in the same style as the shortcuts popup, instead of the browser's confirm / prompt:
//   if (await ask({ title, message, confirm: 'Delete', danger: true }) === null) return
//   const text = await ask({ title, input: { multiline: true } })        // null: cancelled
// One <DialogHost /> (in App) shows them. ↵ confirms (⇧↵: a new line), Esc cancels.
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { textarea } from '@/components/issue-thread'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export interface Ask {
  title: string
  message?: React.ReactNode
  confirm?: string                  // the confirm button (default OK)
  danger?: boolean                  // a red confirm button
  input?: { placeholder?: string; type?: string; multiline?: boolean; match?: string }   // match: the text that must be typed
}
type Shown = Ask & { resolve: (v: string | null) => void }

let show: (d: Shown) => void = () => {}
let shown = false
/** Is a dialog open? (the editor's shortcuts wait meanwhile) */
export const dialogOpen = () => shown

/** Resolves to the typed text ('' without an input) once confirmed, null when cancelled. */
export const ask = (a: Ask) => new Promise<string | null>((resolve) => show({ ...a, resolve }))

export function DialogHost() {
  const [d, setD] = useState<Shown | null>(null)
  const [text, setText] = useState('')
  useEffect(() => { show = (x) => { setText(''); setD(x) } }, [])
  const ok = !d?.input || (d.input.match !== undefined ? text === d.input.match : text.trim() !== '')
  const close = (v: string | null) => { d?.resolve(v); setD(null) }
  useEffect(() => {
    shown = !!d
    if (!d) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && !(e.key === 'Enter' && !e.shiftKey)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') close(null)
      else if (ok) close(text)
    }
    window.addEventListener('keydown', key, true)          // before the editor's shortcuts
    return () => window.removeEventListener('keydown', key, true)
  })
  if (!d) return null
  const field = { autoFocus: true, placeholder: d.input?.placeholder, value: text,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value) }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => close(null)}>
      <div className="grid w-[min(440px,90%)] gap-3 rounded-xl border bg-background p-4 text-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-medium">{d.title}</h3>
          <Button variant="ghost" size="icon" className="size-7" onClick={() => close(null)} title="Cancel (Esc)"><X /></Button>
        </div>
        {d.message && <div className="text-muted-foreground">{d.message}</div>}
        {d.input && (d.input.multiline ? <textarea className={textarea} {...field} /> : <Input type={d.input.type} {...field} />)}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => close(null)}>Cancel</Button>
          <Button autoFocus={!d.input} size="sm" variant={d.danger ? 'destructive' : 'default'} disabled={!ok} onClick={() => close(text)}>
            {d.confirm ?? 'OK'}
          </Button>
        </div>
      </div>
    </div>
  )
}
