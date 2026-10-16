import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Theme } from '@/lib/theme'

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <Button variant="ghost" size="icon" onClick={onToggle} title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  )
}
