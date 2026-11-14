import { directoryLabel } from './path-presentation.js';
import '../styles/path-context.css';

/** Shared directory once per collection; exact text remains selectable. */
export default function PathContext({ root }) {
  if (!root) return null;
  return <details className="path-context"><summary aria-label="Shared directory" title={root}>{directoryLabel(root)}</summary><code data-copy-content>{root}</code></details>;
}
