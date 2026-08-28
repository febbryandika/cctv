import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A measured number and what it measures. The caption is not decoration: every
 * figure in this app is a quantity with a denominator or a window attached, and
 * a bare "18.7" on a health page is unreadable without one.
 */
export function Figure({
  value,
  caption,
  warn,
  size = 'md',
}: {
  value: ReactNode
  caption: ReactNode
  warn?: boolean
  size?: 'md' | 'lg'
}) {
  return (
    <div>
      <p
        className={cn(
          'leading-none font-semibold tabular-nums',
          size === 'lg' ? 'text-[26px] font-bold' : 'text-2xl',
          warn && 'text-amber-600 dark:text-amber-500',
        )}
      >
        {value}
      </p>
      <p className="text-muted-foreground mt-1.5 text-[11.5px]">{caption}</p>
    </div>
  )
}

/** The same figure, boxed and labelled — the repeating tile on Live and Health. */
export function StatCard({
  label,
  value,
  caption,
  warn,
  className,
}: {
  label: ReactNode
  value: ReactNode
  caption?: ReactNode
  warn?: boolean
  className?: string
}) {
  return (
    <div className={cn('bg-card rounded-lg border px-4 py-3.5', className)}>
      <div className="text-muted-foreground text-[11px] font-semibold tracking-[0.07em] uppercase">
        {label}
      </div>
      <div
        className={cn(
          'mt-1.5 text-[22px] leading-none font-semibold tabular-nums',
          warn && 'text-amber-600 dark:text-amber-500',
        )}
      >
        {value}
      </div>
      {caption ? <div className="text-muted-foreground mt-1.5 text-[11.5px]">{caption}</div> : null}
    </div>
  )
}
