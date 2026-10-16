#!/usr/bin/env bash
# Handler for tmuxjump://<session>/<@window> links from the status page. Switches tmux only.
set -euo pipefail

if [[ ${1:-} =~ ^tmuxjump://([A-Za-z0-9_-]+)/(@[0-9]+)$ ]]; then
  target="${BASH_REMATCH[1]}:${BASH_REMATCH[2]}"
else
  echo "tmux-jump: refusing malformed link: ${1:-}" >&2
  exit 1
fi

client="$(tmux list-clients -F '#{client_tty}' 2>/dev/null | head -n 1)"
if [[ -n $client ]]; then
  tmux switch-client -c "$client" -t "$target"
else
  tmux select-window -t "$target"
fi
