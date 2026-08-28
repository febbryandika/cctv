import { readdir, stat, statfs } from 'node:fs/promises'
import type { Span } from './coverage'

// The filesystem is the source of truth for what was recorded
// (docs/ARCHITECTURE.md#data) - there is no segments table - so this module
// reads it directly and answers two questions: how many bytes a window of
// footage actually cost, and how much room is left for the next one.
//
// node:fs, never Bun.*. This module is reachable from AppType, which means
// apps/web typechecks it against @types/node with no @types/bun in sight
// (docs/ARCHITECTURE.md#the-api-surface). scripts/{doctor,measure}.ts keep
// their own Bun.Glob and `df -Pk` versions: they are manual, out of CI, and
// nothing imports them.

export type Segment = { mtimeMs: number; size: number }

const REPO_ROOT = new URL('../../../../', import.meta.url)

// The trailing slash is load-bearing: without it, resolving a camera's
// subdirectory against this URL replaces the last segment instead of descending
// into it, and the scan silently reads the wrong directory.
export const RECORDINGS_DIR = new URL(
  `${(process.env.RECORDINGS_DIR ?? './recordings').replace(/\/+$/, '')}/`,
  REPO_ROOT,
)

/**
 * Every recorded segment for a camera, weighed once.
 *
 * Segment files are weighed, never parsed for their timestamps. MediaMTX writes
 * `recordPath` with strftime in ITS OWN local time, which inside the container
 * is UTC while the host here runs Asia/Jakarta - so a filename that looks local
 * is not, and reading it as either is a seven-hour bug waiting for a different
 * deployment. mtime is an unambiguous instant and needs no zone at all.
 *
 * One pass, returning the raw pairs rather than a total, because the nightly
 * snapshot buckets the same list into seven day-windows and a per-window scan
 * would walk the directory seven times.
 */
export async function listSegments(slug: string): Promise<Segment[]> {
  const dir = new URL(`${slug}/`, RECORDINGS_DIR)

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    // A camera that has never recorded has no directory. Zero segments is the
    // honest answer; the coverage number already says the same thing.
    return []
  }

  const out: Segment[] = []

  for (const name of names) {
    if (!name.endsWith('.mp4')) continue

    try {
      const info = await stat(new URL(name, dir))
      out.push({ mtimeMs: info.mtimeMs, size: info.size })
    } catch {
      // Deleted between readdir and stat - recordDeleteAfter racing the scan.
      // One missing segment is not worth failing the whole report over.
    }
  }

  return out
}

/**
 * Bytes written inside a window, keyed on mtime.
 *
 * Half-open [start, end), the same convention spans use. A segment still being
 * written when the window opened is counted whole against the window it closed
 * in, which over 24 hours overstates by at most one segment at one edge.
 */
export function bytesIn(segments: Segment[], window: Span): number {
  return segments.reduce(
    (total, segment) =>
      segment.mtimeMs >= window.start && segment.mtimeMs < window.end
        ? total + segment.size
        : total,
    0,
  )
}

/**
 * Free and total bytes on the filesystem holding the recordings.
 *
 * `bavail`, not `bfree`: the latter counts the blocks reserved for root, which
 * this process cannot write to, and reporting them as free would promise
 * retention the disk will not deliver.
 *
 * null means "we could not tell" - the same distinction /cameras draws between
 * a camera that is down and a control API that could not be asked. Reporting
 * zero free bytes would read as a disk about to fill.
 */
export async function diskSpace(): Promise<{ freeBytes: number; totalBytes: number } | null> {
  try {
    const fs = await statfs(RECORDINGS_DIR)
    return { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize }
  } catch (error) {
    console.error('disk: could not stat the recordings filesystem -', error)
    return null
  }
}
