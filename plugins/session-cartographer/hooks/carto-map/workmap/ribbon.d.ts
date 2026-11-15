// Types for ribbon.js, a byte-identical copy of explorer/shared/workmap/ribbon.js.
import type { HubAction } from './hub'
export type RibbonCell = { station: string; family: string; kind: 'call' | 'person' | 'wake'; fault: boolean; running: boolean; beside: boolean; changes: boolean }
export function ribbonOf(actions: readonly HubAction[], at: number, n?: number, model?: 'place' | 'head'): RibbonCell[]
export function ribbonCapacity(width: number, height: number): number
export function drawRibbon(cells: readonly RibbonCell[], options?: { width?: number; height?: number; palette?: Record<string, string> }): string
export const SLOT_CALLS: number
export function drawSlotRibbon(runs: readonly { station: string; cells: readonly RibbonCell[] }[], options?: { width?: number; height?: number; slots?: number; held?: string; accent?: string; palette?: Record<string, string> }): string
