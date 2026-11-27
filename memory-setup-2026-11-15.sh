#!/usr/bin/env bash
# Session setup script: restores shared memory (Drive = primary) for any new session/agent.
# Steps: 1) ensure memsync.sh exists  2) caller pulls newest memory-bundle-*.md from Drive
# folder 13DHLcooRO0oMezwDUOwLFOIDBka062pv  3) run: bash memory-setup-2026-11-15.sh <bundle.md>
set -euo pipefail
[ -x /root/.claude/memsync.sh ] || { echo "missing /root/.claude/memsync.sh - copy it from this repo or the shared-memory skill"; exit 1; }
[ -n "${1:-}" ] || { echo "usage: $0 <downloaded-memory-bundle.md>"; exit 1; }
/root/.claude/memsync.sh unpack "$1"
echo "--- loaded ---"; head -20 /root/.claude/CLAUDE.md
