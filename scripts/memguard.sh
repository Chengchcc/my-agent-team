#!/usr/bin/env bash
# memguard.sh — run a heavy command under a hard memory cap.
#
# Why: a runaway build on a small box does not fail, it pushes the machine into
# swap-thrash and freezes the session (observed: `next build` on a 2-core /
# 3.5GB box ran 70 minutes with no output at 0.9% CPU, RAM at 99%). A cap turns
# that into a fast, legible "your command was killed" instead of a dead box.
#
# Why cgroup v2 and not ulimit: `ulimit -v` breaks Node/Bun (they reserve a huge
# address space up front) and `ulimit -m` is a no-op on Linux. The cgroup
# OOM-killer with memory.oom.group=1 kills the whole process tree at once —
# without it the kernel picks one worker, the parent keeps waiting on a sibling
# that will never answer, and the command hangs forever (exactly what was seen).
#
# Usage:
#   bash scripts/memguard.sh [--limit 2G] [--min-available 800] [--allow-swap] -- <command...>
#
# Defaults: cap 2G, require 800MB available before starting, swap disabled for
# the child (swap is the thrash path: with swap.max=0 the tree is killed rather
# than dragging the whole machine down).
#
# Exit code: the child's, or 137 when the cap killed it.

set -euo pipefail

LIMIT="2G"
MIN_AVAILABLE="800"
ALLOW_SWAP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --limit) LIMIT="${2:?--limit needs a value like 2G}"; shift 2 ;;
    --limit=*) LIMIT="${1#*=}"; shift ;;
    --min-available) MIN_AVAILABLE="${2:?--min-available needs MB}"; shift 2 ;;
    --min-available=*) MIN_AVAILABLE="${1#*=}"; shift ;;
    --allow-swap) ALLOW_SWAP=1; shift ;;
    --) shift; break ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) break ;;
  esac
done

if [ $# -eq 0 ]; then
  echo "memguard: no command given. Usage: memguard.sh [--limit 2G] -- <command...>" >&2
  exit 2
fi

# 2G / 512M / 800K / bare bytes -> bytes
to_bytes() {
  local v="$1"
  case "$v" in
    *[Gg]) echo $(( ${v%?} * 1024 * 1024 * 1024 )) ;;
    *[Mm]) echo $(( ${v%?} * 1024 * 1024 )) ;;
    *[Kk]) echo $(( ${v%?} * 1024 )) ;;
    *) echo "$v" ;;
  esac
}

LIMIT_BYTES="$(to_bytes "$LIMIT")"
AVAILABLE_MB="$(awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo)"

if [ "$AVAILABLE_MB" -lt "$MIN_AVAILABLE" ]; then
  echo "memguard: REFUSING to start — ${AVAILABLE_MB}MB available, ${MIN_AVAILABLE}MB required." >&2
  echo "memguard: this box has $(awk '/^MemTotal:/ {printf "%d", $2/1024/1024}' /proc/meminfo)GB total. Run this in CI, or lower --min-available deliberately." >&2
  exit 3
fi

HEADROOM_MB=$(( AVAILABLE_MB - LIMIT_BYTES / 1024 / 1024 ))
if [ "$HEADROOM_MB" -lt 400 ]; then
  echo "memguard: NOTE — cap ${LIMIT} leaves ${HEADROOM_MB}MB headroom (${AVAILABLE_MB}MB available): expect the cap to kill it." >&2
fi

CG_ROOT="/sys/fs/cgroup"
SELF_CGROUP="$(awk -F: '/^0::/ {print $3}' /proc/self/cgroup)"

# The memory controller is only available to CHILDREN of a cgroup whose
# cgroup.subtree_control lists "memory". systemd does not delegate memory to a
# login session scope by default (root here: "cpuset cpu io memory pids",
# session scope: empty), so writing memory.max under the session scope fails —
# walk up to the nearest ancestor that actually has it.
pick_parent() {
  local dir="${CG_ROOT}${SELF_CGROUP}"
  while [ "$dir" != "$CG_ROOT" ]; do
    if grep -qw memory "$dir/cgroup.subtree_control" 2>/dev/null; then echo "$dir"; return 0; fi
    dir="$(dirname "$dir")"
  done
  if grep -qw memory "$CG_ROOT/cgroup.subtree_control" 2>/dev/null; then echo "$CG_ROOT"; return 0; fi
  return 1
}

PARENT="$(pick_parent || true)"
CHILD_CGROUP=""
CAPABLE=0
if [ -n "${PARENT:-}" ]; then
  CHILD_CGROUP="${PARENT}/memguard.$$"
  if mkdir -p "$CHILD_CGROUP" 2>/dev/null &&
     echo "$LIMIT_BYTES" > "$CHILD_CGROUP/memory.max" 2>/dev/null; then
    CAPABLE=1
  fi
fi

cleanup_cgroup() {
  [ -n "$CHILD_CGROUP" ] && [ -d "$CHILD_CGROUP" ] || return 0
  echo 1 > "$CHILD_CGROUP/cgroup.kill" 2>/dev/null || true
  rmdir "$CHILD_CGROUP" 2>/dev/null || true
}
trap cleanup_cgroup EXIT
# bash does NOT run the EXIT trap when it dies from an untrapped signal, which
# left empty memguard.* cgroups behind every time the wrapper was killed
# (hub stop, Ctrl-C). Trapping and exiting normally routes through EXIT.
trap 'exit 143' TERM
trap 'exit 130' INT

if [ "$CAPABLE" = 1 ]; then
  # Whole-tree kill: otherwise the OOM killer takes one worker and the parent
  # waits forever on the siblings that never come back.
  echo 1 > "$CHILD_CGROUP/memory.oom.group" 2>/dev/null || true
  if [ "$ALLOW_SWAP" = 0 ]; then
    echo 0 > "$CHILD_CGROUP/memory.swap.max" 2>/dev/null || true
  fi
fi

if [ "$CAPABLE" = 0 ]; then
  echo "memguard: WARNING — no cgroup with the memory controller available (tried ${SELF_CGROUP})." >&2
  echo "memguard: running UNCAPPED; only the preflight check protects this box." >&2
  exec "$@"
fi

echo "memguard: cap=${LIMIT} (swap=$([ "$ALLOW_SWAP" = 1 ] && echo allowed || echo off)) available=${AVAILABLE_MB}MB at ${CHILD_CGROUP}"
echo "memguard: cmd=$*"

# Put the child in the cgroup from inside itself (no race: it is already there
# before exec, so the first allocation is accounted).
( echo $BASHPID > "$CHILD_CGROUP/cgroup.procs"; exec "$@" ) &
CHILD=$!

set +e
wait "$CHILD"
STATUS=$?
set -e

PEAK_MB="$(awk '{printf "%d", $1/1024/1024}' "$CHILD_CGROUP/memory.peak" 2>/dev/null || echo 0)"
OOM_KILLS="$(awk '/^oom_kill / {print $2}' "$CHILD_CGROUP/memory.events" 2>/dev/null || echo 0)"

if [ "${OOM_KILLS:-0}" != "0" ]; then
  echo "memguard: KILLED by the ${LIMIT} cap — peak ${PEAK_MB}MB, oom_kill=${OOM_KILLS}, child status ${STATUS}." >&2
  echo "memguard: not a code bug: the command needs more memory than this box can give. Use CI or raise --limit." >&2
  exit 137
fi

echo "memguard: exited ${STATUS}, peak ${PEAK_MB}MB"
exit "$STATUS"
