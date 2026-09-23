#!/usr/bin/env bash
# bench-grep-vs-turbo.sh — regenerate the README's "grep vs. cartographer" table.
#
# For each query, three backends over the same machine and corpus:
#   grep      rg -l -i -F over every Claude Code and Codex transcript; the
#             session count is the number of distinct transcript files.
#   portable  cartographer-search.sh --no-turbo (bash + awk, no resident index)
#   turbo     cartographer-search.sh --turbo (warm in-memory index)
# Cartographer session counts are distinct session ids in the top $LIMIT
# ranked results. Times are wall-clock seconds for one cold call each.
# --all disables delta serving; --purpose eval keeps runs out of recall stats.
#
# Usage: bash scripts/bench-grep-vs-turbo.sh [> out.tsv]
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIMIT="${BENCH_LIMIT:-50}"
TRANSCRIPTS=("$HOME/.claude/projects" "$HOME/.codex/sessions" "$HOME/.codex/archived_sessions")
QUERIES=("BM25" "facets" "transcript viewer" "backfill" "concurrent timeline"
         "diff shape" "session milestones" "fisheye autocomplete")

now() { perl -MTime::HiRes=time -e 'printf "%.3f\n", time'; }
elapsed() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", b - a }'; }

carto() {
  local mode="$1" query="$2" t0 t1 n
  t0=$(now)
  n=$(bash "$HERE/cartographer-search.sh" "$query" "$mode" --all --limit "$LIMIT" --purpose eval 2>/dev/null \
    | awk '/^  session: /{print $2}' | sort -u | wc -l | tr -d ' ')
  t1=$(now)
  printf '%s\t%s' "$n" "$(elapsed "$t0" "$t1")"
}

existing=()
for d in "${TRANSCRIPTS[@]}"; do [ -d "$d" ] && existing+=("$d"); done

printf 'query\tgrep_sessions\tgrep_s\tportable_sessions\tportable_s\tturbo_sessions\tturbo_s\n'
for q in "${QUERIES[@]}"; do
  t0=$(now)
  g=$(rg -l -i -F --glob '*.jsonl' -- "$q" "${existing[@]}" 2>/dev/null | wc -l | tr -d ' ')
  t1=$(now)
  printf '%s\t%s\t%s\t%s\t%s\n' "$q" "$g" "$(elapsed "$t0" "$t1")" \
    "$(carto --no-turbo "$q")" "$(carto --turbo "$q")"
done
