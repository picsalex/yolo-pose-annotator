// Annotation campaigns (staff): start one on a batch with its people per step, follow its progress
// (per step and per person), add or remove people on the way (the open tasks are dispatched again).
import { Play, RefreshCw, Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ask } from '@/components/dialog'
import { when } from '@/components/issue-thread'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { type BatchRow, type Campaign, type Step, type UserRow, api } from '@/lib/api'

type Members = Record<Step, number[]>
const STEP_TITLE: Record<Step, string> = { annotate: 'Annotation', review: 'Review' }

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [users, setUsers] = useState<UserRow[]>([])
  const [message, setMessage] = useState('')
  const refresh = useCallback(async () => {
    const [c, b, u] = await Promise.all([api<Campaign[]>('/api/campaigns'), api<BatchRow[]>('/api/batches'), api<UserRow[]>('/api/users')])
    setCampaigns(c); setBatches(b); setUsers(u)
  }, [])
  useEffect(() => { refresh() }, [refresh])
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setMessage('')
    try { await f(); setMessage(ok); await refresh() } catch (e) { setMessage((e as Error).message) }
  }
  return (
    <div className="grid gap-8">
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <NewCampaign batches={batches.filter((b) => !b.campaign && b.total)} users={users} run={run} />
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Campaigns</h2>
        <Button size="sm" variant="ghost" onClick={refresh}><RefreshCw />Refresh</Button>
      </div>
      {!campaigns.length && <p className="text-sm text-muted-foreground">No campaign yet.</p>}
      {campaigns.map((c) => <CampaignCard key={c.id} c={c} users={users} run={run} />)}
    </div>
  )
}

type Run = (f: () => Promise<unknown>, ok: string) => Promise<void>

/** Who works on each step: a checkbox per user, a column per step. */
function PeoplePicker({ users, value, onChange }: { users: UserRow[]; value: Members; onChange: (m: Members) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {(['annotate', 'review'] as Step[]).map((step) => (
        <div key={step} className="grid content-start gap-2">
          <Label>{STEP_TITLE[step]} ({value[step].length})</Label>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {users.map((u) => (
              <Label key={u.id} className="font-normal">
                <input type="checkbox" className="accent-primary" checked={value[step].includes(u.id)}
                  onChange={(e) => onChange({ ...value, [step]: e.target.checked ? [...value[step], u.id] : value[step].filter((x) => x !== u.id) })} />
                {u.username}
              </Label>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function NewCampaign({ batches, users, run }: { batches: BatchRow[]; users: UserRow[]; run: Run }) {
  const [name, setName] = useState('')
  const [batch, setBatch] = useState(0)
  const [members, setMembers] = useState<Members>({ annotate: [], review: [] })
  const ready = name.trim() && batch && members.annotate.length && members.review.length
  return (
    <Card>
      <CardHeader>
        <CardTitle>New campaign</CardTitle>
        <CardDescription>
          Every image of the batch is annotated, then reviewed by someone else than its annotator. The images are shared between
          each step's people; the same people can be in both steps.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-2"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} className="w-56" /></div>
          <div className="grid gap-2"><Label>Batch</Label>
            <select className="h-9 w-56 rounded-md border bg-background px-2 text-sm" value={batch} onChange={(e) => setBatch(Number(e.target.value))}>
              <option value={0}>{batches.length ? 'choose a batch' : 'no batch without a campaign'}</option>
              {batches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.total} images)</option>)}
            </select>
          </div>
        </div>
        <PeoplePicker users={users} value={members} onChange={setMembers} />
        <div>
          <Button disabled={!ready} onClick={() => run(async () => {
            await api('/api/campaigns', { body: { name, batch_id: batch, ...members } })
            setName(''); setBatch(0); setMembers({ annotate: [], review: [] })
          }, `Started ${name}.`)}><Play />Start the campaign</Button>
        </div>
      </CardContent>
    </Card>
  )
}

function CampaignCard({ c, users, run }: { c: Campaign; users: UserRow[]; run: Run }) {
  const [editing, setEditing] = useState<Members | null>(null)
  const bar = (title: string, n: number) => (
    <div className="grid gap-1">
      <div className="flex justify-between text-sm"><span>{title}</span><span className="text-muted-foreground">{n} / {c.total}</span></div>
      <Progress value={c.total ? (100 * n) / c.total : 0} />
    </div>
  )
  return (
    <Card>
      <CardHeader className="flex items-start justify-between">
        <div className="grid gap-1.5">
          <CardTitle className="flex items-center gap-2">{c.name}{c.done ? <Badge variant="success">done</Badge> : <Badge variant="outline">in progress</Badge>}</CardTitle>
          <CardDescription>{c.batch} · started {when(c.created_at)} · {c.rejected} sent back by the review</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(editing ? null : c.members)}><Users />People</Button>
          <Button size="icon" variant="ghost" title="Delete the campaign (the annotations stay)" onClick={async () => {
            if (await ask({ title: `Delete ${c.name}`, danger: true, confirm: 'Delete', message: 'Its tasks go; the annotations stay on the images.' }) !== null)
              run(() => api(`/api/campaigns/${c.id}`, { method: 'DELETE' }), `Deleted ${c.name}.`)
          }}><Trash2 /></Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">{bar('Annotated', c.annotated)}{bar('Approved', c.approved)}</div>
        {editing && (
          <div className="grid gap-3 rounded-lg border p-3">
            <PeoplePicker users={users} value={editing} onChange={setEditing} />
            <p className="text-xs text-muted-foreground">Saving shares the tasks nobody started yet (opened and changed) between the people above; those removed give back their unfinished ones.</p>
            <div className="flex gap-2">
              <Button size="sm" disabled={!editing.annotate.length || !editing.review.length} onClick={() => run(async () => {
                await api(`/api/campaigns/${c.id}/members`, { method: 'PUT', body: editing })
                setEditing(null)
              }, `${c.name}: tasks dispatched again.`)}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </div>
        )}
        <Table>
          <TableHeader>
            <TableRow><TableHead>Person</TableHead><TableHead>Steps</TableHead><TableHead>To annotate</TableHead><TableHead>Annotated</TableHead><TableHead>To review</TableHead><TableHead>Reviewed</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {c.people.map((p) => (
              <TableRow key={p.id ?? 'none'} className={p.id ? '' : 'text-muted-foreground'}>
                <TableCell className="font-medium">{p.id ? p.username : 'waiting for someone'}</TableCell>
                <TableCell>{(['annotate', 'review'] as Step[]).filter((s) => p.id && c.members[s].includes(p.id)).map((s) => STEP_TITLE[s]).join(', ') || '-'}</TableCell>
                <TableCell>{p.annotate.todo}</TableCell><TableCell>{p.annotate.done}</TableCell>
                <TableCell>{p.review.todo}</TableCell><TableCell>{p.review.done}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
