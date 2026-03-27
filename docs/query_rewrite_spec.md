# Query Rewrite Spec: Solving BM25 Stemming via LLM

## 1. Challenge
Okapi BM25 evaluates exact token matches. It cannot inherently equate "shader" to "shaders" or "running" to "run" without a complex linguistic stemming library, which breaks the zero-dependency design goals of `session-cartographer`.

## 2. Proposed Architecture
Instead of building a naive string stemmer into `awk`, we leverage the ecosystem Cartographer already lives in: Claude Code. When a user invokes the custom `/remember` slash command, the Claude agent evaluates the request **before** shelling out to the bash pipeline. 

The LLM acts as an invisible semantic expansion layer, injecting linguistic equivalents directly into the exact-match keyword query.

## 3. Data Flow
1. **User input:** `/remember shader fix`
2. **Claude intercepts:** The agent recognizes a search intent and runs a lightweight zero-shot expansion.
3. **Query Expansion:** Claude detects the core nouns/verbs and synthesizes suffix variations and plurals: `shader shaders shading fix fixes fixed`.
4. **Execution:** Claude fires the expanded string to the pipeline: 
   `bash scripts/cartographer-search.sh "shader shaders shading fix fixes fixed"`
5. **BM25 Scoring:** The `awk` search natively evaluates the expanded string. Because BM25 utilizes Term Frequency (TF), any document containing *any* of those variations will have its relevance score organically boosted, gracefully simulating a high-end linguistic stemmer.

## 4. Implementation Steps
To achieve this, the prompt/tool boundary bridging Claude Code to Cartographer must be updated.

**Prompt/Tool Definition Update:**
```yaml
name: "remember"
description: >
  Search the user's past session history for a concept.
  CRITICAL: You must expand the user's query before executing cartographer-search.sh. 
  Include plurals, verb tenses, and 1-2 direct synonyms (e.g. "bug" -> "bugs fixed error"). 
  Pass the expanded space-separated string as the single query argument.
```

## 5. Pros and Cons
**Pros:**
- **Zero dependencies:** Maintains `awk` purity and lightning speed.
- **Domain awareness:** The LLM can inject context-specific tech synonyms (`UI` -> `frontend React`).
- **Mathematical elegance:** Matches BM25's native reliance on token term-frequencies perfectly.

**Cons:**
- Only applies to searches initiated via the Claude Agent `/remember` loop. Raw CLI users typing `bash cartographer-search.sh` will not get stemming unless they manually expand the query.
