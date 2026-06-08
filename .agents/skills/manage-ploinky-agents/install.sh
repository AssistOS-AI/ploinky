#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(pwd)}"
SKILL_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

same_path() {
  [[ "$(realpath -m "$1")" == "$(realpath -m "$2")" ]]
}

install_one() {
  local dest="$1"
  if same_path "$SKILL_SRC" "$dest"; then
    echo "Already installed at $dest"
    return 0
  fi
  local tmp
  tmp="$(mktemp -d)"
  cp -R "$SKILL_SRC"/. "$tmp"/
  mkdir -p "$(dirname "$dest")"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -R "$tmp"/. "$dest"/
  rm -rf "$tmp"
  echo "Installed to $dest"
}

install_one "$ROOT/.agents/skills/manage-ploinky-agents"
install_one "$ROOT/.claude/skills/manage-ploinky-agents"
