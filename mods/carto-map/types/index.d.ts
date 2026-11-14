export type StationId =
  | 'you' | 'model' | 'memory' | 'files' | 'shell'
  | 'web' | 'browser' | 'agents' | 'skills' | 'hooks'

export type Status = 'run' | 'ok' | 'err' | 'block'

/** One action on the map. Labels carry names and record numbers, never the text of a memory. */
export type Entry = {
  id: string
  station: StationId
  label: string
  /** Where the pulse starts: the core, the agents station, or the station itself (a signal coming in). */
  from: 'core' | 'agents' | 'inbound'
  startedAt: number
  endedAt?: number
  status: Status
  /** The subagent whose loop made the call; absent for the main loop. */
  agentId?: string
  /** The background task the call started; the row stays open until that task reports back. */
  task?: string
  /** A moment the map marks: the model changed, or the answer is ready. */
  mark?: 'switch' | 'done'
  /** The call read or acted in what the person has open (their own Chrome, tabs, terminal, desktop). Not in lot-map. */
  yours?: true
  /** Something other than the person woke the agent: a background task or another session reporting back. Not in lot-map. */
  wake?: 'task'
  /** Where the row leads: the page the call went to, or the Explorer's review of the file it changed. Not in lot-map. */
  href?: string
}

/** A page the session opened or fetched: its address and when. Never what the page said. */
export type Visit = {
  /** `screen`: a page in the person's own browser. Not in lot-map. */
  station: 'web' | 'browser' | 'screen'
  url: string
  at: number
}

export type Board = {
  entries: Entry[]
  counts: Partial<Record<StationId, number>>
  model?: string
  step?: number
  /** How many of the memory station's count a hook brought unasked. */
  pushed?: number
  /** Errors and refusals per station since the person's last message. */
  faults?: Partial<Record<StationId, number>>
  /** Subagents whose loops are still going. */
  agents?: string[]
  /** How full the context window is, 0 to 100. */
  context?: number
  /** When the model last changed. */
  switchedAt?: number
  /** The row of the feed the person opened to read whole: its entry's id. */
  open?: string
  /** The pages the session visited, oldest first. Not in lot-map. */
  visits?: Visit[]
  /** The station whose rows the pane shows in place of the whole feed. `screen` is the person's own running things. Not in lot-map. */
  shown?: StationId | 'screen'
  /** Of the You station's count, how many were the agent telling the person and not the person speaking. Not in lot-map. */
  told?: number
  /** Calls into what the person has open, by the station lot-map files them under. Not in lot-map. */
  yours?: Partial<Record<StationId, number>>
  /** Moves on when the drawing should cool with nothing new to draw. Not in lot-map. */
  tick?: number
}

declare module 'claude-code' {
  interface PluginState {
    'carto-map': { board: Shaped<Board> }
  }
}
