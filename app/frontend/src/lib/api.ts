export type Role = 'admin' | 'manager' | 'annotator'
export interface User { id: number; username: string; role: Role; theme: 'dark' | 'light' }
/** Admins and managers: they run the batches, the campaigns, the users and the issues. */
export const isStaff = (u: User) => u.role !== 'annotator'
export interface UserRow extends User { tasks: { todo: number; done: number } }
export interface BatchRow {
  id: number; name: string; total: number; annotated: number; approved: number
  campaign: { id: number; name: string } | null
}
export type Step = 'annotate' | 'review'
export type TaskState = 'todo' | 'progress' | 'fix' | 'done'
export interface Task {
  id: number; step: Step; state: TaskState; result: 'approved' | 'rejected' | null; comment: string | null
  image_id: number; filename: string; width: number; height: number; batch_id: number; batch: string; campaign: string
  open_issues: number; updated_at: string | null
}
export interface TaskList { items: Task[]; total: number; counts: Record<TaskState, number>; batches: { id: number; name: string }[] }
export interface StepCount { todo: number; done: number }
export interface Campaign {
  id: number; name: string; batch_id: number; batch: string; created_at: string; members: Record<Step, number[]>
  total: number; annotated: number; approved: number; rejected: number; done: boolean
  people: { id: number | null; username: string; annotate: StepCount; review: StepCount }[]
}
export interface Message { user: string; text: string; at: string }
export interface Issue {
  id: number; image_id: number; batch_id: number; batch: string; filename: string
  x: number; y: number; resolved: boolean; messages: Message[]; updated_at: string; task_id: number | null
}
/** An image of a batch (todo -> annotated -> approved), or of a task (status: the task's state). */
export interface QueueImage { id: number; filename: string; width: number; height: number; status: string }

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  })
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).detail ?? msg } catch { /* not json */ }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export const imageUrl = (id: number) => `/api/images/${id}/file`

/** A zip of images into batch `name` (new or existing), with upload progress (0-100). */
export function uploadZip(file: File, name: string, onProgress: (pct: number) => void): Promise<{ added: number }> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('PUT', `/api/batches/upload?name=${encodeURIComponent(name)}`)
    x.upload.onprogress = (e) => onProgress((100 * e.loaded) / e.total)
    x.onload = () => {
      let r: any = {}
      try { r = JSON.parse(x.responseText) } catch { /* not json */ }
      if (x.status < 300) resolve(r); else reject(new Error(r.detail ?? x.statusText))
    }
    x.onerror = () => reject(new Error('upload failed'))
    x.send(file)
  })
}
