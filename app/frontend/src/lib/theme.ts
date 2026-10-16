export type Theme = 'dark' | 'light'
const KEY = 'studio-theme'   // remembered in the browser too, for the sign-in page

export function applyTheme(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark')
  try { localStorage.setItem(KEY, t) } catch { /* storage unavailable */ }
}

export function storedTheme(): Theme {
  try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark' } catch { return 'dark' }
}
