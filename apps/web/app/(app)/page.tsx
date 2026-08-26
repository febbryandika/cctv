import { CameraList } from '@/components/camera-list'

export default function LivePage() {
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Live</h1>
        <p className="text-muted-foreground text-sm">
          Status polls every 10 seconds. TODO(SPEC 4.2): WHEP player against the sub-stream.
        </p>
      </div>
      <CameraList />
    </section>
  )
}
