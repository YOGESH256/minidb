#!/usr/bin/env bash
#
# The 20 seconds worth showing: commits running, kill -9 mid-write, reopen,
# nothing lost and nothing half-written.
#
#   bash scripts/kill-9-demo.sh
#
# Everything here is real. The writer is test/crash-child.ts, the same one
# the test suite kills six times a run. Record it with asciinema, or just
# screen-record the terminal.
set -euo pipefail
cd "$(dirname "$0")/.."

DB="$(mktemp -d)/demo.db"
B='\033[1m'; D='\033[2m'; G='\033[32m'; R='\033[31m'; N='\033[0m'
step() { printf "\n${B}%s${N}\n" "$1"; }
pause() { sleep "${PAUSE:-1.2}"; }

printf "${B}minidb: kill -9 in the middle of writing${N}\n"
printf "${D}Each transaction inserts a batch of 10 rows. A batch must be all there or not there at all.${N}\n"
pause

step "1. Start writing, and let it run."
# node directly, not npx: npx spawns a child, and killing the wrapper would
# leave the real writer running (and still holding the lock).
node --import tsx test/crash-child.ts "$DB" > /dev/null 2>&1 &
WRITER=$!
sleep 2.5
printf "   ${D}writer pid %s is committing batches${N}\n" "$WRITER"
pause

step "2. Kill it. No warning, no cleanup, no chance to flush."
kill -9 "$WRITER"
wait "$WRITER" 2>/dev/null || true
printf "   ${R}kill -9 %s${N}\n" "$WRITER"
   printf "   ${D}on disk:$(cd "$(dirname "$DB")" && ls -l demo.db* | awk '{printf "  %s %s bytes", $9, $5}')${N}\n"
pause

step "3. Reopen. The lock left behind by the dead process is taken over, and the log is replayed."
printf "   ${D}stale lock holds pid $(head -1 "$DB.lock" 2>/dev/null || echo '?'), which no longer exists${N}\n"
node --import tsx scripts/_check-recovery.mts "$DB"
pause

printf "\n${D}The WAL replayed to the last COMMIT. Anything after it failed its checksum and was discarded.${N}\n"
printf "${D}github.com/YOGESH256/minidb${N}\n\n"
rm -rf "$(dirname "$DB")"
