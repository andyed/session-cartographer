# Session Cartographer — TODO

## Explorer UI
- [ ] Facet brushing — hover pill → non-matching results collapse to colored pixel bars
- [ ] Contrast audit — enforce minimum gray-300 for readable text, gray-400 for info
- [ ] Loading skeletons instead of text spinners
- [ ] Infinite scroll (auto-load on scroll vs. manual "show more")
- [ ] Error boundary — catch React crashes, show recovery UI

## Search
- [ ] `--list-types` — auto-discover event types from JSONL files
- [ ] Wildcard expansion feedback — show "expanded to N terms" in results meta
- [ ] Query rewrite — synonym expansion, quoted phrases

## Documentation
- [ ] Doc-sync agent — manifest-driven drift detection between code and docs
- [ ] CHANGELOG_SPEC — keep type table in sync with actual hook output
- [ ] Uninstall script (`scripts/uninstall.sh`)

## Infrastructure
- [ ] `npm install` pre-flight check in `/carto explore` skill
- [ ] Connection status indicator for EventSource (SSE reconnect feedback)
- [ ] Briefings system — commit compile-briefing.sh + project-families.json
