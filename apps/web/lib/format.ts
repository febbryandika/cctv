// Numbers that appear on more than one screen, formatted in one place. The
// timeline, the health panel and the rail all print coverage; before this they
// printed it from two different modules, one of which imported the other for
// the privilege (docs/ARCHITECTURE.md#measurement).

/**
 * Coverage as a percentage, with one refusal: never 100.00% while a gap is
 * listed. A two-second hole in a day is 99.9977%, which rounds up at two
 * decimals, and a perfect score printed beside visible holes is precisely the
 * contradiction this app exists to avoid.
 */
export function formatCoverage(coverage: number, hasGaps: boolean): string {
  const percent = coverage * 100
  if (hasGaps && percent > 99.99) return '>99.99%'
  return `${percent.toFixed(2)}%`
}

/** Bytes as GB, decimal not binary — the unit disk vendors and `df` both use. */
export const formatGb = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`

/**
 * Bytes at whichever scale reads. Disk figures are always GB and stay on
 * formatGb, but a five-minute clip is tens of megabytes, and "0.0 GB" is a
 * number that tells the reader nothing at all.
 */
export const formatBytes = (bytes: number) =>
  bytes < 1_000_000_000 ? `${Math.round(bytes / 1_000_000)} MB` : formatGb(bytes)

// The shipped recordDeleteAfter is 168h, so seven days of headroom is the scale
// at which "the disk fills before retention recycles it" starts to be true. It
// is a headroom warning and not a comparison against the real config: the API
// does not report retention, and parsing mediamtx.yml to find out would put a
// second reader of that file in a second process.
export const LOW_HEADROOM_DAYS = 7
