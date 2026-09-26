import { projectColor } from '../lib/palette.js';

// Outlined, never tinted: a 13% fill of its own hue put this badge at 4.6:1
// on the active search result. Ratios for every ground: lib/palette.js.
export default function ProjectBadge({ project, onClick }) {
  if (!project) return null;
  const color = projectColor(project);

  if (onClick) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClick(project);
        }}
        className="inline-block text-xs px-1.5 py-0.5 rounded font-mono hover:brightness-125 transition-all outline-none"
        style={{ color, border: `1px solid ${color}66`, cursor: 'pointer' }}
        title={`Filter by ${project}`}
      >
        {project}
      </button>
    );
  }

  return (
    <span
      className="inline-block text-xs px-1.5 py-0.5 rounded font-mono"
      style={{ color, border: `1px solid ${color}44` }}
    >
      {project}
    </span>
  );
}
