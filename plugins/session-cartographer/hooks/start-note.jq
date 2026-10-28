# start-note.jq — render the SessionStart note and its trial-log row.
#
# Run by surface-focus-on-start.sh as `jq -n -R -r -f start-note.jq`, with the
# standup roster JSON on stdin (read raw, so a missing or broken roster is null,
# never a parse error) and everything else as --arg strings:
#   project sid source provider   identity of this start
#   wraps      newest wrapup candidate rows for the project, one JSON object a line
#   prior      the last trial row that was shown for this project, or ""
#   status     `git status --porcelain=v2 --branch`, or "" outside a repo
#   localonly  commits on no remote when the branch has no upstream, or ""
#   window     peer window label, e.g. "2h"
#   budget     note size cap in characters
#
# Prints two lines: the trial row, then the hook output (empty when silent).
# jq 1.5 compatible: no IN, no $__loc__, no --rawfile.

def flat: gsub("[\\r\\n\\t]+"; " ") | gsub("^\\s+|\\s+$"; "");

# Cut to n characters on a word boundary. The full text is one --get away.
def clip($n):
  if length <= $n then .
  else (.[0:$n - 1] | sub("\\s+\\S*$"; "")) + "…" end;

# The first match of a regex, or null. A bare capture() yields nothing at all on
# a miss, and binding nothing with `as` silently ends the whole program.
def match1($re): [try capture($re)] | .[0];

# Seconds since the epoch for the timestamp shapes the milestone log holds:
# Z, fractional seconds, and +00:00-style offsets (6 wrapups carry those).
def epoch:
  match1("^(?<d>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\\.[0-9]+)?(?<z>Z|[+-][0-9]{2}:?[0-9]{2})?$") as $m
  | if $m == null then null
    else (try (($m.d + "Z") | fromdateiso8601) catch null) as $e
      | if $e == null then null
        elif ($m.z // "Z") == "Z" then $e
        else ($m.z | sub(":"; "")) as $z
          | (($z[1:3] | tonumber) * 3600 + ($z[3:5] | tonumber) * 60) as $off
          | if $z[0:1] == "+" then $e - $off else $e + $off end
        end
    end;

def ago:
  if . == null then "?"
  elif . < 3600 then "\((. / 60) | floor)m"
  elif . < 172800 then "\((. / 3600) | floor)h"
  else "\((. / 86400) | floor)d" end;

# A wrapup's open threads. unresolved[] is the structured field the wrapup skill
# has written since 2026-08-20 (every wrapup since carries it). Older wrapups
# only marked unfinished work in prose, as "Unfinished:" (97 of them), "Open:"
# (33) or "Open threads:" (7): take that clause to its sentence end and split it
# on semicolons. No marker, no threads — prose without one is not guessed at.
def threads:
  [(.unresolved // [])[]? | select(type == "string") | flat | select(length > 0)] as $u
  | if ($u | length) > 0 then {source: "unresolved", items: $u}
    else ((.description // "") | if type == "string" then flat else "" end) as $d
      | ($d | match1("(?:^|[\\s(*])(?:Open threads|Open|Unfinished):\\s*(?<c>.+)$")) as $m
      | if $m == null then {source: "none", items: []}
        else (($m.c | match1("^(?<s>.+?)\\.(?:\\s+(?=[A-Z])|\\s*$)") | .s) // $m.c) as $clause
          | {source: "marker", items: [$clause | split(";")[] | flat | select(length > 0)]}
        end
    end;

# A peer's file by name, when it is in this project's checkout. Roster paths are
# worktree-collapsed onto the main checkout, so the project directory is in them;
# a scratchpad or memory file elsewhere says nothing about where not to edit.
def inproject($p): select(contains("/" + $p + "/")) | split("/") | last;

def unset: . == null or . == "" or . == "none" or . == "unknown";

(now) as $now
| ($budget | tonumber) as $cap
| ($wraps | split("\n") | map(select(length > 0) | (try fromjson catch null)
    | select(type == "object" and .milestone == "session_wrapup" and .project == $project
             and ((.event_id // "") | type == "string" and length > 0)))
  | sort_by((.timestamp // "") | epoch // 0) | last) as $w
| ($w.event_id // "") as $wid
| (if $w then ($w | threads) else {source: "none", items: []} end) as $t
| (if $w then (($w.timestamp // "") | epoch) else null end) as $wepoch
| (if $wepoch then $now - $wepoch else null end) as $wage

# Repo state. The total is /wrapup's "leaving" count (every porcelain entry, one
# path each); the tracked share is split out because it is the part another
# session may be in the middle of. psychodeli-webgl-port reads 424 uncommitted,
# nearly all untracked output.
| ($status | split("\n")) as $sl
| (first($sl[] | select(startswith("# branch.head ")) | .[14:]) // null) as $branch
| (first($sl[] | select(startswith("# branch.ab ")) | split(" ")[2] | ltrimstr("+") | tonumber?) // null) as $ahead
| ([$sl[] | select(length > 0 and (startswith("#") | not))] | length) as $dirty
| ([$sl[] | select(startswith("? "))] | length) as $untracked
| ($localonly | tonumber? // null) as $local

# Peers: every session the roster saw in the window except this one.
| ([inputs] | join("\n") | try fromjson catch null) as $roster
| (if ($roster | type) == "object"
   then [($roster.sessions // [])[] | select((.is_self | not) and .id != $sid)]
   else null end) as $peers
| (($peers // []) | length) as $npeers

# Gate: a wrapup this project has not been shown yet, or someone else working here.
| (($prior | try fromjson catch null) // {}) as $pr
| ($wid != "" and $wid != ($pr.wrapup_id // "")) as $new_wrapup
| ($new_wrapup or $npeers > 0) as $show

| "[carto start note · \($project)]" as $head
| (if $w then
     "Last /wrapup here (\($wid)): \(($w.timestamp // "")[0:10]), \($wage | ago) ago"
     + (if ($w.git_branch | unset) then "" else ", branch \($w.git_branch)" end) + "."
   else "No /wrapup recorded for this project." end) as $wline
| (if $status == "" then null
   else "Repo: branch \($branch // "?"), "
     + (if $dirty == 0 then "clean" else "uncommitted \($dirty - $untracked) tracked + \($untracked) untracked" end)
     + (if $ahead != null then ", \($ahead) unpushed"
        elif $local != null then ", no upstream (\($local) commit\(if $local == 1 then "" else "s" end) on no remote)"
        else "" end) + "."
   end) as $repo
# $f: how many of each peer's files to name (2, 1 or 0).
| def peerline($f):
    if $npeers == 0 then null
    else "Also active here in the last \($window): "
      + ([$peers[0:3][] | "\((.id // "")[0:8]) \(.provider // "?") \(((.idle_ms // 0) / 1000) | ago) ago"
           + ((reduce ((.recent_files // [])[] | inproject($project)) as $x
                 ([]; if any(.[]; . == $x) then . else . + [$x] end) | .[0:$f]) as $names
              | if ($names | length) > 0 then " (\($names | join(", ")))" else "" end)]
         | join("; "))
      + (if $npeers > 3 then "; +\($npeers - 3) more" else "" end)
      + ". Run /standup before editing shared files."
    end;
  "→ /remember --project \($project) for full orientation." as $tail

# 100 characters: the median unresolved[] item is 152 (p90 256), so most are cut,
# and four cut items leave room for the repo and peer lines inside 800.
| ($t.items | map(clip(100))) as $items
| ($items | length) as $n
# $k: how many threads to list.
| def render($k; $f):
    [$head, $wline]
    + (if $n == 0 then (if $w then ["It recorded no open threads."] else [] end)
       elif $k == 0 then ["It left \($n) open thread\(if $n == 1 then "" else "s" end): /remember --get \($wid)"]
       else ["Open threads it left:"] + ($items[0:$k] | map("- " + .))
         + ["(" + (if $n > $k then "+\($n - $k) more. " else "" end) + "Full record: /remember --get \($wid))"]
       end)
    + [$repo, peerline($f), $tail]
    | map(select(. != null)) | join("\n");
  # Threads first, peer file names second: the most threads that fit, and at
  # that count the most file names that still fit.
  ([range($n; -1; -1) as $k | (2, 1, 0) as $f | select((render($k; $f) | length) <= $cap) | [$k, $f]]
   | first // [0, 0]) as [$k, $f]
| render($k; $f) as $note

| {
    timestamp: ($now | todate), v: 2, project: $project, provider: $provider, source: $source,
    session_id: (if $sid == "" then null else $sid end),
    wrapup_id: (if $wid == "" then null else $wid end),
    wrapup_at: ($w.timestamp // null),
    wrapup_age_h: (if $wage then ($wage / 3600 | floor) else null end),
    open_source: $t.source, open_threads: ($items | length),
    open_shown: (if $show then $k else 0 end),
    branch: $branch, dirty: (if $status == "" then null else $dirty end),
    untracked: (if $status == "" then null else $untracked end),
    unpushed: $ahead, local_only: $local,
    peers: (if $peers == null then null else $npeers end),
    peer_ids: (if $peers == null then null else [$peers[0:5][] | (.id // "")[0:8]] end),
    fired: ($wid != "" or $npeers > 0),
    reason: (if $show then ([if $new_wrapup then "new_wrapup" else empty end, if $npeers > 0 then "peers" else empty end] | join("+"))
             elif $wid == "" then "nothing" else "repeat" end),
    chars: (if $show then ($note | length) else 0 end),
    shown: $show
  } as $row
| ($row | tojson),
  (if $show then {hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $note}} | tojson else "" end)
