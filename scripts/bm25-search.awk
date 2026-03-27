#!/usr/bin/awk -f
# bm25-search.awk — BM25 scoring for Claude Code JSONL logs
# Expects line-delimited JSON or JSONL. Does basic regex-based field extraction.
# 
# Usage: awk -f bm25-search.awk -v query="shader fix blur" -v src="changelog" [ -v proj_filter="..." ] file.jsonl file.jsonl
# Note: You MUST pass the target file twice on the CLI (it uses NR==FNR for the two-pass algorithm).

BEGIN {
    k1 = 1.2
    b = 0.75
    # Tokenize the query
    nq = split(tolower(query), qterms, /[^a-z0-9]+/)
    nresults = 0
}

# Fast custom JSON extractor for known keys
function extract(json, field,    pat, val) {
    pat = "\"" field "\"[[:space:]]*:[[:space:]]*\""
    if (match(json, pat)) {
        val = substr(json, RSTART + RLENGTH)
        sub(/".*/, "", val)
        return val
    }
    return ""
}

# Helper to get the searchable text body from the JSON line
function get_search_text(line, src_type) {
    if (src_type == "transcript") {
        # Transcript uses "content" for the text body
        val = ""
        uuid = extract(line, "uuid")
        if (uuid != "") val = uuid " "
        
        if (match(line, /"content"[[:space:]]*:[[:space:]]*"/)) {
            content = substr(line, RSTART + RLENGTH)
            sub(/".*/, "", content)
            gsub(/\\n/, " ", content)
            gsub(/\\t/, " ", content)
            val = val content
        }
        return val
    } else {
        # Other logs use summary, description, prompt, url, query, event_id
        val = ""
        f = extract(line, "summary"); if (f != "") val = val " " f
        f = extract(line, "description"); if (f != "") val = val " " f
        f = extract(line, "prompt"); if (f != "") val = val " " f
        f = extract(line, "url"); if (f != "") val = val " " f
        f = extract(line, "query"); if (f != "") val = val " " f
        f = extract(line, "event_id"); if (f != "") val = val " " f
        f = extract(line, "milestone"); if (f != "") val = val " " f
        return val
    }
}

# Pass 1 (NR == FNR): Read corpus, build DF table, compute average doc length
NR == FNR {
    # If project filter is set, quickly check it
    if (proj_filter != "") {
        proj = extract($0, "project")
        if (tolower(proj) !~ tolower(proj_filter)) {
            next
        }
    }
    
    # Identify type of source
    is_transcript = ($0 ~ /"type"[[:space:]]*:[[:space:]]*"user"/ || $0 ~ /"type"[[:space:]]*:[[:space:]]*"assistant"/)
    if (src == "transcript" && !is_transcript) next
    
    body = get_search_text($0, src)
    if (body == "") next
    
    # We only care about words that appear in the query anyway
    n = split(tolower(body), words, /[^a-z0-9]+/)
    total_dl += n
    ndocs++
    
    delete seen
    for (i = 1; i <= n; i++) {
        if (!seen[words[i]]++) {
            df[words[i]]++
        }
    }
    next
}

# Pass 2 (!NR == FNR): Re-read corpus, score each document against the query
{
    if (ndocs == 0) exit
    
    avgdl = total_dl / ndocs
    
    if (proj_filter != "") {
        proj = extract($0, "project")
        if (tolower(proj) !~ tolower(proj_filter)) {
            next
        }
    }
    
    is_transcript = ($0 ~ /"type"[[:space:]]*:[[:space:]]*"user"/ || $0 ~ /"type"[[:space:]]*:[[:space:]]*"assistant"/)
    if (src == "transcript" && !is_transcript) next
    
    body = get_search_text($0, src)
    if (body == "") next
    
    n = split(tolower(body), words, /[^a-z0-9]+/)
    delete tf
    for (i = 1; i <= n; i++) {
        tf[words[i]]++
    }
    
    score = 0
    # Evaluate BM25 formula against query words
    for (i = 1; i <= nq; i++) {
        q = qterms[i]
        if (q == "" || tf[q] == 0) continue
        
        idf = log((ndocs - df[q] + 0.5) / (df[q] + 0.5))
        if (idf < 0) idf = 0  # clamp common terms
        
        num = tf[q] * (k1 + 1)
        denom = tf[q] + k1 * (1 - b + b * (n / avgdl))
        score += idf * (num / denom)
    }

    if (score > 0) {
        # Format TSV values: src, _rank_, key, ts, proj, summary, extras
        
        # Extract fields
        if (src == "transcript") {
            key = extract($0, "uuid")
            if (key == "") key = "transcript-" sid "-" FNR
            ts = extract($0, "timestamp")
            proj = (proj_filter != "") ? proj_filter : extract($0, "project")  # Often missing in line, passed down
            
            # Truncate content for display
            summary = length(body) > 150 ? substr(body, 1, 150) : body
            
            extras = "transcript:" tpath "|session:" sid "|"
            
            # Use negative score as a sort key placeholder since we want descending order
            results[++nresults] = sprintf("%f\t%s\t%d\t%s\t%s\t%s\t%s\t%s", -score, "transcript:" extract($0, "type"), 0, key, ts, pdir, summary, extras)
        } else {
            key = extract($0, "event_id")
            if (key == "") key = extract($0, "milestone")
            if (key == "") key = src "-" FNR
            
            ts = extract($0, "timestamp")
            proj = extract($0, "project")
            
            url = extract($0, "url")
            deeplink = extract($0, "deeplink")
            transcript = extract($0, "transcript_path")
            
            extras = ""
            if (url != "") extras = extras "url:" url "|"
            if (deeplink != "" && deeplink != "none") extras = extras "deeplink:" deeplink "|"
            if (transcript != "") extras = extras "transcript:" transcript "|"
            
            results[++nresults] = sprintf("%f\t%s\t%d\t%s\t%s\t%s\t%s\t%s", -score, src, 0, key, ts, proj, body, extras)
        }
    }
}

END {
    # Shell out to sort by score (column 1 numeric), then re-assign rank 1-N (so RRF works)
    # We pass the results array directly to sort.
    if (nresults > 0) {
        sort_cmd = "sort -n | awk -F'\\t' '{ $3 = NR; for(i=2;i<=NF;i++) printf \"%s%s\", $i, (i==NF?\"\\n\":\"\\t\") }'"
        for (i = 1; i <= nresults; i++) {
            print results[i] | sort_cmd
        }
        close(sort_cmd)
    }
}
