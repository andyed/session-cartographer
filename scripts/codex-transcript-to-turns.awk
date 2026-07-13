#!/usr/bin/awk -f
# codex-transcript-to-turns.awk — Normalize a Codex rollout JSONL to turns.
#
# Codex currently records user prompts as event_msg/user_message and retained
# assistant messages/tool activity as response_item records. This adapter owns
# that unstable wire format and emits the same provider-neutral turn documents
# as transcript-to-turns.awk. Consumers must depend on the output schema, not
# either provider's raw transcript representation.

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

function harvest(line,    out) {
    out = ""
    out = out extract_values(line, "message")
    out = out extract_values(line, "text")
    out = out extract_values(line, "content")
    out = out extract_values(line, "input")
    out = out extract_values(line, "output")
    out = out extract_values(line, "name")
    out = out extract_values(line, "query")
    out = out extract_values(line, "url")
    return out
}

function flush_turn() {
    if (!started) return
    if (length(turn_body) > body_max) turn_body = substr(turn_body, 1, body_max)
    printf "{\"event_id\":\"turn-codex-%s-%d\",\"timestamp\":\"%s\",\"project\":\"%s\",\"type\":\"transcript\",\"provider\":\"codex\",\"summary\":\"%s\",\"transcript_path\":\"%s\",\"session\":\"%s\",\"turn_idx\":%d}\n", \
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
    is_user = ($0 ~ /^\{"timestamp"[^}]*"type":"event_msg"/ && $0 ~ /"type":"user_message"/)
    is_message = ($0 ~ /^\{"timestamp"[^}]*"type":"response_item"/ && $0 ~ /"type":"message"/ && $0 ~ /"role":"assistant"/)
    is_tool = ($0 ~ /^\{"timestamp"[^}]*"type":"response_item"/ && $0 ~ /"type":"(custom_tool_call|custom_tool_call_output|function_call|function_call_output)"/)
    if (!is_user && !is_message && !is_tool) next

    if (is_user) {
        if (started) flush_turn()
        turn_idx++
        started = 1
        turn_body = ""
        turn_ts = field($0, "timestamp")
    }

    if (!started) next
    harvested = harvest($0)
    if (harvested != "") turn_body = turn_body " " harvested
}

END {
    flush_turn()
}
