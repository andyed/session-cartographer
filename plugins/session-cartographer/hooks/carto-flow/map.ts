// What the map knows, by where it lives now. This file only hands it on, so that what read `./map` still does.
//   setup.ts     the stations and the person's options
//   palette.ts   the colors
//   classify.ts  which station an action belongs to and what to call it
//   draw.ts      the drawing
//   feed.ts      the rows under it
// Nothing here touches the engine.
export { STATIONS, setupFrom } from './setup'
export type { Setup } from './setup'
export { COLOR_NAMES } from './palette'
export { classify, clean, firstLine, formatMs, memoryIds, shortModel } from './classify'
export type { Classified } from './classify'
export { TRAIL_FADE_MS, TRAIL_HOLD_MS, drawMap, routeOf } from './draw'
export { describeNow, foldRows, nowParts, taskNotice, taskOf } from './feed'
export type { Row } from './feed'
