const COLORS = [
  '#e06c75', '#c678dd', '#e5c07b', '#56b6c2', '#61afef',
  '#d19a66', '#98c379', '#ff6b9d', '#c3a6ff', '#5c6370',
];

function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

export default function ProjectBadge({ project, onClick }) {
  if (!project) return null;
  const color = hashColor(project);

  if (onClick) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClick(project);
        }}
        className="inline-block text-xs px-1.5 py-0.5 rounded font-mono hover:brightness-125 transition-all outline-none"
        style={{ backgroundColor: color + '22', color, border: `1px solid ${color}66`, cursor: 'pointer' }}
        title={`Filter by ${project}`}
      >
        {project}
      </button>
    );
  }

  return (
    <span
      className="inline-block text-xs px-1.5 py-0.5 rounded font-mono"
      style={{ backgroundColor: color + '22', color, border: `1px solid ${color}44` }}
    >
      {project}
    </span>
  );
}
