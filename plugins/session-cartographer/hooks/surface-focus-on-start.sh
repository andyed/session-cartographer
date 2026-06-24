#!/bin/bash
# SessionStart hook (TRIAL, opt-in): auto-surface /focus orientation on entering a project.
#
# Injects the co-occurrence graph's two orientation lenses as session context, so the
# cross-thread connections surface without a manual /focus:
#   --related   <project>  → other projects co-active with this one (research threads)
#   --maneuvers <project>  → recurring technical procedures this project runs
#
# DORMANT BY DEFAULT. Trial it:   export CARTOGRAPHER_FOCUS_ON_START=1   (then launch claude)
#   Stop:      unset CARTOGRAPHER_FOCUS_ON_START
#   Bake out:  remove this file + its SessionStart block in hooks.json
#   Bake in:   flip the gate below to default-on, add a CHANGELOG line, drop a combined
#              --orient mode into cooccurrence-graph.js to halve the two-call startup cost.
#
# Measurable: appends one line per fire to $DEV/focus-on-start-trial.jsonl (separate from the
# main event pipeline) — lets us measure how often startup orientation has something to say.
#
# Silent-fail by design: missing node/jq/graph/logs → exit 0, never block session startup.
# Env: CARTOGRAPHER_FOCUS_ON_START (gate), CARTOGRAPHER_DEV_DIR (overrides ~/Documents/dev)

# Gate first, before touching stdin — the dormant path costs ~a bash spawn for everyone else.
[ "${CARTOGRAPHER_FOCUS_ON_START:-0}" = "1" ] || exit 0

command -v node >/dev/null 2>&1 || exit 0
command -v jq   >/dev/null 2>&1 || exit 0

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // empty')
# Fire on any session start EXCEPT compaction (which already re-injects its own summary).
# Skip-one rather than whitelist: robust to whatever 'source' value a new session reports.
case "$SOURCE" in compact) exit 0 ;; esac

CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
[ -n "$CWD" ] || exit 0

DEV="${CARTOGRAPHER_DEV_DIR:-$HOME/Documents/dev}"

# Project name from the repo (basename of git toplevel, else cwd basename) — same as the
# milestones hook. The graph's resolveProject() tolerates partials/aliases from here.
GIT_REPO=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$GIT_REPO" ]; then PROJECT=$(basename "$GIT_REPO"); else PROJECT=$(basename "$CWD"); fi
[ -n "$PROJECT" ] || exit 0

# Abstain on home-dir / non-project buckets — launching from ~ resolves PROJECT to "andyed",
# which co-occurs with everything and yields a generic, repetitive banner (75% of trial fires).
# Early exit also skips the ~500ms graph build for these.
case "$PROJECT" in
  andyed|home|dev|Documents|Documents-dev|Users|Users-andyed|Downloads|Desktop|Library|tmp|workspace) exit 0 ;;
esac

# Locate the graph builder: repo-relative first (dev checkout), then the DEV install fallback.
GRAPH=""
for cand in \
  "$(dirname "$0")/../../../scripts/cooccurrence-graph.js" \
  "$DEV/session-cartographer/scripts/cooccurrence-graph.js"; do
  if [ -f "$cand" ]; then GRAPH="$cand"; break; fi
done
[ -n "$GRAPH" ] || exit 0

# Two lenses (~250ms each). The script prints a "(no ...)" sentinel when a lens is empty.
REL=$(node "$GRAPH" --related "$PROJECT" 2>/dev/null)
MAN=$(node "$GRAPH" --maneuvers "$PROJECT" 2>/dev/null)

# Compact related threads to one line of "name(Nd)", top 5. LC_ALL=C: headers carry unicode (·, —, G²).
REL_LINE=""
case "$REL" in
  "Related threads"*)
    REL_LINE=$(echo "$REL" | LC_ALL=C awk 'NR>1 && NF && c<5 { printf "%s%s(%s)", sep, $1, $2; sep=", "; c++ } END { print "" }')
    ;;
esac

# The maneuver header line is already compact: "Maneuvers in <project>: a, b, c".
MAN_LINE=""
case "$MAN" in
  "Maneuvers in"*) MAN_LINE=$(echo "$MAN" | head -1 | sed 's/^Maneuvers in [^:]*: //') ;;
esac

# Trial telemetry — one line per fire, including abstentions, so the no-signal rate is visible.
# 'shown' = we actually injected: fired AND not already surfaced for this project today (the same
# banner every launch is wallpaper). Tunable: delete the PRIOR/shown block to surface every launch.
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TODAY=$(date -u +"%Y-%m-%d")
TRIAL="$DEV/focus-on-start-trial.jsonl"
FIRED="false"; { [ -n "$REL_LINE" ] || [ -n "$MAN_LINE" ]; } && FIRED="true"
SHOWN="false"
if [ "$FIRED" = "true" ]; then
  PRIOR=$(LC_ALL=C grep "\"project\":\"$PROJECT\"" "$TRIAL" 2>/dev/null | LC_ALL=C grep '"shown":true' | LC_ALL=C grep "\"$TODAY" | tail -1)
  [ -z "$PRIOR" ] && SHOWN="true"
fi
jq -n -c --arg ts "$TS" --arg project "$PROJECT" --arg source "$SOURCE" \
   --arg rel "$REL_LINE" --arg man "$MAN_LINE" --argjson fired "$FIRED" --argjson shown "$SHOWN" \
   '{timestamp:$ts, project:$project, source:$source, related:$rel, maneuvers:$man, fired:$fired, shown:$shown}' \
   >> "$TRIAL" 2>/dev/null

# Inject only the first surfacing per project per day — silent on repeats and no-signal starts.
[ "$SHOWN" = "true" ] || exit 0

CTX="[carto auto-focus · ${PROJECT}]"
[ -n "$REL_LINE" ] && CTX="${CTX}
Related threads (co-active projects): ${REL_LINE}"
[ -n "$MAN_LINE" ] && CTX="${CTX}
Maneuvers it runs: ${MAN_LINE}"
CTX="${CTX}
→ Run /focus ${PROJECT} for full orientation (recent milestones, commits, research)."

# Inject as SessionStart context.
jq -n --arg ctx "$CTX" \
  '{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$ctx}}'

exit 0
