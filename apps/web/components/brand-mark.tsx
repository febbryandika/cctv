import { VideoIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The one piece of identity this app has. Rail and sign-in share it. */
export function BrandMark({
  className,
  iconClassName,
}: {
  className?: string
  iconClassName?: string
}) {
  return (
    <div
      aria-hidden
      className={cn(
        'bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md',
        className,
      )}
    >
      <VideoIcon className={cn('size-[18px]', iconClassName)} />
    </div>
  )
}
