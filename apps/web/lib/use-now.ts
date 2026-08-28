'use client'

import { useCallback, useSyncExternalStore } from 'react'

/**
 * The current instant, re-read on an interval. Null on the server.
 *
 * Reading Date.now() during render is impure and React is right to refuse it,
 * but so is the useState+useEffect version — setting state synchronously in an
 * effect just to seed a clock is a cascading render. A clock is an external
 * source of truth, which is exactly what useSyncExternalStore is for.
 *
 * The snapshot is rounded down to the interval so it is stable between ticks:
 * returning a raw Date.now() would be a new value on every read and re-render
 * forever. The server snapshot is null, so nothing time-dependent is rendered
 * until after hydration and there is no mismatch to warn about.
 */
export function useNow(intervalMs: number): number | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const timer = setInterval(onChange, intervalMs)
      return () => clearInterval(timer)
    },
    [intervalMs],
  )

  const getSnapshot = useCallback(
    () => Math.floor(Date.now() / intervalMs) * intervalMs,
    [intervalMs],
  )

  return useSyncExternalStore(subscribe, getSnapshot, () => null)
}
