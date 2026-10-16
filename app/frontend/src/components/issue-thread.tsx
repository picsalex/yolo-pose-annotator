// An issue's messages, a reply box and (staff) resolve / reopen; used on the Issues page
// and in the annotation side panel.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { type Issue, api } from '@/lib/api'

/** A server time (naive UTC) in the browser's time zone. */
export const when = (at: string) => new Date(`${at}Z`).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })

export const textarea = 'min-h-16 w-full rounded-md border bg-background px-2 py-1.5 text-sm'

export function IssueThread({ issue, staff, onChange, children }:
  { issue: Issue; staff: boolean; onChange: (i: Issue) => void; children?: React.ReactNode }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const act = (path: string, body: unknown) =>
    api<Issue>(path, { body }).then((i) => { onChange(i); setText(''); setError('') }).catch((e) => setError(e.message))
  return (
    <div className="grid gap-2">
      {issue.messages.map((m, k) => (
        <div key={k} className="grid gap-0.5">
          <span className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{m.user}</span> · {when(m.at)}</span>
          <p className="text-sm whitespace-pre-wrap">{m.text}</p>
        </div>
      ))}
      <textarea className={textarea} placeholder="Reply…" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!text.trim()} onClick={() => act(`/api/issues/${issue.id}/messages`, { text })}>Reply</Button>
        {staff && (
          <Button size="sm" variant="outline" onClick={() => act(`/api/issues/${issue.id}/resolve`, { resolved: !issue.resolved })}>
            {issue.resolved ? 'Reopen' : 'Resolve'}
          </Button>
        )}
        {children}
      </div>
      {error && <span className="text-sm text-destructive">{error}</span>}
    </div>
  )
}
