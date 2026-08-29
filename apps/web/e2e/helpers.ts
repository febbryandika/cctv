import { expect, type Locator } from '@playwright/test'

// Clicks the centre of an element, which for a timeline span is a wall-clock
// instant halfway through it.
//
// The timeline bar is a row of absolutely positioned divs whose left/width are
// percentages of the visible window, and the click handler turns a clientX
// fraction back into an instant. Clicking the centre is therefore the only
// position that resolves inside the span at every zoom level, because boxes are
// clipped to the view rather than allowed to overflow it.
export const clickCentre = async (element: Locator) => {
  const box = await element.boundingBox()
  expect(box, 'element has no box to click').not.toBeNull()

  await element.page().mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
}
