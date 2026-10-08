#!/bin/bash
# tests/fixtures/hook-rows/run.sh — fire a fixed set of synthetic hook payloads
# at a hooks directory and print the rows they wrote, normalised.
#
#   bash tests/fixtures/hook-rows/run.sh <hooks-dir> [scripts-root]
#
# Everything a run cannot hold constant is masked: event ids, timestamps, the
# temp workspace path (plain and URL-encoded), commit shas. The rest of each
# row is printed byte for byte, in the order the hooks wrote it, so two hook
# versions that write the same events print the same text.
#
# The hooks resolve diff-shape.sh and index-event.sh through CARTOGRAPHER_ROOT.
# They get a root built here: the real diff-shape.sh (from <scripts-root>,
# default this checkout) and a no-op index-event.sh. Indexing is not what the
# rows measure, live-index-isolation.test.js covers the real indexer, and the
# real one is backgrounded — it outlives the hook, and a run's cleanup would
# race it over the temp dir.
#
# expected.txt was captured from the hooks as they stood before the single-jq
# rewrite (commit 2c7d469). tests/unit/hook-rows-golden.test.js runs this
# against the live hooks and diffs.
set -u
HOOKS=$(cd "$1" && pwd -P)
SCRIPTS=${2:-$(cd "$(dirname "$0")/../../.." && pwd -P)}

# The workspace must not sit under /tmp or /private/tmp: the hooks treat those
# as scratch and drop any write there (bash_filter_paths, keep_path), so a
# fixture built in /tmp loses its own heredoc, sed -i and tee rows. macOS puts
# TMPDIR under /var/folders and the rows appear; Linux defaults to /tmp and
# they vanish — CI run 37727203923 failed exactly that way on 2026-10-08.
BASE=""
for candidate in "${TMPDIR:-}" "${RUNNER_TEMP:-}" "$HOME/.cache"; do
  case "$candidate" in
    ''|/tmp|/tmp/*|/private/tmp|/private/tmp/*) continue ;;
    *) BASE="$candidate"; break ;;
  esac
done
mkdir -p "$BASE"
TOP=$(mktemp -d "$BASE/carto-rows.XXXXXX")
TOP=$(cd "$TOP" && pwd -P)
trap 'rm -rf "$TOP"' EXIT
WS="$TOP/space"            # fixed basename: it becomes a project name once
REPO="$WS/fixrepo"
DEV="$WS/dev"
HOMEDIR="$WS/home"
ROOT="$TOP/root"
mkdir -p "$REPO/src" "$DEV" "$HOMEDIR" "$ROOT/scripts"
cp "$SCRIPTS/scripts/diff-shape.sh" "$ROOT/scripts/diff-shape.sh"
printf '#!/bin/bash\nwhile IFS= read -r _; do :; done\nexit 0\n' > "$ROOT/scripts/index-event.sh"
chmod +x "$ROOT/scripts/index-event.sh"

# A hermetic environment: no live session id (delta serving), no live index,
# no user git config, one time zone.
unset CLAUDE_SESSION_ID CLAUDE_CODE_SESSION_ID CODEX_SESSION_ID CARTOGRAPHER_SESSION_ID
unset CARTOGRAPHER_PROVIDER
export HOME="$HOMEDIR" TZ=UTC
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export CARTOGRAPHER_LOG_TOOL_USE=true CARTOGRAPHER_DEV_DIR="$DEV" CARTOGRAPHER_ROOT="$ROOT"
export CARTOGRAPHER_QDRANT_URL=http://127.0.0.1:1 CARTOGRAPHER_EMBED_URL=http://127.0.0.1:1/v1/embeddings

git init -q -b main "$REPO"
printf 'seed\n' > "$REPO/README.md"
printf 'console.log(0)\n' > "$REPO/src/app.js"
# Backdated so the seed sits outside every reflog window the fixtures open.
git -C "$REPO" add -A
GIT_COMMITTER_DATE=2020-01-01T00:00:00Z GIT_AUTHOR_DATE=2020-01-01T00:00:00Z git -C "$REPO" commit -q -m "chore: seed"

CLAUDE_T="$HOMEDIR/.claude/projects/-space-fixrepo/sess-claude-1.jsonl"
CODEX_T="$HOMEDIR/.codex/sessions/2026/10/07/rollout-sess-codex-1.jsonl"
mkdir -p "$(dirname "$CLAUDE_T")" "$(dirname "$CODEX_T")"
# The transcript line a tool call was issued from carries the cwd before it.
jq -n -c --arg cwd "$REPO" '{type:"assistant", cwd:$cwd, message:{content:[{type:"tool_use", id:"toolu_fix_commit", name:"Bash"}]}}' > "$CLAUDE_T"
printf '{"type":"session_meta"}\n' > "$CODEX_T"

tool() {   # tool <json>  → PostToolUse payload to log-tool-use.sh
  (cd "$REPO" && printf '%s' "$1" | bash "$HOOKS/log-tool-use.sh")
}
ms() {     # ms <json>    → lifecycle payload to log-session-milestones.sh
  (cd "$REPO" && printf '%s' "$1" | bash "$HOOKS/log-session-milestones.sh")
}
bashp() {  # bashp <command> [stdout] [extra-jq-object]
  local extra="${3:-"{}"}"
  jq -n -c --arg cmd "$1" --arg out "${2-}" --arg t "$CLAUDE_T" --arg cwd "$REPO" --argjson extra "$extra" \
    '{hook_event_name:"PostToolUse", tool_name:"Bash", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd,
      tool_use_id:"toolu_fix_bash", tool_input:{command:$cmd}, tool_response:{stdout:$out, stderr:"", interrupted:false}} + $extra'
}

# ── log-tool-use.sh ──────────────────────────────────────────────────────────
tool "$(bashp 'npm test -- --grep "foo bar"' 'ok')"                                   # Ran:
tool "$(bashp "cd $REPO && ls -la")"                                                   # noise: no row
tool "$(bashp "cat > $REPO/src/app.js <<'EOF'
console.log(1)
EOF")"                                                                                 # Modified (via bash)
tool "$(bashp "cd $REPO && python3 - <<'PY'
p='src/notes.md'
open(p,'w').write('x')
PY")"                                                                                  # Modified (via bash), variable-bound
tool "$(bashp 'node -e '"'"'console.log("héllo wörld — ünïcode")'"'"'' 'héllo')"      # Ran: multibyte
long=$(printf 'printf %%s "%s" > /dev/null' "$(printf 'a%.0s' $(seq 1 600))")
tool "$(bashp "$long")"                                                                # Ran: truncated at 200 of 500
tool "$(jq -n -c --arg t "$CLAUDE_T" --arg cwd "$REPO" --arg f "$REPO/src/app.js" \
  '{hook_event_name:"PostToolUse", tool_name:"Edit", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd,
    tool_input:{file_path:$f, old_string:"0", new_string:"1"}}')"                     # Modified (Edit)
tool "$(jq -n -c --arg t "$CLAUDE_T" --arg cwd "$REPO" --arg f "$WS/outside.md" \
  '{hook_event_name:"PostToolUse", tool_name:"Write", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd,
    tool_input:{file_path:$f, content:"x"}}')"                                         # Modified, file outside any repo
tool "$(jq -n -c --arg t "$CLAUDE_T" --arg cwd "$REPO" \
  --arg p $'*** Begin Patch\n*** Add File: src/new.js\n+x\n*** Update File: README.md\n@@\n-seed\n+seed2\n*** End Patch' \
  '{hook_event_name:"PostToolUse", tool_name:"apply_patch", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd,
    tool_input:{patch:$p}}')"                                                          # Modified: a,b
tool "$(jq -n -c --arg t "$CLAUDE_T" --arg cwd "$REPO" \
  '{hook_event_name:"PostToolUse", tool_name:"Edit", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd,
    tool_input:{file_path:($cwd + "/node_modules/x/index.js")}}')"                    # noisy path: no row

# A real commit, reported the way Claude Code reports it: duration_ms set, the
# call's tool_use_id in the transcript, quiet git so stdout names no sha.
printf 'console.log(2)\n' > "$REPO/src/app.js"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "feat(app): log two"
tool "$(bashp "git -C $REPO add -A && git -C $REPO commit -q -m 'feat(app): log two'" '' \
  '{"duration_ms": 30000, "tool_use_id": "toolu_fix_commit"}')"                       # git_commit via reflog
# The same commit again: the reflog says nothing new was made, so no row.
tool "$(bashp "git -C $REPO commit -q -m 'feat(app): log two'" '' \
  '{"duration_ms": 1000, "tool_use_id": "toolu_fix_commit"}')"
# A commit reported the Codex way: no duration_ms, git's summary line on stdout.
printf 'console.log(3)\n' > "$REPO/src/app.js"
git -C "$REPO" add -A
out=$(git -C "$REPO" commit -m "fix: three")
tool "$(bashp "git -C $REPO commit -m 'fix: three'" "$out")"                           # git_commit via stdout + HEAD
# `git commit` that made nothing (HEAD already logged): Ran:
tool "$(bashp "git -C $REPO commit -m 'nothing here'" 'nothing to commit, working tree clean')"
tool "$(bashp "git -C $REPO push origin main" 'fatal: no remote')"                    # Pushed:
tool "$(bashp 'npm test' 'boom' '{"hook_event_name":"PostToolUseFailure"}')"           # failed call: no row
tool "$(jq -n -c --arg t "$CLAUDE_T" --arg cwd "$REPO" \
  '{hook_event_name:"PostToolUse", tool_name:"Read", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd,
    tool_input:{file_path:"x"}}')"                                                     # other tool: no row

# ── the edges the byte cuts and the text analysis sit on ─────────────────────
# 500- and 200-byte cuts that land inside a multibyte character: the partial
# bytes stay, as `head -c` left them, and jq writes them as U+FFFD.
tool "$(bashp "node -e 'console.log( \"$(printf 'é%.0s' $(seq 1 400))\")'" 'ok')"
# A commit past the 20000-byte cut of the heredoc-stripped form is invisible.
tool "$(bashp "node -e '$(printf 'x%.0s' $(seq 1 20100))' && git -C $REPO commit -m 'never seen'" 'ok')"
# A `cd` hop ahead of the commit, the message in a heredoc body with a dash
# and both quote kinds: the reflog subject must match the raw command text.
printf 'console.log(4)\n' > "$REPO/src/app.js"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "fix(core): tidy — \"quoted\" 'single'"
tool "$(bashp "cd $REPO && git add -A && git commit -q -F - <<'MSG'
fix(core): tidy — \"quoted\" 'single'
MSG" '' '{"duration_ms": 30000, "tool_use_id": "toolu_fix_commit"}')"
# A pipe hides the commit from the per-segment noise verdict; HEAD is fresh
# and unlogged, so the commit is read from it (no duration_ms: Codex shape).
printf 'docs: note\n' > "$REPO/msg.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -q -F "$REPO/msg.txt"
tool "$(bashp "cat $REPO/msg.txt | git -C $REPO commit -q -F -")"
# A repo git cannot read from the text (`-C "$W"`): the cwd's repo stands in
# and an entry counts only on a subject match.
printf 'console.log(5)\n' > "$REPO/src/app.js"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "chore: via var"
tool "$(bashp "W=$REPO; git -C \"\$W\" commit -q -m \"chore: via var\"" '' '{"duration_ms": 30000, "tool_use_id": "toolu_fix_commit"}')"
# A failed call still logs what it committed.
printf 'console.log(6)\n' > "$REPO/src/app.js"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "feat: before the failure"
tool "$(bashp "git -C $REPO commit -q -m 'feat: before the failure' && false" '' \
  '{"duration_ms": 30000, "tool_use_id": "toolu_fix_commit", "hook_event_name": "PostToolUseFailure"}')"
tool "$(bashp "sed -i '' 's/5/7/' $REPO/src/app.js")"                                  # Modified (via bash): sed -i
tool "$(bashp "tee -a $REPO/notes.log <<<'x'")"                                        # Modified (via bash): tee
tool "$(bashp "cd $REPO && python3 - <<'PY'
# $(printf 'c%.0s' $(seq 1 520))
open('src/gen.py','w').write('x')
PY")"                                                                                  # open() past the 500-byte cut
tool "$(bashp 'ls \
  -la')"                                                                               # continued noise: no row
tool "$(bashp "echo \"x\" ; git -C $REPO status")"                                     # one non-noise segment: Ran:
tool "$(bashp "# git commit -m x
npm run build")"                                                                       # a comment is not a commit
tool "$(jq -n -c --arg t "$CODEX_T" --arg cwd "$REPO" \
  '{hook_event_name:"PostToolUse", tool_name:"Bash", session_id:"sess-codex-1", transcript_path:$t, cwd:$cwd,
    turn_id:"t1", model:"gpt", tool_input:{command:"cargo build"}, tool_response:"ok"}')"   # Codex row

# ── log-session-milestones.sh ────────────────────────────────────────────────
ms "$(jq -n -c --arg t "$CLAUDE_T" --arg cwd "$REPO" \
  '{hook_event_name:"Stop", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd, stop_hook_active:false}')"   # Claude Stop: nothing
ms "$(jq -n -c --arg t "$CODEX_T" --arg cwd "$REPO" \
  '{hook_event_name:"Stop", session_id:"sess-codex-1", transcript_path:$t, cwd:$cwd, turn_id:"t1", model:"gpt"}')"   # Codex turn_stop
ms "$(jq -n -c --arg t "$CLAUDE_T" --arg cwd "$REPO" \
  '{hook_event_name:"PreCompact", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd, trigger:"auto"}')"
ms "$(jq -n -c --arg t "$CLAUDE_T" --arg cwd "$REPO" \
  '{hook_event_name:"SubagentStop", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd, agent_type:"Explore"}')"
ms "$(jq -n -c --arg t "$CLAUDE_T" --arg cwd "$REPO" \
  '{hook_event_name:"SubagentStop", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd, agent_type:"Bash"}')"  # skipped
# A dirty tree and a detached HEAD: the counts and the branchless summary.
printf 'dirty\n' >> "$REPO/README.md"; printf 'new\n' > "$REPO/untracked.txt"
git -C "$REPO" checkout -q --detach
ms "$(jq -n -c --arg t "$CLAUDE_T" --arg cwd "$REPO" \
  '{hook_event_name:"PreCompact", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd, trigger:"manual"}')"
git -C "$REPO" checkout -q main
ms "$(jq -n -c --arg t "$CLAUDE_T" --arg cwd "$REPO" \
  '{hook_event_name:"SubagentStop", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd, agent_type:"Plan"}')"
ms "$(jq -n -c --arg t "$CLAUDE_T" --arg cwd "$REPO" \
  '{hook_event_name:"SessionEnd", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd, reason:"prompt_input_exit"}')"   # verified + deeplink
ms "$(jq -n -c --arg t "$HOMEDIR/.claude/projects/-space-fixrepo/missing.jsonl" --arg cwd "$WS" \
  '{hook_event_name:"SessionEnd", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd, reason:"other"}')"   # kept: has events; no repo
ms "$(jq -n -c --arg t "$HOMEDIR/.claude/projects/-space-fixrepo/missing.jsonl" --arg cwd "$REPO" \
  '{hook_event_name:"SessionEnd", session_id:"sess-empty", transcript_path:$t, cwd:$cwd, reason:"other"}')"     # dropped
ms "$(jq -n -c --arg t "$CLAUDE_T" --arg cwd "$REPO" \
  '{hook_event_name:"UserPromptSubmit", session_id:"sess-claude-1", transcript_path:$t, cwd:$cwd}')"            # other event: nothing

# ── normalise and print ──────────────────────────────────────────────────────
WS_ENC=$(printf '%s' "$WS" | jq -Rr '@uri')
for log in tool-use-log.jsonl changelog.jsonl session-milestones.jsonl; do
  printf '== %s\n' "$log"
  [ -f "$DEV/$log" ] || continue
  LC_ALL=C sed -E \
    -e 's/"event_id":"evt-[a-z0-9]{12}"/"event_id":"<EID>"/g' \
    -e 's/"parent_event_id":"evt-[a-z0-9]{12}"/"parent_event_id":"<EID>"/g' \
    -e 's/"timestamp":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"/"timestamp":"<TS>"/g' \
    -e "s|$WS|<WS>|g" -e "s|$WS_ENC|<WS_ENC>|g" \
    -e 's/Commit [0-9a-f]{40}/Commit <SHA>/g' \
    -e 's/(recent_commits":"|\|)[0-9a-f]{7} /\1<SHA7> /g' \
    "$DEV/$log"
done
