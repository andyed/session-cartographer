// Types for palette.js, a byte-identical copy of explorer/shared/workmap/palette.js.
export const DARK: Record<string, string>
export const LIGHT: Record<string, string>
export const COLOR_NAMES: Record<string, string>
export function lightRules(own?: Record<string, string>): string
/** One picture from the drawing in each palette: the dark one shown, the light one where the surface is light. */
export function bothThemes(dark: string, light: string): string
