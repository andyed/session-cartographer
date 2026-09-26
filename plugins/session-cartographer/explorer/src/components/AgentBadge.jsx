/**
 * AgentBadge — which agent produced this session or event.
 *
 * Roughly half the corpus is Codex (54,826 of 110,752 changelog events at the
 * time of writing), and every Explorer view except the Memory Desk rendered it
 * as if it were one agent. The field has been on the wire the whole time:
 * /api/events passes raw events through, and 192 of 194 rows in a sample search
 * carried `provider`.
 *
 * Colours are checked against the 8:1 floor on every surface this badge
 * sits on. The badge is outlined, never tinted: with the old 13%-alpha fill,
 * all four entries measured 7.27–7.71:1 on the classic keyboard-active search
 * result.
 *
 *            page     card     expanded  active
 *            #0a0a0f  #0d1019  #030712   #151a23
 *   claude   10.91    10.52    11.12      9.68   #f0b48a
 *   codex    11.58    11.17    11.80     10.27   #8fd3c7
 *   hermes   11.27    10.87    11.49     10.00   #cdb9ff
 *   (other)  10.78    10.40    10.99      9.57   #b9c0cb
 *
 * card = a session card (bg-gray-900/40 over the page); expanded = the event
 * list inside an open session card (bg-gray-950); active = the keyboard-active
 * search result (bg-gray-800/50 over the page).
 *
 * Not the Memory Desk's selected row (#153640): the palette measures
 * 7.02–7.54:1 there even without a fill, so no badge goes on that surface. In a
 * selected desk row the agent appears as plain text, and Recall rows never take
 * the selected background. Badges and selected rows are measured from computed
 * styles in tests/browser/memory-entry.cjs, so a badge placed there fails it.
 *
 * Colour is never the only carrier — the badge always prints the agent's name,
 * so it reads the same for anyone who cannot separate the two hues.
 */

const AGENTS = {
  claude: { label: 'claude', color: '#f0b48a' },
  codex: { label: 'codex', color: '#8fd3c7' },
  hermes: { label: 'hermes', color: '#cdb9ff' },
};

const UNKNOWN_AGENT = { label: '', color: '#b9c0cb' };

/** Palette for facet pills, so the bar and the badges agree. */
export function agentColor(name) {
  return AGENTS[String(name || '').toLowerCase()]?.color || UNKNOWN_AGENT.color;
}

export default function AgentBadge({ provider, onClick, title }) {
  // No badge when the producer is genuinely unrecorded: a grey "unknown" chip
  // on every backfilled git commit would be noise, not information.
  if (!provider) return null;
  const key = String(provider).toLowerCase();
  const agent = AGENTS[key] || { ...UNKNOWN_AGENT, label: key };
  const tooltip = title || `Produced by ${agent.label}`;

  const style = {
    color: agent.color,
    border: `1px solid ${agent.color}44`,
  };

  if (onClick) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onClick(key); }}
        className="agent-badge inline-block text-xs px-1.5 py-0.5 rounded font-mono hover:brightness-110 transition-all outline-none"
        data-agent={key}
        style={{ ...style, cursor: 'pointer' }}
        title={`Filter by ${agent.label}`}
      >
        {agent.label}
      </button>
    );
  }

  return (
    <span className="agent-badge inline-block text-xs px-1.5 py-0.5 rounded font-mono" data-agent={key} style={style} title={tooltip}>
      {agent.label}
    </span>
  );
}
