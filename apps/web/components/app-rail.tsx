'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BrandMark } from '@/components/brand-mark'
import { SignOutButton } from '@/components/sign-out-button'
import { StatusDot, StatusPill } from '@/components/status-pill'
import { authClient } from '@/lib/auth-client'
import { CAMERA_TZ } from '@/lib/camera-time'
import { formatCoverage, LOW_HEADROOM_DAYS } from '@/lib/format'
import { isActive, NAV } from '@/lib/nav'
import { useCameras, useHealth } from '@/lib/queries'
import { cn } from '@/lib/utils'

/**
 * The persistent left rail.
 *
 * It replaces a top nav bar for one reason: the two facts an operator wants
 * without navigating — is the camera up, and will the disk last — now have a
 * place to live that every screen shares. A horizontal bar had nowhere to put
 * them.
 */
export function AppRail() {
  const pathname = usePathname()
  const cameras = useCameras()
  const health = useHealth()
  const session = authClient.useSession()

  // The rail is a summary, so it aggregates rather than iterating - the fleet
  // detail is what the health page is for. `?? false` and not `?? true`: a
  // camera that cannot be confirmed up is not up.
  const total = cameras.data?.cameras.length ?? 0
  const up = cameras.data?.cameras.filter((camera) => camera.online).length ?? 0
  const online = up > 0

  const disk = health.data?.disk

  // The WORST camera, never an average. A mean coverage across seven cameras
  // hides a dead one behind six healthy ones, and a rail that reads 86% when
  // one camera recorded nothing all day is the exact failure this project is
  // about.
  const measured = (health.data?.cameras ?? []).filter((entry) => entry.coverage24h !== null)
  const camera = measured.reduce<(typeof measured)[number] | undefined>(
    (lowest, entry) =>
      lowest === undefined || (entry.coverage24h ?? 1) < (lowest.coverage24h ?? 1) ? entry : lowest,
    undefined,
  )
  const lowDisk = disk?.daysRemaining != null && disk.daysRemaining < LOW_HEADROOM_DAYS

  // Deliberately NOT a coverage threshold. "Below 95%" would be a number this
  // project invented, and the whole point of the coverage figure is that it is
  // measured rather than judged. These are facts: a camera is not publishing,
  // or the disk fills before retention recycles it.
  const someOffline = total > 0 && up < total
  const needsAttention = someOffline || lowDisk

  return (
    <aside className="bg-sidebar hidden h-dvh w-[264px] shrink-0 flex-col overflow-y-auto border-r px-3.5 py-4.5 md:flex">
      <Link href="/" className="flex items-center gap-2.5 px-2 pt-1 pb-4.5">
        <BrandMark />
        <span className="min-w-0">
          <span className="block text-base font-bold tracking-[-0.01em]">Ronda</span>
          <span className="text-muted-foreground block truncate text-[11px]">
            {total === 1 ? '1 camera' : `${total} cameras`} · {CAMERA_TZ.replace('_', ' ')}
          </span>
        </span>
      </Link>

      <nav className="flex flex-col gap-[3px]">
        {NAV.map((item) => {
          const active = isActive(pathname, item.href)

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex items-center gap-[11px] rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-muted text-foreground'
                  : 'text-secondary-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {/* The active marker is a bar on the edge rather than a colour
                  change alone, so the current screen is identifiable without
                  relying on hue. */}
              {active ? (
                <span
                  aria-hidden
                  className="bg-primary absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-r-[3px]"
                />
              ) : null}
              <item.icon className="size-[17px] shrink-0" aria-hidden />
              <span>{item.label}</span>

              {item.href === '/' && cameras.data ? (
                <span className="ml-auto">
                  <StatusDot online={online} />
                </span>
              ) : null}

              {item.href === '/health' && needsAttention ? (
                <span
                  className="bg-destructive text-destructive-foreground ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold"
                  title={
                    someOffline
                      ? `${total - up} of ${total} cameras are not publishing`
                      : 'Disk headroom is low'
                  }
                >
                  !
                </span>
              ) : null}
            </Link>
          )
        })}
      </nav>

      <div className="bg-card mt-5 rounded-lg border p-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
            Cameras
          </span>
          {cameras.data ? <StatusPill online={online} /> : null}
        </div>
        <dl className="text-muted-foreground mt-2.5 flex flex-col gap-[7px] text-xs">
          <RailStat
            // Named for what it is. "Coverage 24h" beside a worst-of-seven
            // number would read as the fleet average and understate nothing -
            // which is the wrong direction to be misread in.
            label={total > 1 ? 'Lowest coverage 24h' : 'Coverage 24h'}
            value={
              camera && camera.coverage24h !== null
                ? formatCoverage(camera.coverage24h, (camera.gapCount ?? 0) > 0)
                : '—'
            }
          />
          <RailStat
            label="Disk headroom"
            value={
              disk?.daysRemaining === null || disk === undefined
                ? '—'
                : `${disk.daysRemaining.toFixed(1)} days`
            }
            warn={lowDisk}
          />
        </dl>
      </div>

      <div className="mt-auto flex items-center gap-2 border-t px-1 pt-2.5">
        <span
          aria-hidden
          className="bg-muted text-secondary-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
        >
          {(session.data?.user.name ?? session.data?.user.email ?? 'OP').slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {session.data?.user.email ?? 'Operator'}
        </span>
        <SignOutButton appearance="icon" />
      </div>
    </aside>
  )
}

function RailStat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex justify-between gap-2 whitespace-nowrap">
      <dt>{label}</dt>
      <dd
        className={cn(
          'tabular-nums',
          warn ? 'text-amber-600 dark:text-amber-500' : 'text-foreground',
        )}
      >
        {value}
      </dd>
    </div>
  )
}
