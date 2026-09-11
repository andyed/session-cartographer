/**
 * AgentBadge — which agent produced this session or event.
 *
 * Roughly half the corpus is Codex (54,826 of 110,752 changelog events at the
 * time of writing), and every Explorer view except the Memory Desk rendered it
 * as if it were one agent. The field has been on the wire the whole time:
 * /api/events passes raw events through, and 192 of 194 rows in a sample search
 * carried `provider`.
 *
 * Colours are checked against the 8:1 floor on both surfaces this badge sits
 * on — the page ground (#0a0a0f) and a session card (bg-gray-900/40 over it,
 * compositing to #0d1019) — including the badge's own 13%-alpha fill:
 *
 *   claude  #f0b48a   8.71:1 on page,  8.22:1 on card
 *   codex   #8fd3c7   9.16:1 on page,  8.61:1 on card
 *   (other) #b9c0cb   8.66:1 on page,  8.13:1 on card
 *
 * Colour is never the only carrier — the badge always prints the agent's name,
 * so it reads the same for anyone who cannot separate the two hues.
 */

const AGENTS = {
  claude: { label: 'claude', color: '#f0b48a' },
  codex: { label: 'codex', color: '#8fd3c7' },
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
    backgroundColor: `${agent.color}22`,
    color: agent.color,
    border: `1px solid ${agent.color}44`,
  };

  if (onClick) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onClick(key); }}
        className="inline-block text-xs px-1.5 py-0.5 rounded font-mono hover:brightness-110 transition-all outline-none"
        style={{ ...style, cursor: 'pointer' }}
        title={`Filter by ${agent.label}`}
      >
        {agent.label}
      </button>
    );
  }

  return (
    <span className="inline-block text-xs px-1.5 py-0.5 rounded font-mono" style={style} title={tooltip}>
      {agent.label}
    </span>
  );
}
