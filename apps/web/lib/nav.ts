import { ActivityIcon, FilmIcon, SlidersHorizontalIcon, VideoIcon } from 'lucide-react'
import type { ComponentType } from 'react'

export type NavItem = {
  href: '/' | '/recordings' | '/health' | '/settings'
  label: string
  icon: ComponentType<{ className?: string }>
}

// One list, two renderings: the rail on md and up, a compact icon row in the
// header below it. Keeping them in step by hand is exactly the kind of thing
// that ends with a screen you can only reach on a laptop.
export const NAV: NavItem[] = [
  { href: '/', label: 'Live', icon: VideoIcon },
  { href: '/recordings', label: 'Recordings', icon: FilmIcon },
  { href: '/health', label: 'Health', icon: ActivityIcon },
  { href: '/settings', label: 'Settings', icon: SlidersHorizontalIcon },
]

/** `/` matches only itself; everything else matches its subtree. */
export const isActive = (pathname: string, href: NavItem['href']) =>
  href === '/' ? pathname === '/' : pathname.startsWith(href)
