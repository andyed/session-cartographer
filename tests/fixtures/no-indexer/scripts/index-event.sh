#!/bin/bash
# A stand-in index-event.sh for hook tests that do not test indexing: it reads
# the event and does nothing. See NO_INDEXER_ENV in tests/unit/helpers/offline-index.js.
while IFS= read -r _; do :; done
exit 0
