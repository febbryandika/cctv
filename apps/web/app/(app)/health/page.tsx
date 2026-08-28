import { HealthPanel } from '@/components/health-panel'

export default function HealthPage() {
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Health</h1>
        <p className="text-muted-foreground text-sm">
          Camera status, disk headroom and the coverage record. Status changes arrive over a live
          stream; the rest refreshes every 30 seconds.
        </p>
      </div>
      <HealthPanel />
    </section>
  )
}
