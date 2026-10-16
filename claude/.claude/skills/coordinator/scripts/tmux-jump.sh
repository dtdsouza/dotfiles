#!/usr/bin/env bash
# Handler for tmuxjump:// links from the status page: opens a new terminal on a tmux window (the
# existing terminal is left alone), resumes a closed task, or regenerates the page.
set -euo pipefail

# TMUX_JUMP_TERMINAL is unquoted on purpose: it holds a command plus its arguments.
# shellcheck disable=SC2086
terminal() { setsid ${TMUX_JUMP_TERMINAL:-gnome-terminal --} "$@" >/dev/null 2>&1 & }

if [[ ${1:-} == tmuxjump://refresh ]]; then
  bash "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/agentctl.sh" dashboard >/dev/null 2>&1 || true
  exit 0
elif [[ ${1:-} =~ ^tmuxjump://resume/([A-Za-z0-9._-]+)$ ]]; then
  terminal bash "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/agentctl.sh" resume "${BASH_REMATCH[1]}"
  exit 0
elif [[ ${1:-} =~ ^tmuxjump://([A-Za-z0-9_-]+)/(@[0-9]+)$ ]]; then
  session="${BASH_REMATCH[1]}"
  window="${BASH_REMATCH[2]}"
else
  echo "tmux-jump: refusing malformed link: ${1:-}" >&2
  exit 1
fi

# A grouped session shares the windows but keeps its own current window, so the new terminal
# can sit on this agent without moving the original client; it removes itself when closed.
view="jump-$$"
terminal tmux new-session -t "$session" -s "$view" \; \
  select-window -t "$view:$window" \; \
  set-option destroy-unattached on
