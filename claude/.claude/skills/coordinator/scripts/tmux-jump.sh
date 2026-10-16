#!/usr/bin/env bash
# Handler for tmuxjump://<session>/<@window> links from the status page. Opens a new terminal
# window on that tmux window; the existing terminal is left alone.
set -euo pipefail

if [[ ${1:-} =~ ^tmuxjump://([A-Za-z0-9_-]+)/(@[0-9]+)$ ]]; then
  session="${BASH_REMATCH[1]}"
  window="${BASH_REMATCH[2]}"
else
  echo "tmux-jump: refusing malformed link: ${1:-}" >&2
  exit 1
fi

# A grouped session shares the windows but keeps its own current window, so the new terminal
# can sit on this agent without moving the original client; it removes itself when closed.
view="jump-$$"
# TMUX_JUMP_TERMINAL is unquoted on purpose: it holds a command plus its arguments.
# shellcheck disable=SC2086
setsid ${TMUX_JUMP_TERMINAL:-gnome-terminal --} \
  tmux new-session -t "$session" -s "$view" \; \
  select-window -t "$view:$window" \; \
  set-option destroy-unattached on \
  >/dev/null 2>&1 &
