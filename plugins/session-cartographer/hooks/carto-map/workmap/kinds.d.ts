// Types for kinds.js, a byte-identical copy of explorer/shared/workmap/kinds.js.
export const KIND: Record<string, string>
export const FAULT: string
export function familyOfStation(station: string): string
export function isScreen(action: { tool?: string; agentId?: string }): boolean
export function starterOf(text: string): 'person' | 'task' | 'harness'
export function wakeLabel(text: string): string
