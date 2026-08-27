import { CameraList } from '@/components/camera-list'

export default function LivePage() {
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Live</h1>
        <p className="text-muted-foreground text-sm">
          Sub-second WebRTC off the sub-stream, so watching never disturbs the recording. The status
          badge polls every 10 seconds.
        </p>
      </div>
      <CameraList />
    </section>
  )
}
