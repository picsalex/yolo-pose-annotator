// The issues (staff: every one; annotators: those on the images of their tasks): open ones by
// default, a thread per issue, a link to its image.
import { useEffect, useState } from 'react'
import { IssueThread, when } from '@/components/issue-thread'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type Issue, api } from '@/lib/api'
import { cn } from '@/lib/utils'

const FILTERS = ['open', 'resolved', 'all'] as const

export default function Issues({ staff }: { staff: boolean }) {
  const [issues, setIssues] = useState<Issue[] | null>(null)
  const [show, setShow] = useState<(typeof FILTERS)[number]>('open')
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => { api<Issue[]>('/api/issues').then(setIssues) }, [])
  const update = (i: Issue) => setIssues((list) => list!.map((x) => (x.id === i.id ? i : x)))
  const rows = issues?.filter((i) => show === 'all' || (show === 'resolved') === i.resolved) ?? []
  return (
    <Card>
      <CardHeader className="flex items-start justify-between">
        <div className="grid gap-1.5">
          <CardTitle>Issues</CardTitle>
          <CardDescription>{staff ? 'Questions pinned on images by the annotators. Reply, open the image, resolve.'
            : 'Questions pinned on the images of your tasks. A manager resolves them.'}</CardDescription>
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <Button key={f} size="sm" variant={show === f ? 'secondary' : 'ghost'} onClick={() => setShow(f)}>
              {f} ({issues?.filter((i) => f === 'all' || (f === 'resolved') === i.resolved).length ?? 0})
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="grid gap-2">
        {issues && !rows.length && <p className="text-sm text-muted-foreground">No {show === 'all' ? '' : show} issues.</p>}
        {rows.map((i) => (
          <div key={i.id} className={cn('rounded-lg border', open === i.id && 'border-primary')}>
            <button type="button" className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/60"
              onClick={() => setOpen(open === i.id ? null : i.id)}>
              <Badge variant={i.resolved ? 'secondary' : 'outline'}>{i.resolved ? 'resolved' : 'open'}</Badge>
              <span className="min-w-0 flex-1 truncate"><span className="font-medium">{i.messages[0].user}</span>: {i.messages[0].text}</span>
              <span className="shrink-0 text-muted-foreground">{i.batch} / {i.filename}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{i.messages.length - 1} repl{i.messages.length === 2 ? 'y' : 'ies'} · {when(i.updated_at)}</span>
            </button>
            {open === i.id && (
              <div className="border-t p-3">
                <IssueThread issue={i} staff={staff} onChange={update}>
                  {(i.task_id || staff) && (
                    <Button size="sm" variant="ghost" onClick={() => {
                      window.location.hash = i.task_id ? `/task/${i.task_id}/${i.id}` : `/annotate/${i.batch_id}/${i.image_id}/${i.id}`
                    }}>Open the image</Button>
                  )}
                </IssueThread>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
