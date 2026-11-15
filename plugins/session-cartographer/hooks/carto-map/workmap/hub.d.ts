// Types for hub.js, which is a byte-identical copy of explorer/shared/workmap/hub.js (scripts/sync-carto-map-workmap.sh).
export type HubAction = {
  station: string
  from: string
  startedAt: number
  endedAt?: number
  status: string
  agentId?: string
  aside?: boolean
  wake?: string
  label?: string
}
export type HubLeg = { from: string; to: string; kind: string; by?: string; n: number; age: number; strength: number; f?: number }
export type HubState = {
  at: number
  stations: Record<string, { count: number; told?: number; level: number; running: number; faults: number }>
  legs: HubLeg[]
  made: number
  context?: number
  model?: string
}
export type HubLayout = { kind: 'hub'; width: number; height: number; tells: 'lane' | 'station'; order: string[]; core: { x: number; y: number; r: number }; stations: Record<string, { x: number; y: number; r: number; i: number }> }
export const HUB_ORDER: string[]
export const HUB_ORDER_TWO_WAY: string[]
export function hubLayout(options?: { tells?: 'lane' | 'station' }): HubLayout
export function hubLevel(size: number): 1 | 2 | 3
export function hubState(
  actions: readonly HubAction[],
  at: number,
  options?: { tau?: number; hold?: number; travel?: number; keep?: number; context?: number; tells?: 'lane' | 'station'; totals?: Record<string, number> },
): HubState
export function drawHub(
  state: HubState,
  options?: { layout?: HubLayout; size?: number; names?: Record<string, string>; coreName?: string; model?: string; present?: Set<string>; motion?: 'full' | 'reduced'; pressed?: string; accent?: string; palette?: Record<string, string> },
): string
