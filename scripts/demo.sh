#!/usr/bin/env bash
# The end-to-end demonstration (see scripts/demo.ts): a temporary repository, jlock and ledger, removed at the end.
exec bun "$(dirname "$0")/demo.ts" "$@"
