# Hermes / FrakBot session feed

`frakbot-carto-feed.sh` is the personal policy wrapper for FrakBot's bounded
cross-agent session pulse. It calls the canonical
`scripts/cartographer-feed.sh`; it does not maintain another index.

Install the wrapper under Hermes:

```bash
cp integrations/hermes/frakbot-carto-feed.sh \
  /Users/andyed/.hermes/scripts/frakbot-carto-feed.sh
chmod +x /Users/andyed/.hermes/scripts/frakbot-carto-feed.sh
```

Attach it as the pre-script on the `frakbot-dream-molt` job. Hermes runs the
script immediately before the agent and injects stdout into that run's prompt.
The existing signal-pulse `context_from` dependency remains unchanged.

The wrapper searches only named independent-project aliases and repositories.
It deliberately omits generic `dev`/unknown projects, the deprecated FrakBot
alias that maps to OpenClaw history, and employer systems. Override the list for
a one-off dry run with `FRAKBOT_CARTO_PROJECTS`; do not broaden the scheduled
default without reviewing the source-policy boundary.

