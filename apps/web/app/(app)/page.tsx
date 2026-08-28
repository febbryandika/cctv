import { CameraList } from '@/components/camera-list'

// The title and blurb moved into components/app-header.tsx when the rail
// arrived: every screen has the same header shape, and three pages each
// rendering their own h1 meant three places to keep it consistent.
export default function LivePage() {
  return <CameraList />
}
