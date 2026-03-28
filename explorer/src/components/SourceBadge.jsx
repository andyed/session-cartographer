/**
 * Source indicator — concentric rings showing keyword/semantic match.
 * Inner dot = keyword (green), outer ring = semantic (blue).
 * Saturation scales with relevance score.
 * Compact: 14x14, no text — all info in tooltip.
 */

function intensity(score) {
  if (!score || score <= 0) return 0;
  // RRF scores ~0.002-0.03 → map to 0-1 via log scale
  return Math.min(1, Math.max(0, (Math.log10(score) + 2.7) / 1.5));
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function scaleHex(hex, t) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Lerp from dark gray (#333) to full color
  return `rgb(${lerp(0x33, r, t)}, ${lerp(0x33, g, t)}, ${lerp(0x33, b, t)})`;
}

export default function SourceBadge({ source, score }) {
  if (!source) return null;

  const hasKeyword = source.includes('keyword');
  const hasSemantic = source.includes('semantic');
  const isBrowse = source === 'browse';

  if (isBrowse) return null;

  const t = intensity(score);

  const sourceLabel = hasKeyword && hasSemantic ? 'keyword + semantic'
    : hasKeyword ? 'keyword only'
    : hasSemantic ? 'semantic only'
    : source;
  const title = score != null
    ? `${sourceLabel} · score: ${score.toFixed(4)}`
    : sourceLabel;

  return (
    <svg
      width="14" height="14"
      viewBox="0 0 14 14"
      className="inline-block cursor-help flex-shrink-0"
    >
      <title>{title}</title>
      {/* Outer ring — semantic (blue) */}
      <circle
        cx="7" cy="7" r="6"
        fill="none"
        stroke={hasSemantic ? scaleHex('#61afef', t) : '#222'}
        strokeWidth={hasSemantic ? 2 : 0.5}
      />
      {/* Inner dot — keyword (green) */}
      <circle
        cx="7" cy="7" r="3"
        fill={hasKeyword ? scaleHex('#98c379', t) : '#222'}
      />
    </svg>
  );
}
