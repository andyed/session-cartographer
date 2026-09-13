/**
 * One definition of "which file did this edit event touch."
 *
 * The edit hook writes a file edit as a single summary line, in two shapes:
 *
 *   Modified: /abs/path/app.js                          ← Edit / Write
 *   Modified: src/a.js,src/b.js (via bash)              ← a write-shaped Bash call
 *
 * The second shape exists because auto mode edits through Bash, so `sed -i`,
 * `cat > f <<EOF` and `open(p,'w')` are real work rather than noise — see
 * bash_written_paths() in hooks/log-tool-use.sh. Two consumers had diverged on
 * reading it back: the Explorer's memory fold stripped the marker and split the
 * list, while session-digest matched a bare /^Modified:\s*(.+)$/ and keyed its
 * hottest-files panel on the whole tail. That put `docs/HANDOFF.md (via bash)`
 * and `docs/HANDOFF.md,docs/PRODUCT.md (via bash)` in the panel as two distinct
 * "files," neither of which aggregated with the same file edited via Edit.
 *
 * PARSING is shared here. RESOLUTION deliberately is not: the hook's path
 * detector reads shell source text and is loose by construction (58% of the
 * candidates it has emitted to date are JS property access — `errors.push`,
 * `console.log`), so every caller needs a resolver, but not the same one. The
 * Explorer serves file contents over HTTP and so must confine itself to the
 * indexed corpus; the digest only names files and would otherwise drop real
 * edits to ~/.claude memory files. Pass the resolver that matches the risk.
 */

const EDIT_SUMMARY = /^(?:Modified|Created|Wrote):\s*(.+)$/i;
const VIA_BASH = /\s+\(via bash\)\s*$/;

/** The path list carried by an edit summary, with the bash marker removed. */
export function editSummaryValue(summary) {
  const match = String(summary ?? '').match(EDIT_SUMMARY);
  return match ? match[1].replace(VIA_BASH, '').trim() : '';
}

/**
 * Split the hook's comma-separated multi-file form.
 *
 * A real filename may contain a comma, so when a resolver is supplied the whole
 * value gets first refusal: only a value that is not itself a file is read as a
 * list. Without a resolver there is no way to tell, and the list wins.
 */
export function splitEditPaths(value, resolve) {
  if (!value) return [];
  if (typeof resolve === 'function' && resolve(value)) return [value];
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

/** Candidate paths named by an edit summary. Unresolved — the caller filters. */
export function editSummaryPaths(summary, resolve) {
  return splitEditPaths(editSummaryValue(summary), resolve);
}
