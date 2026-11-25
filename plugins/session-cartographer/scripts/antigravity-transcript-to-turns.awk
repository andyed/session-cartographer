#!/usr/bin/awk -f
# antigravity-transcript-to-turns.awk — Normalize an Antigravity transcript.jsonl to turns.
#
# Antigravity writes conversation transcripts as JSONL rows under:
#   ~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl
# (and product-specific roots antigravity-ide / antigravity-cli).
#
# User prompts arrive as type="USER_INPUT" (often wrapped in <USER_REQUEST>,
# <ADDITIONAL_METADATA>, and <USER_SETTINGS_CHANGE> envelopes). Assistant replies
# and tool invocations arrive as type="PLANNER_RESPONSE". Raw tool output dumps
# (GENERIC, SYSTEM_MESSAGE, CONVERSATION_HISTORY, etc.) are skipped so turns stay
# focused and signal-dense.
#
# Emits the same provider-neutral turn schema as transcript-to-turns.awk and
# codex-transcript-to-turns.awk. Pure POSIX/BSD/GNU awk, LC_ALL=C safe.

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

function strip_outer_quotes(s) {
    while (length(s) >= 2 && substr(s, 1, 1) == "\"" && substr(s, length(s), 1) == "\"") {
        s = substr(s, 2, length(s) - 2)
    }
    return s
}

function extract_values(line, key, unquote,    _out, _rem, _pat, _i, _c, _nc, _val, _len) {
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
        if (unquote) _val = strip_outer_quotes(_val)
        if (_val != "") _out = (_out == "" ? _val : _out " " _val)
        _rem = substr(_rem, _i + 1)
    }
    return _out
}

function strip_tag_block(s, open_tag, close_tag,    i, j, rest) {
    while ((i = index(s, open_tag)) > 0) {
        rest = substr(s, i + length(open_tag))
        j = index(rest, close_tag)
        if (j > 0) {
            s = substr(s, 1, i - 1) " " substr(rest, j + length(close_tag))
        } else {
            s = substr(s, 1, i - 1)
            break
        }
    }
    return s
}

function clean_user_content(s) {
    s = strip_tag_block(s, "<ADDITIONAL_METADATA>", "</ADDITIONAL_METADATA>")
    s = strip_tag_block(s, "<USER_SETTINGS_CHANGE>", "</USER_SETTINGS_CHANGE>")
    gsub(/<\/?USER_REQUEST>/, " ", s)
    gsub(/  +/, " ", s)
    sub(/^ /, "", s)
    sub(/ $/, "", s)
    return s
}

function harvest_planner(line,    out, part) {
    out = ""
    part = extract_values(line, "content", 0)
    if (part != "") out = out " " part
    part = extract_values(line, "name", 1)
    if (part != "") out = out " " part
    part = extract_values(line, "Path", 1)
    if (part != "") out = out " " part
    part = extract_values(line, "path", 1)
    if (part != "") out = out " " part
    part = extract_values(line, "TargetFile", 1)
    if (part != "") out = out " " part
    part = extract_values(line, "SearchPath", 1)
    if (part != "") out = out " " part
    part = extract_values(line, "CommandLine", 1)
    if (part != "") out = out " " part
    part = extract_values(line, "query", 1)
    if (part != "") out = out " " part
    part = extract_values(line, "Query", 1)
    if (part != "") out = out " " part
    part = extract_values(line, "focus", 1)
    if (part != "") out = out " " part
    part = extract_values(line, "url", 1)
    if (part != "") out = out " " part
    part = extract_values(line, "Url", 1)
    if (part != "") out = out " " part
    gsub(/  +/, " ", out)
    sub(/^ /, "", out)
    sub(/ $/, "", out)
    return out
}

function flush_turn(    body) {
    if (!started) return
    body = turn_body
    gsub(/  +/, " ", body)
    sub(/^ /, "", body)
    sub(/ $/, "", body)
    if (length(body) > body_max) body = substr(body, 1, body_max)
    printf "{\"event_id\":\"turn-antigravity-%s-%d\",\"timestamp\":\"%s\",\"project\":\"%s\",\"type\":\"transcript\",\"provider\":\"antigravity\",\"summary\":\"%s\",\"transcript_path\":\"%s\",\"session\":\"%s\",\"turn_idx\":%d}\n", \
        json_escape(sid), turn_idx, \
        json_escape(turn_ts), \
        json_escape(proj), \
        json_escape(body), \
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
    rec_type = field($0, "type")
    if (rec_type != "USER_INPUT" && rec_type != "PLANNER_RESPONSE") next

    if (rec_type == "USER_INPUT") {
        if (started) flush_turn()
        turn_idx++
        started = 1
        turn_body = ""
        turn_ts = field($0, "created_at")
        if (turn_ts == "") turn_ts = field($0, "timestamp")
        harvested = clean_user_content(extract_values($0, "content", 0))
    } else {
        if (!started) next
        harvested = harvest_planner($0)
    }

    if (harvested != "") {
        turn_body = (turn_body == "" ? harvested : turn_body " " harvested)
    }
}

END {
    flush_turn()
}
