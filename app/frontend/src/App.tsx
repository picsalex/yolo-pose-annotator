import { LogOut } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DialogHost } from '@/components/dialog'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { type User, api, isStaff } from '@/lib/api'
import { applyTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import Admin from '@/pages/Admin'
import Annotate from '@/pages/Annotate'
import Campaigns from '@/pages/Campaigns'
import Issues from '@/pages/Issues'
import Tasks from '@/pages/Tasks'
import Login from '@/pages/Login'

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || '/')
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || '/')
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const hash = useHash()
  const [counts, setCounts] = useState({ tasks: 0, issues: 0 })     // the header's badges: my open tasks, open issues
  useEffect(() => {
    if (!user) return
    const get = () => api<typeof counts>('/api/me/counts').then(setCounts).catch(() => {})
    get()
    const t = setInterval(get, 60_000)
    return () => clearInterval(t)
  }, [user?.id, hash])
  const signIn = (u: User) => { applyTheme(u.theme); setUser(u) }
  useEffect(() => { api<User>('/api/me').then(signIn).catch(() => setUser(null)) }, [])

  if (user === undefined) return null
  if (!user) return <Login onLogin={signIn} />

  const toggleTheme = () => {
    const theme = user.theme === 'dark' ? 'light' : 'dark'
    applyTheme(theme)
    setUser({ ...user, theme })
    api('/api/me', { method: 'PATCH', body: { theme } }).catch(() => {})
  }

  const parts = hash.split('/').filter(Boolean)
  const n = (k: number) => (parts[k] ? Number(parts[k]) : undefined)
  // #/task/<task>[/<issue>]: my tasks from that one; #/annotate/<batch>[/<image>[/<issue>]]: a batch (staff)
  const annotate = parts[0] === 'task' && parts[1] ? { taskId: n(1), issueId: n(2) }
    : parts[0] === 'annotate' && parts[1] && isStaff(user) ? { batchId: n(1), imageId: n(2), issueId: n(3) } : null
  if (annotate) return <><Annotate key={hash} user={user} {...annotate} theme={user.theme} onToggleTheme={toggleTheme} /><DialogHost /></>

  const logout = async () => { await api('/api/logout', { method: 'POST' }); setUser(null); window.location.hash = '/' }
  const page = parts[0] === 'issues' || (isStaff(user) && ['campaigns', 'admin'].includes(parts[0])) ? parts[0] : 'tasks'
  const tab = (to: string, label: string, n?: number, what = '') => (
    <a href={`#/${to === 'tasks' ? '' : to}`} title={n === undefined ? undefined : `${n} ${what}`}
      className={cn('flex items-center gap-1.5', page === to ? 'text-foreground' : 'hover:text-foreground')}>
      {label}{n !== undefined && (   // red while there is something to do, grey at 0
        <span className={cn('rounded-full px-1.5 text-[11px] leading-[18px] font-medium', n ? 'bg-destructive text-white' : 'bg-muted text-muted-foreground')}>{n}</span>
      )}
    </a>
  )
  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-6">
          <a href="#/" className="font-semibold tracking-tight">Studio</a>
          <nav className="flex gap-4 text-sm text-muted-foreground">
            {tab('tasks', 'My tasks', counts.tasks, 'open tasks')}{tab('issues', 'Issues', counts.issues, 'open issues')}
            {isStaff(user) && <>{tab('campaigns', 'Campaigns')}{tab('admin', 'Admin')}</>}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
            {user.username}
            <ThemeToggle theme={user.theme} onToggle={toggleTheme} />
            <Button variant="ghost" size="icon" onClick={logout} title="Sign out"><LogOut /></Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        {page === 'admin' ? <Admin user={user} /> : page === 'campaigns' ? (parts[1] ? <Tasks key={parts[1]} staff campaign={n(1)} /> : <Campaigns />)
          : page === 'issues' ? <Issues staff={isStaff(user)} /> : <Tasks staff={isStaff(user)} />}
      </main>
      <DialogHost />
    </div>
  )
}
