/**
 * True when a keystroke belongs to whatever the operator is typing into.
 *
 * Every global single-key binding needs this. Without it, `t` typed into the
 * sign-in email field flips the theme and `0` in the day picker resets the
 * zoom — the classic failure of app-wide letter shortcuts.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}
