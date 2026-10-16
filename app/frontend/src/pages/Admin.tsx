import { Download, Trash2, Upload, UserPlus } from 'lucide-react'
import { ask } from '@/components/dialog'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { type BatchRow, type Role, type User, type UserRow, api, uploadZip } from '@/lib/api'

export default function Admin({ user }: { user: User }) {
  const [users, setUsers] = useState<UserRow[]>([])
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [message, setMessage] = useState('')
  const refresh = useCallback(async () => {
    const [u, b] = await Promise.all([api<UserRow[]>('/api/users'), api<BatchRow[]>('/api/batches')])
    setUsers(u)
    setBatches(b)
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const run = async (f: () => Promise<unknown>, ok?: string) => {
    setMessage('')
    try { await f(); if (ok) setMessage(ok); await refresh() }
    catch (e) { setMessage((e as Error).message) }
  }

  return (
    <div className="grid gap-8">
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <BatchesCard user={user} batches={batches} run={run} />
      <UsersCard user={user} users={users} run={run} />
    </div>
  )
}

type Run = (f: () => Promise<unknown>, ok?: string) => Promise<void>

/** A zip of images into a new or an existing batch. */
function UploadForm({ batches, run }: { batches: BatchRow[]; run: Run }) {
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [pct, setPct] = useState<number | null>(null)
  const upload = (e: React.FormEvent) => {
    e.preventDefault()
    run(async () => {
      try { await uploadZip(file!, name, setPct) } finally { setPct(null) }
      setFile(null)
    }, `Uploaded ${file?.name} into ${name}.`)
  }
  return (
    <form onSubmit={upload} className="flex flex-wrap items-center gap-2">
      <Input type="file" accept=".zip" className="w-60" key={file ? 'set' : 'empty'} onChange={(e) => {
        const f = e.target.files?.[0] ?? null
        setFile(f)
        if (f && !name) setName(f.name.replace(/\.zip$/i, ''))
      }} />
      <Input list="batch-names" placeholder="batch (new or existing)" value={name} onChange={(e) => setName(e.target.value)} className="w-52" />
      <datalist id="batch-names">{batches.map((b) => <option key={b.id} value={b.name} />)}</datalist>
      {pct === null
        ? <Button type="submit" size="sm" disabled={!file || !name.trim()}><Upload />Upload</Button>
        : <span className="flex w-40 items-center gap-2 text-sm text-muted-foreground"><Progress value={pct} />{pct < 100 ? `${Math.round(pct)}%` : 'unpacking'}</span>}
    </form>
  )
}

const INCLUDE = [['approved', 'approved (reviewed)'], ['annotated', 'annotated or reviewed'], ['all', 'everything (not annotated: background)']]

function BatchesCard({ user, batches, run }: { user: User; batches: BatchRow[]; run: Run }) {
  const [val, setVal] = useState(10)
  const [include, setInclude] = useState('approved')
  return (
    <Card>
      <CardHeader className="flex items-start justify-between">
        <div className="grid gap-1.5">
          <CardTitle>Batches</CardTitle>
          <CardDescription>Upload a zip of images (any folders inside) into a new batch, or add it to an existing one. Its annotation runs as a campaign (Campaigns tab).</CardDescription>
        </div>
        <UploadForm batches={batches} run={run} />
      </CardHeader>
      <CardContent className="grid gap-4">
        {!batches.length && <p className="text-sm text-muted-foreground">No batches yet: upload a zip of images.</p>}
        {batches.map((b) => (
          <div key={b.id} className="grid gap-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{b.name}</span>
              <span className="text-sm text-muted-foreground">{b.total} images · {b.annotated} annotated · {b.approved} approved</span>
              <Progress value={b.total ? (100 * b.approved) / b.total : 0} className="w-40" />
              {b.campaign ? <Badge variant="secondary">campaign: {b.campaign.name}</Badge> : <Badge variant="outline">no campaign running</Badge>}
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => { window.location.hash = `/annotate/${b.id}` }} title="Browse and correct its images">Open</Button>
                {user.role === 'admin' && (
                  <Button size="icon" variant="ghost" title="Delete the batch" onClick={async () => {
                    if (await ask({ title: `Delete ${b.name}`, danger: true, confirm: 'Delete', input: { match: b.name, placeholder: b.name },
                      message: `This deletes its ${b.total} images, their annotations, issues and campaigns. Type its name to confirm.` }) !== null)
                      run(() => api(`/api/batches/${b.id}`, { method: 'DELETE' }), `Deleted ${b.name}.`)
                  }}><Trash2 /></Button>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span className="flex items-center gap-2">
                Export
                <select className="h-8 rounded-md border bg-background px-2" value={include} onChange={(e) => setInclude(e.target.value)}>
                  {INCLUDE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <Input type="number" min={0} max={50} value={val} onChange={(e) => setVal(Number(e.target.value))} className="h-8 w-16" />
                <span className="text-muted-foreground">% val</span>
                <Button size="sm" asChild><a href={`/api/batches/${b.id}/export?include=${include}&val=${val / 100}`}><Download />Download</a></Button>
              </span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function UsersCard({ user, users, run }: { user: User; users: UserRow[]; run: Run }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('annotator')
  const roles: Role[] = user.role === 'admin' ? ['annotator', 'manager', 'admin'] : ['annotator', 'manager']   // managers cannot touch admins
  const create = (e: React.FormEvent) => {
    e.preventDefault()
    run(async () => {
      await api('/api/users', { body: { username, password, role } })
      setUsername(''); setPassword(''); setRole('annotator')
    }, `Created ${username}.`)
  }
  const select = 'h-9 rounded-md border bg-background px-2 text-sm'
  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
        <CardDescription>Everyone signs in with the username and password set here. Annotators work on their tasks; managers and admins run the batches, the campaigns, the users and the issues (only admins manage admins and delete batches).</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <div className="grid gap-2"><Label>Username</Label><Input value={username} onChange={(e) => setUsername(e.target.value)} className="w-44" /></div>
          <div className="grid gap-2"><Label>Password</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-44" /></div>
          <div className="grid gap-2"><Label>Role</Label>
            <select className={select} value={role} onChange={(e) => setRole(e.target.value as Role)}>{roles.map((r) => <option key={r}>{r}</option>)}</select>
          </div>
          <Button type="submit" disabled={!username || !password}><UserPlus />Create</Button>
        </form>
        <Table>
          <TableHeader>
            <TableRow><TableHead>User</TableHead><TableHead>Role</TableHead><TableHead>Tasks open / done</TableHead><TableHead /></TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => {
              const locked = u.role === 'admin' && user.role !== 'admin'
              return (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.username}</TableCell>
                <TableCell>
                  {locked || u.id === user.id ? <Badge variant={u.role === 'annotator' ? 'secondary' : 'default'}>{u.role}</Badge> : (
                    <select className={select} value={u.role} onChange={(e) =>
                      run(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }), `${u.username} is now ${e.target.value}.`)}>
                      {roles.map((r) => <option key={r}>{r}</option>)}
                    </select>
                  )}
                </TableCell>
                <TableCell>{u.tasks.todo} / {u.tasks.done}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" disabled={locked} onClick={async () => {
                    const p = await ask({ title: `New password for ${u.username}`, confirm: 'Change', input: { type: 'password' } })
                    if (p) run(() => api(`/api/users/${u.id}/password`, { body: { password: p } }), `Password changed for ${u.username}.`)
                  }}>Reset password</Button>
                  <Button variant="ghost" size="icon" title="Delete" disabled={locked || u.id === user.id} onClick={async () => {
                    if (await ask({ title: `Delete ${u.username}`, danger: true, confirm: 'Delete',
                      message: 'Their open tasks go to the others of their campaign steps.' }) !== null)
                      run(() => api(`/api/users/${u.id}`, { method: 'DELETE' }), `Deleted ${u.username}.`)
                  }}><Trash2 /></Button>
                </TableCell>
              </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
