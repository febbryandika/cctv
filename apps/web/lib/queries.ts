'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

// The rail shows camera status and disk headroom on every screen, so these two
// queries are no longer owned by one page each. They live here so both callers
// share a key AND an interval: two useQuery calls on the same key with
// different refetchIntervals do not error, they quietly poll at the shorter of
// the two, which is the kind of thing that only shows up as a surprising API
// log a month later.

// A status light, not a stream — the picture arrives over WHEP
// (docs/ARCHITECTURE.md#the-whep-proxy) — so this only has to be fast enough
// that an operator notices a drop. refetchIntervalInBackground stays off (the
// default), so a hidden tab stops polling instead of hammering the API all
// night.
export const CAMERAS_REFETCH_MS = 10_000

// Disk free and bytes-per-hour move slowly, and the fast-moving fact — a camera
// dropping — arrives over SSE instead. This is the floor, not the mechanism.
export const HEALTH_REFETCH_MS = 30_000

export function useCameras() {
  return useQuery({
    queryKey: ['cameras'],
    queryFn: async ({ signal }) => {
      const res = await api.cameras.$get(undefined, { init: { signal } })
      // Thrown so an expired session surfaces as an error state rather than a
      // blank card.
      if (!res.ok) throw new Error(`GET /cameras responded ${res.status}`)
      return res.json()
    },
    refetchInterval: CAMERAS_REFETCH_MS,
  })
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: async ({ signal }) => {
      const res = await api.health.$get(undefined, { init: { signal } })
      // Thrown so an expired session surfaces as an error state rather than a
      // page of zeroes, which on this page would read as a dead system.
      if (!res.ok) throw new Error(`GET /health responded ${res.status}`)
      return res.json()
    },
    refetchInterval: HEALTH_REFETCH_MS,
  })
}
