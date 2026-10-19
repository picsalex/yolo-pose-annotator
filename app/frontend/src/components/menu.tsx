// A "..." button opening a short list of actions; a click elsewhere closes it.
import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function Menu({ items }: { items: { label: string; run: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <Button size="icon" variant="ghost" className="size-7" title="More" onClick={() => setOpen(!open)}><MoreHorizontal /></Button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 grid min-w-44 rounded-md border bg-background p-1 text-sm shadow-lg">
          {items.map((it) => (
            <button key={it.label} type="button" onClick={() => { setOpen(false); it.run() }}
              className={cn('rounded px-2 py-1.5 text-left hover:bg-accent', it.danger && 'text-destructive')}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
