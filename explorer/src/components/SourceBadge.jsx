/**
 * Dual-color score indicator.
 * Left half = keyword (green), right half = semantic (blue).
 * Filled = present in that source, empty = not.
 */
export default function SourceBadge({ source }) {
  if (!source) return null;

  const hasKeyword = source.includes('keyword');
  const hasSemantic = source.includes('semantic');
  const isBrowse = source === 'browse';

  if (isBrowse) {
    return (
      <span className="inline-block text-xs px-1.5 py-0.5 rounded font-mono"
        style={{ backgroundColor: '#2a2a2a', color: '#888' }}>
        browse
      </span>
    );
  }

  const kwColor = hasKeyword ? '#98c379' : '#333';
  const semColor = hasSemantic ? '#61afef' : '#333';

  const title = hasKeyword && hasSemantic ? 'keyword + semantic'
    : hasKeyword ? 'keyword only'
    : hasSemantic ? 'semantic only'
    : source;

  return (
    <svg
      width="14" height="14"
      viewBox="0 0 14 14"
      className="inline-block"
      title={title}
    >
      <title>{title}</title>
      {/* Left half — keyword */}
      <path
        d="M7,1 A6,6 0 0,0 7,13 Z"
        fill={kwColor}
      />
      {/* Right half — semantic */}
      <path
        d="M7,1 A6,6 0 0,1 7,13 Z"
        fill={semColor}
      />
      {/* Border */}
      <circle cx="7" cy="7" r="6" fill="none" stroke="#555" strokeWidth="0.5" />
    </svg>
  );
}
