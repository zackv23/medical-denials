#!/usr/bin/env bash
set -euo pipefail
RAM=/dev/shm/claude-memory
link() {
  for n in CLAUDE.md memory; do
    t=/root/.claude/$n
    if [ -L "$t" ] || [ ! -e "$t" ]; then ln -sfn "$RAM/$n" "$t"; fi
  done
}
case "${1:-}" in
  pack)
    out=/tmp/memory-bundle-$(date -u +%Y-%m-%d-%H%M%S).md
    { echo "# claude-shared-memory bundle"; echo "<!-- generated $(date -u +%FT%TZ) -->"
      (cd "$RAM" && find . -type d | sort | sed 's|^\./||' | grep -v '^\.$' | while read d; do echo "<<<DIR: $d>>>"; done)
      (cd "$RAM" && find . -type f | sort | sed 's|^\./||' | while read f; do
         echo "<<<FILE: $f>>>"; cat "$f"; echo; echo "<<<END>>>"; done)
    } > "$out"
    echo "$out";;
  unpack)
    src="$2"; mkdir -p "$RAM" /root/.claude
    python3 -I - "$src" "$RAM" <<'PY'
import sys, os, re
src, ram = sys.argv[1], sys.argv[2]
cur, buf = None, []
for line in open(src, encoding="utf-8").read().split("\n"):
    m = re.match(r"^<<<(DIR|FILE): (.+)>>>$", line)
    if m and m.group(1) == "DIR":
        os.makedirs(os.path.join(ram, m.group(2)), exist_ok=True)
    elif m:
        cur, buf = m.group(2), []
    elif line == "<<<END>>>" and cur:
        p = os.path.join(ram, cur); os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w", encoding="utf-8").write("\n".join(buf))
        cur = None
    elif cur is not None:
        buf.append(line)
PY
    link; echo "unpacked -> $RAM";;
  *) echo "usage: $0 pack | unpack <bundle>"; exit 1;;
esac
