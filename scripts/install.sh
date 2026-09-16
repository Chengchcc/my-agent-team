#!/bin/sh
# oma installer: one command for the CLI plus the backend + web stack artifact.
#
#   curl -fsSL https://raw.githubusercontent.com/Chengchcc/my-agent-team/master/scripts/install.sh | sh
#
# POSIX sh on purpose (dash, not bash): pipelines like this run under whatever
# /bin/sh is, so no bashisms. Idempotent, no sudo, and it never starts the stack
# (that is `oma --up`, a foreground process a pipe should not own).
#
# Env:
#   OMA_VERSION  npm version/dist-tag to install (default: latest)
#   OMA_SKIP_STACK_FETCH=1  install the CLI only, skip the artifact download

set -eu

OMA_VERSION="${OMA_VERSION:-latest}"
PKG="@chengchenccc/oh-my-agent@${OMA_VERSION}"

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

# ── 1. Bun (oma's runtime) ────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
  say "==> installing Bun (oma runs on it)"
  curl -fsSL https://bun.sh/install | bash || die "Bun install failed"
  PATH="$HOME/.bun/bin:$PATH"
  export PATH
fi

command -v bun >/dev/null 2>&1 || die "bun is not on PATH after install; add \$HOME/.bun/bin and re-run"

# ── 2. the oma CLI ────────────────────────────────────────────────
say "==> installing $PKG"
bun add -g "$PKG" || die "could not install $PKG (check the version/dist-tag)"

command -v oma >/dev/null 2>&1 || \
  say "note: oma is installed but not on PATH yet — add \$HOME/.bun/bin to PATH"

# ── 3. the stack artifact (backend + web) ─────────────────────────
# Best effort here: the package's postinstall already tries, and `oma --up`
# retries with full logs. A failure must not fail the install.
if [ "${OMA_SKIP_STACK_FETCH:-0}" = "1" ]; then
  say "==> skipping the stack download (OMA_SKIP_STACK_FETCH=1)"
else
  say "==> downloading the stack artifact (backend + web)"
  if command -v oma >/dev/null 2>&1; then
    oma --stack-fetch || say "note: stack download failed — 'oma --up' will retry it"
  else
    say "note: run 'oma --stack-fetch' once oma is on PATH"
  fi
fi

# ── 4. what to do next ────────────────────────────────────────────
say ""
say "installed. next:"
say "  oma --up          start the stack (prints the login URL + password)"
say "  oma --stack-status  what is installed, and is it running"
say ""
say "requirements: bun (installed above), plus tar and zstd for the artifact."
