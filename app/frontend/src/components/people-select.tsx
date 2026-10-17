// A multi-select of people: the chosen ones as chips (× takes one out); a click opens a list to
// search by name, a page at a time, ticking people in or out.
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { UserRow } from '@/lib/api'

const PAGE = 8

export function PeopleSelect({ users, value, onChange }: { users: UserRow[]; value: number[]; onChange: (ids: number[]) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {                                     // a click elsewhere closes the list
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const found = users.filter((u) => u.username.toLowerCase().includes(q.trim().toLowerCase()))
  const pages = Math.max(1, Math.ceil(found.length / PAGE)), p = Math.min(page, pages - 1)
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  return (
    <div ref={ref} className="relative">
      <div role="button" tabIndex={0} onClick={() => setOpen(!open)}
        className="flex min-h-9 cursor-pointer flex-wrap items-center gap-1 rounded-md border bg-background px-2 py-1 text-sm">
        {users.filter((u) => value.includes(u.id)).map((u) => (
          <Badge key={u.id} variant="secondary">{u.username}
            <X className="size-3 cursor-pointer" onClick={(e) => { e.stopPropagation(); toggle(u.id) }} />
          </Badge>
        ))}
        {!value.length && <span className="text-muted-foreground">Choose people</span>}
        <ChevronDown className="ml-auto size-4 text-muted-foreground" />
      </div>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-md border bg-background p-2 shadow-lg">
          <Input autoFocus placeholder="Search a name" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} className="h-8" />
          <div className="mt-2 grid">
            {found.slice(p * PAGE, (p + 1) * PAGE).map((u) => (
              <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
                <input type="checkbox" className="accent-primary" checked={value.includes(u.id)} onChange={() => toggle(u.id)} />
                {u.username}<span className="ml-auto text-xs text-muted-foreground">{u.role}</span>
              </label>
            ))}
            {!found.length && <p className="px-2 py-1.5 text-sm text-muted-foreground">No one matches.</p>}
          </div>
          {pages > 1 && (
            <div className="mt-1 flex items-center justify-end gap-1 text-xs text-muted-foreground">
              {p + 1} / {pages}
              <Button size="icon" variant="ghost" className="size-7" disabled={!p} onClick={() => setPage(p - 1)}><ChevronLeft /></Button>
              <Button size="icon" variant="ghost" className="size-7" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}><ChevronRight /></Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
