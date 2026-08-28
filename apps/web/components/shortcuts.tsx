'use client'

import { KeyboardIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { isTypingTarget } from '@/lib/keys'

// Only keys that are actually bound. A shortcut sheet listing something the app
// does not do is worse than no sheet, and this one is small enough that the
// temptation to pad it should be resisted.
const SHORTCUTS: { key: string; label: string }[] = [
  { key: '← →', label: 'Previous and next day, on Recordings' },
  { key: '+ −', label: 'Zoom the timeline in and out' },
  { key: '0', label: 'Back to the whole day' },
  { key: 'G', label: 'Jump to the next gap and zoom to fit it' },
  { key: 'scroll', label: 'Zoom under the cursor · shift-drag to pan' },
  { key: 'F', label: 'Fullscreen the live view' },
  { key: 'T', label: 'Switch light and dark' },
  { key: '?', label: 'This list' },
  { key: 'Esc', label: 'Close whatever is open' },
]

export function Shortcuts() {
  const [open, setOpen] = useState(false)
  const { resolvedTheme, setTheme } = useTheme()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return

      if (event.key === '?') {
        event.preventDefault()
        setOpen((was) => !was)
        return
      }

      if (event.key === 't' || event.key === 'T') {
        event.preventDefault()
        setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
      }
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [resolvedTheme, setTheme])

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        onClick={() => setOpen(true)}
      >
        <KeyboardIcon className="size-[15px]" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Keyboard</DialogTitle>
            <DialogDescription>
              Everything the pointer can do on the timeline, the keyboard can do too.
            </DialogDescription>
          </DialogHeader>
          <ul className="divide-border divide-y">
            {SHORTCUTS.map((shortcut) => (
              <li key={shortcut.key} className="flex items-center gap-4 py-2.5 text-sm">
                <kbd className="bg-muted text-secondary-foreground inline-flex h-6 min-w-14 items-center justify-center rounded-sm px-2 font-mono text-[11px] font-semibold">
                  {shortcut.key}
                </kbd>
                <span className="text-muted-foreground">{shortcut.label}</span>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}
