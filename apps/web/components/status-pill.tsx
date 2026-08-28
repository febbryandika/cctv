import { cn } from '@/lib/utils'

/**
 * Online / offline, in the one shape the app uses everywhere.
 *
 * The dot rather than a `success` Badge variant: the radix-nova registry has no
 * such variant, and editing components/ui/badge.tsx to add one would drift that
 * file from the registry and make the next `shadcn add` a merge conflict.
 *
 * Online pulses. A static green dot is indistinguishable from a frozen page,
 * which on a live-view screen is exactly the wrong impression to give.
 */
export function StatusPill({ online, className }: { online: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold',
        online ? 'border' : 'bg-destructive text-destructive-foreground',
        className,
      )}
    >
      {online ? <StatusDot online /> : null}
      {online ? 'Online' : 'Offline'}
    </span>
  )
}

export function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        online ? 'bg-rec animate-status' : 'bg-destructive',
      )}
    />
  )
}
