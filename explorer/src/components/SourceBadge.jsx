const BADGE_STYLES = {
  keyword: { bg: '#2a4a2a', color: '#98c379', label: 'keyword' },
  semantic: { bg: '#2a3a4a', color: '#61afef', label: 'semantic' },
  'keyword+semantic': { bg: '#3a2a4a', color: '#c678dd', label: 'keyword+semantic' },
};

export default function SourceBadge({ source }) {
  if (!source) return null;
  const style = BADGE_STYLES[source] || { bg: '#2a2a2a', color: '#888', label: source };
  return (
    <span
      className="inline-block text-xs px-1.5 py-0.5 rounded font-mono"
      style={{ backgroundColor: style.bg, color: style.color }}
    >
      {style.label}
    </span>
  );
}
