#!/usr/bin/awk -f
# transcript-to-turns.awk — Group Claude Code transcript JSONL into turns.
#
# A "turn" is a user message plus every following assistant message up to the
# next user message. One turn → one output document. Text-bearing JSON values
# (user content, assistant text blocks, tool inputs, names, URLs) are pulled
# out and concatenated; the JSON scaffolding (parentUuid, isSidechain,
# promptId, etc.) is dropped. That keeps BM25 matching focused on real
# content and preview strings human-readable.
#
# Input:  raw ~/.claude/projects/<proj>/<session>.jsonl
# Output: JSONL, one line per turn, fields compatible with event-log sources:
#         event_id, timestamp, project, type, summary, transcript_path, session, turn_idx
#
# Usage:
#   awk -f transcript-to-turns.awk \
#     -v sid="<session_id>" -v proj="<project_dir>" -v tpath="<absolute_path>" \
#     transcript.jsonl
#
# Environment knob:
#   TURN_BODY_MAX (default 50000) — truncate each turn body to this many chars.

function json_escape(s,    out) {
    out = s
    gsub(/\\/, "\\\\", out)
    gsub(/"/, "\\\"", out)
    gsub(/\r/, " ", out)
    gsub(/\n/, " ", out)
    gsub(/\t/, " ", out)
    gsub(/[[:cntrl:]]/, " ", out)
    gsub(/  +/, " ", out)
    return out
}

function field(line, key,    pat, val) {
    pat = "\"" key "\"[[:space:]]*:[[:space:]]*\""
    if (match(line, pat)) {
        val = substr(line, RSTART + RLENGTH)
        sub(/".*/, "", val)
        return val
    }
    return ""
}

# Extract every string value for a given JSON key, concatenated with spaces.
# Walks character-by-character so escaped quotes inside values don't truncate.
function extract_values(line, key, _out, _rem, _pat, _i, _c, _nc, _val, _len) {
    _out = ""
    _rem = line
    _pat = "\"" key "\"[[:space:]]*:[[:space:]]*\""
    while (match(_rem, _pat)) {
        _i = RSTART + RLENGTH
        _len = length(_rem)
        _val = ""
        while (_i <= _len) {
            _c = substr(_rem, _i, 1)
            if (_c == "\\") {
                _nc = substr(_rem, _i + 1, 1)
                if (_nc == "n" || _nc == "t" || _nc == "r") _val = _val " "
                else _val = _val _nc
                _i += 2
                continue
            }
            if (_c == "\"") break
            _val = _val _c
            _i++
        }
        _out = _out " " _val
        _rem = substr(_rem, _i + 1)
    }
    return _out
}

# Pull the searchable text out of a transcript line. Keeps human-readable
# content (text blocks, tool inputs, URLs, file paths, commands); drops the
# JSON scaffolding. The key list is additive — over-extraction is harmless,
# under-extraction loses recall.
function harvest(line,    out) {
    out = ""
    out = out extract_values(line, "text")
    out = out extract_values(line, "content")
    out = out extract_values(line, "file_path")
    out = out extract_values(line, "command")
    out = out extract_values(line, "description")
    out = out extract_values(line, "prompt")
    out = out extract_values(line, "query")
    out = out extract_values(line, "url")
    out = out extract_values(line, "name")
    out = out extract_values(line, "pattern")
    return out
}

function flush_turn() {
    if (!started) return
    if (length(turn_body) > body_max) turn_body = substr(turn_body, 1, body_max)
    printf "{\"event_id\":\"turn-%s-%d\",\"timestamp\":\"%s\",\"project\":\"%s\",\"type\":\"transcript\",\"summary\":\"%s\",\"transcript_path\":\"%s\",\"session\":\"%s\",\"turn_idx\":%d}\n", \
        sid, turn_idx, \
        json_escape(turn_ts), \
        json_escape(proj), \
        json_escape(turn_body), \
        json_escape(tpath), \
        json_escape(sid), \
        turn_idx
}

BEGIN {
    turn_idx = 0
    started = 0
    turn_body = ""
    turn_ts = ""
    body_max = (ENVIRON["TURN_BODY_MAX"] != "") ? (ENVIRON["TURN_BODY_MAX"] + 0) : 50000
}

{
    is_user = ($0 ~ /"type"[[:space:]]*:[[:space:]]*"user"/)
    is_asst = ($0 ~ /"type"[[:space:]]*:[[:space:]]*"assistant"/)
    if (!is_user && !is_asst) next

    if (is_user) {
        if (started) flush_turn()
        turn_idx++
        started = 1
        turn_body = ""
        turn_ts = field($0, "timestamp")
    }

    harvested = harvest($0)
    if (harvested != "") turn_body = turn_body " " harvested
}

END {
    flush_turn()
}
