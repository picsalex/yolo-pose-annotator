// My tasks (everyone): one row per image to annotate or review, filtered by state, step, batch and
// filename, sorted by a column header, paginated. A row opens the editor on that task.
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { when } from '@/components/issue-thread'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { STEP, type Step, type Task, type TaskList, type TaskState, api } from '@/lib/api'
import { cn } from '@/lib/utils'

const SIZE = 50                                       // per page (the API's)
const STATES: [TaskState | '', string][] = [['', 'All'], ['todo', 'To do'], ['progress', 'In progress'], ['fix', 'To fix'], ['done', 'Done']]
const label = (t: Task) => (t.state === 'done' ? t.result ?? 'submitted' : STATES.find(([s]) => s === t.state)![1].toLowerCase())

export default function Tasks() {
  const [f, setF] = useState({ step: 'review' as Step, state: '', batch: 0, q: '', sort: 'filename', order: 'asc', page: 1 })
  const [data, setData] = useState<TaskList | null>(null)
  const first = useRef(true)
  useEffect(() => {
    const params = new URLSearchParams(Object.entries(f).map(([k, v]) => [k, String(v)]))
    const t = setTimeout(() => api<TaskList>(`/api/tasks?${params}`).then((d) => {
      // first load: on Review when reviews wait (annotations do not stay blocked), else on Annotate
      if (first.current) {
        first.current = false
        if (!d.open.review && d.open.annotate) return setF((g) => ({ ...g, step: 'annotate' }))
      }
      setData(d)
    }).catch(() => {}), f.q ? 250 : 0)   // typing: wait a little
    return () => clearTimeout(t)
  }, [f])
  const set = (patch: Partial<typeof f>) => setF({ ...f, page: 1, ...patch })
  const sortBy = (sort: string) => set({ sort, order: f.sort === sort && f.order === 'asc' ? 'desc' : 'asc' })
  const head = (key: string, title: string) => (
    <TableHead className="cursor-pointer select-none" onClick={() => sortBy(key)}>
      <span className="inline-flex items-center gap-1">{title}{f.sort === key && (f.order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}</span>
    </TableHead>
  )
  const open = data?.items.find((t) => t.state !== 'done')
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE))
  const select = 'h-9 rounded-md border bg-background px-2 text-sm'
  return (
    <Card>
      <CardHeader className="flex items-start justify-between">
        <div className="grid gap-1.5">
          <CardTitle>My tasks</CardTitle>
          <CardDescription>{f.step === 'annotate' ? 'Images to annotate, or to fix after a review.'
            : "Someone else's annotations: approve them, correct them, or send them back."}</CardDescription>
        </div>
        <Button disabled={!open} onClick={() => { window.location.hash = `/task/${open!.id}` }}>Continue</Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex gap-1 border-b">
          {(['annotate', 'review'] as Step[]).map((s) => (
            <button key={s} type="button" onClick={() => set({ step: s, state: s === 'review' && f.state === 'fix' ? '' : f.state })}
              className={cn('-mb-px flex items-center gap-2 border-b-2 px-4 pb-2 font-medium', f.step === s ? '' : 'border-transparent text-muted-foreground hover:text-foreground')}
              style={f.step === s ? { borderColor: STEP[s].color } : undefined}>
              {STEP[s].title}
              <span className="rounded-full px-1.5 text-[11px] leading-[18px] text-white" style={{ background: data?.open[s] ? STEP[s].color : 'var(--muted-foreground)' }}
                title={`${data?.open[s] ?? 0} open`}>{data?.open[s] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {STATES.filter(([s]) => s !== 'fix' || f.step === 'annotate').map(([s, title]) => (
            <Button key={s} size="sm" variant={f.state === s ? 'secondary' : 'ghost'} onClick={() => set({ state: s })}>
              {title} <span className="text-muted-foreground">{data ? (s ? data.counts[s] : Object.values(data.counts).reduce((a, b) => a + b, 0)) : ''}</span>
            </Button>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Input placeholder="Search a filename" value={f.q} onChange={(e) => set({ q: e.target.value })} className="w-52" />
            <select className={select} value={f.batch} onChange={(e) => set({ batch: Number(e.target.value) })}>
              <option value={0}>All batches</option>
              {data?.batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>{head('filename', 'Image')}{head('batch', 'Batch')}<TableHead>State</TableHead><TableHead>Issues</TableHead>{head('updated', 'Updated')}</TableRow>
          </TableHeader>
          <TableBody>
            {data?.items.map((t) => (
              <TableRow key={t.id} className="cursor-pointer" onClick={() => { window.location.hash = `/task/${t.id}` }}>
                <TableCell className="max-w-80 truncate font-medium" title={t.filename}>{t.filename}</TableCell>
                <TableCell className="text-muted-foreground">{t.batch}</TableCell>
                <TableCell>
                  <Badge variant={t.state === 'fix' || t.result === 'rejected' ? 'destructive' : t.state === 'done' ? 'success' : 'outline'}
                    title={t.comment ?? undefined}>{label(t)}</Badge>
                </TableCell>
                <TableCell>{t.open_issues > 0 && <span className="inline-flex items-center gap-1 text-[#7D24FF]"><MessageSquare className="size-3.5" />{t.open_issues}</span>}</TableCell>
                <TableCell className="text-muted-foreground">{t.updated_at ? when(t.updated_at) : ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {data && !data.items.length && <p className="text-sm text-muted-foreground">No {STEP[f.step].title.toLowerCase()} tasks{f.state || f.batch || f.q ? ' match these filters' : ' yet'}.</p>}
        <div className={cn('flex items-center justify-end gap-2 text-sm text-muted-foreground', !data?.total && 'hidden')}>
          {data && `${(f.page - 1) * SIZE + 1}-${Math.min(f.page * SIZE, data.total)} of ${data.total}`}
          <Button size="icon" variant="ghost" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}><ChevronLeft /></Button>
          <Button size="icon" variant="ghost" disabled={f.page >= pages} onClick={() => setF({ ...f, page: f.page + 1 })}><ChevronRight /></Button>
        </div>
      </CardContent>
    </Card>
  )
}
