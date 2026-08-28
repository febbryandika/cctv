import { SignOutButton } from '@/components/sign-out-button'
import { CAMERA_TZ } from '@/lib/camera-time'
import { LOW_HEADROOM_DAYS } from '@/lib/format'
import {
  LAST_MEASURE_OUTPUT,
  LAST_MEASURE_RUN,
  RECORD_FORMAT,
  RETENTION_HOURS,
  RTSP_SHAPE,
  SEGMENT_DURATION,
  STREAMS,
} from '@/lib/config'

// Read-only, and a server component because there is nothing here to interact
// with. Everything on this screen is either a constant from lib/config.ts or a
// piece of prose explaining a decision — no queries, no state, no writes.
//
// Deliberately NOT here: buttons to change retention, alert toggles, and
// "run doctor" / "run measure". Retention lives in mediamtx.yml, which is
// GENERATED from .env and gitignored, so changing it from a browser means
// writing config and restarting the media server. doctor and measure need a
// real camera and real elapsed time, which is why they are CLI scripts that
// stay out of CI (docs/ARCHITECTURE.md#measurement). A control that pretends
// otherwise is the same class of lie as a timeline that hides its gaps.
export default function SettingsPage() {
  return (
    <div className="grid max-w-[1560px] gap-4 px-7 pt-5 pb-8 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Section
          title="Camera & streams"
          blurb={
            <>
              The RTSP path is <Mono>{RTSP_SHAPE}</Mono>, so the URL <em>is</em> a password hash. It
              is never sent to the browser, never committed, and masked wherever it is printed —
              this page shows the shape only.
            </>
          }
        >
          {STREAMS.map((stream) => (
            <Row
              key={stream.channel}
              label={`${stream.title} · ${stream.role}`}
              detail={stream.detail}
              value={<Mono>{stream.channel}</Mono>}
              badge={stream.badge}
            />
          ))}
          <Row
            label="Camera timezone"
            detail="Every wall-clock string in the app is rendered in this zone, once, at the boundary."
            value={<Mono>{CAMERA_TZ}</Mono>}
          />
        </Section>

        <Section
          title="Retention & disk policy"
          blurb="Segments are ten minutes rather than the one-hour default: MediaMTX's reported durations can disagree with what is on disk, and a shorter segment bounds that error to ten minutes."
        >
          <Row
            label="Delete after"
            detail="recordDeleteAfter — MediaMTX deletes oldest-first, so exactly one day is half-erased at any moment."
            value={`${RETENTION_HOURS} h`}
          />
          <Row label="Segment duration" detail="recordSegmentDuration" value={SEGMENT_DURATION} />
          <Row
            label="Record format"
            detail="recordFormat / recordPartDuration"
            value={RECORD_FORMAT}
          />
          <Row
            label="Low-headroom warning"
            detail="Health warns below this many projected days. Projected from bytes actually written, never from the retention setting."
            value={`${LOW_HEADROOM_DAYS} days`}
          />
        </Section>

        <Section
          title="Recording schedule"
          blurb="Continuous is the only honest default. A schedule is a gap you agreed to in advance, and the timeline would have to label it as one."
        >
          <Row label="Schedule" detail="No scheduled windows." value="Continuous · 24/7" />
        </Section>
      </div>

      <div className="flex flex-col gap-4">
        <Section
          title="Diagnostics"
          blurb={
            <>
              <Mono>bun run doctor</Mono> and <Mono>bun run measure</Mono> need a real camera and
              real elapsed time, so they stay manual and out of CI — and cannot be triggered from
              here. The block below is the last run committed to the README, not a live reading.
            </>
          }
        >
          <div className="px-4 py-3.5">
            <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.07em] uppercase">
              Recorded run — {LAST_MEASURE_RUN}
            </p>
            <pre className="bg-muted text-secondary-foreground mt-2.5 overflow-x-auto rounded-md p-3.5 font-mono text-[11.5px] leading-relaxed">
              {LAST_MEASURE_OUTPUT}
            </pre>
            <p className="text-muted-foreground mt-2.5 text-[12.5px] leading-relaxed">
              65.35% is a bad number and it is the real one — a development laptop that slept.
              Publishing a figure from a cherry-picked window would defeat the only purpose the
              figure has.
            </p>
          </div>
        </Section>

        <Section
          title="Operator account"
          blurb="Sign-up is disabled. There is one operator account and the seed script is the only thing that can create it."
        >
          <div className="flex items-center gap-3 px-4 py-3.5">
            <span
              aria-hidden
              className="bg-muted text-secondary-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold"
            >
              OP
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">Signed in</div>
              <div className="text-muted-foreground text-[11.5px]">
                Session cookie, this browser only.
              </div>
            </div>
            <SignOutButton />
          </div>
        </Section>
      </div>
    </div>
  )
}

function Section({
  title,
  blurb,
  children,
}: {
  title: string
  blurb: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="bg-card overflow-hidden rounded-xl border">
      <div className="border-b px-4 py-3.5">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <p className="text-muted-foreground mt-1.5 text-[12.5px] leading-relaxed">{blurb}</p>
      </div>
      {children}
    </section>
  )
}

function Row({
  label,
  detail,
  value,
  badge,
}: {
  label: string
  detail: string
  value: React.ReactNode
  badge?: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="text-muted-foreground mt-0.5 text-[11.5px] leading-relaxed">{detail}</div>
      </div>
      <div className="text-[13px] tabular-nums">{value}</div>
      {badge ? (
        <span className="text-muted-foreground rounded-full border px-2 py-0.5 text-[11px]">
          {badge}
        </span>
      ) : null}
    </div>
  )
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="text-secondary-foreground font-mono text-xs">{children}</span>
}
