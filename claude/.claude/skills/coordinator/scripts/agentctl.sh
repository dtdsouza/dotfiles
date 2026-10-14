#!/usr/bin/env bash
# Worker-tab control for the coordinator skill: spawn, rename, list, the task ledger, and the
# coordinator launcher.
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
DEFAULT_REPO="${COORDINATOR_DEFAULT_REPO:-$HOME/workspace/twism/platform/monorepo}"
# Lives under the coordinator's cwd (DEFAULT_REPO) because the agent sandbox only lets a session
# write inside its cwd.
STATE_DIR="${COORDINATOR_STATE_DIR:-$DEFAULT_REPO/.claude/coordinator}"
TASKS_DIR="$STATE_DIR/tasks"
STANDING_NOTES="$STATE_DIR/notes.md"
# Claude Code keeps at most 10,000 characters of SessionStart hook output in context.
BRIEF_LIMIT=9500
NOTES_PER_TASK=5
# A fresh session already holds ~48k tokens (tools, CLAUDE.md, memory, skills) and auto-compact
# reserves ~33k, so 150k leaves ~70k of conversation between compactions.
COORDINATOR_COMPACT_WINDOW=150000
COORDINATOR_ROLE="You are the coordinator session. The user hands you tasks and initiatives; you delegate each one to a worker Claude session in its own tmux tab and keep track of them in the agentctl ledger. Load the coordinator skill before acting on any request."

usage() {
  cat <<'EOF'
Usage:
  agentctl.sh spawn --name <tab-name> --brief <file> --coordinator <session-name> [options]
      --id <id>              stable task id (default: slug of --name)
      --model <model>        opus | sonnet | haiku | full model id (default: sonnet)
      --effort <level>       low | medium | high | xhigh | max
      --repo <dir>           git repo to work in (default: the monorepo)
      --base <ref>           worktree start point (default: origin's default branch, fetched first)
      --branch <name>        worktree branch (default: wip/<id>); an existing local branch is checked out as-is
      --cwd <dir>            run in this directory instead of creating a worktree
      --permission-mode <m>  passed through to claude
      --session <name>       tmux session (default: the caller's session)
  agentctl.sh rename <id|@window|%pane> <new-name>
  agentctl.sh ls [--all]                    active tasks; --all includes archived ones
  agentctl.sh note <id> "<text>"            append a dated line to the task's ledger
  agentctl.sh note --standing "<text>"      append an instruction that spans tasks
  agentctl.sh done <id> ["<summary>"]       archive the task (drops out of brief and ls)
  agentctl.sh brief                         standing instructions + active tasks with recent notes
  agentctl.sh coordinator [--model <model>] [--effort <level>] [--name <session-name>]
                          [--compact-window <tokens>]
      Launches the coordinator in the default repo with a SessionStart hook that injects
      `brief` on startup, resume, /clear and compaction (compaction window default: 150000).
EOF
}

die() { echo "agentctl: $*" >&2; exit 1; }

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//' | cut -c1-48 | sed -E 's/-+$//'
}

# automatic-rename is on globally (tab = cwd basename), so a name only sticks with both options off.
name_window() {
  tmux rename-window -t "$1" "$2" \; \
    set-window-option -t "$1" automatic-rename off \; \
    set-window-option -t "$1" allow-rename off
}

# display-message exits 0 even when its target is gone, so existence is checked by listing.
window_exists() { tmux list-windows -a -F '#{window_id}' 2>/dev/null | grep -qxF -- "$1"; }
pane_exists() { tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qxF -- "$1"; }

window_name_or() {
  if window_exists "$1"; then tmux display-message -p -t "$1" '#{window_name}'; else printf '%s' "$2"; fi
}

caller_session() {
  if [[ -n ${TMUX_PANE:-} ]]; then
    tmux display-message -p -t "$TMUX_PANE" '#{session_name}'
  else
    echo twism
  fi
}

update_meta() {
  local file="$1/meta.json" tmp
  shift
  tmp="$(mktemp "$file.XXXXXX")"
  jq "$@" "$file" >"$tmp" && mv "$tmp" "$file"
}

worker_footer() {
  local coordinator="$1" id="$2"
  cat <<EOF

---
## Reporting (appended by the coordinator's spawn script)
- You are a worker session spawned by the coordinator session \`$coordinator\`; your task id is \`$id\`.
- When you finish, get blocked, or need a decision from the user, message the coordinator with the SendMessage tool (deferred: load it via ToolSearch first), \`to: "$coordinator"\`. First line \`[$id] done|blocked|question|progress\`, then 1-3 lines of substance with links (MR, ticket, file paths).
- If SendMessage cannot find \`$coordinator\`, run ListAgents and use the session whose tmux window is named \`coordinator\`.
- The coordinator owns this tmux tab's name; don't rename it.
EOF
}

default_base() {
  git -C "$1" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/trunk
}

cmd_spawn() {
  local name="" brief="" coordinator="" id="" model="sonnet" effort="" repo="$DEFAULT_REPO"
  local base="" branch="" cwd="" permission_mode="" session=""
  while (($#)); do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --brief) brief="$2"; shift 2 ;;
      --coordinator) coordinator="$2"; shift 2 ;;
      --id) id="$2"; shift 2 ;;
      --model) model="$2"; shift 2 ;;
      --effort) effort="$2"; shift 2 ;;
      --repo) repo="$2"; shift 2 ;;
      --base) base="$2"; shift 2 ;;
      --branch) branch="$2"; shift 2 ;;
      --cwd) cwd="$2"; shift 2 ;;
      --permission-mode) permission_mode="$2"; shift 2 ;;
      --session) session="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown spawn option: $1" ;;
    esac
  done
  [[ -n $name ]] || die "--name is required"
  [[ -f $brief ]] || die "--brief must point to an existing file"
  [[ -n $coordinator ]] || die "--coordinator is required (your own ListAgents name)"

  id="${id:-$(slugify "$name")}"
  [[ -n $id ]] || die "could not derive an id from --name; pass --id"
  local task_dir="$TASKS_DIR/$id"
  [[ ! -e $task_dir ]] || die "task '$id' already exists ($task_dir); pass another --id"

  session="${session:-$(caller_session)}"
  repo="$(cd "$repo" && pwd)"
  local mode workdir
  if [[ -n $cwd ]]; then
    mode="cwd"
    workdir="$(cd "$cwd" && pwd)"
  else
    mode="worktree"
    workdir="$repo/.claude/worktrees/$id"
    base="${base:-$(default_base "$repo")}"
    branch="${branch:-wip/$id}"
  fi

  mkdir -p "$task_dir"
  { cat "$brief"; worker_footer "$coordinator" "$id"; } >"$task_dir/brief.md"
  jq -n \
    --arg id "$id" --arg name "$name" --arg model "$model" --arg effort "$effort" \
    --arg repo "$repo" --arg mode "$mode" --arg workdir "$workdir" --arg base "$base" \
    --arg branch "$branch" --arg permissionMode "$permission_mode" --arg session "$session" \
    --arg coordinator "$coordinator" --arg createdAt "$(date -Iseconds)" \
    '{id:$id, name:$name, model:$model, effort:$effort, repo:$repo, mode:$mode, workdir:$workdir,
      base:$base, branch:$branch, permissionMode:$permissionMode, session:$session,
      coordinator:$coordinator, createdAt:$createdAt}' >"$task_dir/meta.json"

  local start_dir="$repo" created window_id pane_id
  if [[ $mode == cwd ]]; then start_dir="$workdir"; fi
  created="$(tmux new-window -d -P -F '#{window_id} #{pane_id}' -t "$session:" -n "$name" \
    -c "$start_dir" -e "COORDINATOR_STATE_DIR=$STATE_DIR" \
    "bash $(printf %q "$SCRIPT_PATH") _run $(printf %q "$id")")"
  window_id="${created% *}"
  pane_id="${created#* }"
  name_window "$window_id" "$name"
  update_meta "$task_dir" --arg w "$window_id" --arg p "$pane_id" '.windowId=$w | .paneId=$p'
  echo "spawned $id -> tab '$name' ($session $window_id $pane_id, $model, $mode: $workdir)"
}

ensure_worktrees_ignored() {
  local repo="$1" exclude
  if git -C "$repo" check-ignore -q .claude/worktrees/probe; then
    return 0
  fi
  exclude="$(git -C "$repo" rev-parse --path-format=absolute --git-path info/exclude)"
  printf '\n.claude/worktrees/\n' >>"$exclude"
  echo "[agentctl] added .claude/worktrees/ to $exclude"
}

setup_worktree() {
  local repo="$1" base="$2" branch="$3" workdir="$4"
  if [[ -d $workdir ]]; then
    echo "[agentctl] reusing existing worktree $workdir"
    return 0
  fi
  ensure_worktrees_ignored "$repo"
  if [[ $base == origin/* ]]; then
    git -C "$repo" fetch origin "${base#origin/}"
  fi
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$repo" worktree add "$workdir" "$branch"
  else
    git -C "$repo" worktree add --no-track -b "$branch" "$workdir" "$base"
  fi
}

# Runs inside the new tab, outside any agent sandbox, so git can write the worktree freely.
cmd_run() {
  local id="$1" task_dir="$TASKS_DIR/$1"
  local meta="$task_dir/meta.json"
  field() { jq -r --arg k "$1" '.[$k] // ""' "$meta"; }
  # A failed write must not abort this script: the tab would close along with it.
  set_phase() { printf '%s\n' "$1" >"$task_dir/phase" 2>/dev/null || true; }
  export PATH="$HOME/.local/bin:$PATH"

  local workdir model effort permission_mode
  workdir="$(field workdir)"
  model="$(field model)"
  effort="$(field effort)"
  permission_mode="$(field permissionMode)"

  if [[ $(field mode) == worktree ]]; then
    set_phase setting-up
    if ! setup_worktree "$(field repo)" "$(field base)" "$(field branch)" "$workdir"; then
      set_phase setup-failed
      echo "[agentctl] worktree setup failed (see above); claude was not started"
      exec "${SHELL:-bash}" -i
    fi
  fi

  cd "$workdir"
  local args=(-n "$id" --model "$model")
  if [[ -n $effort ]]; then args+=(--effort "$effort"); fi
  if [[ -n $permission_mode ]]; then args+=(--permission-mode "$permission_mode"); fi
  set_phase running
  claude "${args[@]}" "Read your task brief at $task_dir/brief.md and carry it out." || true
  set_phase exited
  echo "[agentctl] claude exited; shell left open in $workdir"
  exec "${SHELL:-bash}" -i
}

find_task_by_window() {
  local window_id="$1" meta
  for meta in "$TASKS_DIR"/*/meta.json; do
    [[ -e $meta ]] || continue
    if [[ $(jq -r '.windowId // ""' "$meta") == "$window_id" ]]; then
      dirname "$meta"
      return 0
    fi
  done
}

cmd_rename() {
  (($# == 2)) || die "usage: rename <id|@window|%pane> <new-name>"
  local target="$1" name="$2" window_id task_dir=""
  case "$target" in
    @*) window_id="$target" ;;
    %*)
      pane_exists "$target" || die "pane $target no longer exists"
      window_id="$(tmux display-message -p -t "$target" '#{window_id}')"
      ;;
    *)
      task_dir="$TASKS_DIR/$target"
      [[ -f $task_dir/meta.json ]] || die "no task '$target' in $TASKS_DIR"
      window_id="$(jq -r '.windowId // ""' "$task_dir/meta.json")"
      [[ -n $window_id ]] || die "task '$target' has no window id"
      ;;
  esac
  window_exists "$window_id" || die "window $window_id no longer exists"
  name_window "$window_id" "$name"
  task_dir="${task_dir:-$(find_task_by_window "$window_id")}"
  if [[ -n $task_dir ]]; then
    update_meta "$task_dir" --arg n "$name" '.name=$n'
  fi
  echo "renamed $window_id -> '$name'"
}

task_state() {
  local task_dir="$1" pane_id="$2"
  if ! pane_exists "$pane_id"; then
    echo "closed"
    return
  fi
  cat "$task_dir/phase" 2>/dev/null || echo "starting"
}

is_archived() {
  jq -e '.archivedAt // empty' "$1/meta.json" >/dev/null
}

task_dirs() {
  local include_archived="$1" meta
  for meta in "$TASKS_DIR"/*/meta.json; do
    [[ -e $meta ]] || continue
    if [[ $include_archived == true ]] || ! is_archived "${meta%/meta.json}"; then
      printf '%s\n' "${meta%/meta.json}"
    fi
  done
}

require_task() {
  local task_dir="$TASKS_DIR/$1"
  [[ -f $task_dir/meta.json ]] || die "no task '$1' in $TASKS_DIR"
  printf '%s' "$task_dir"
}

# jq's @tsv would not do: read collapses runs of tabs, so an empty field shifts the rest.
read_task_fields() {
  jq -r '[.id, .name, .model, (.effort // ""), .mode, (.branch // ""), .workdir, .createdAt,
          (.windowId // "-"), (.paneId // "-")] | join("\u001f")' "$1/meta.json"
}

stamp() { date '+%Y-%m-%d %H:%M'; }

cmd_ls() {
  local include_archived=false
  if [[ ${1:-} == --all ]]; then include_archived=true; fi
  local format='%-30s %-6s %-13s %-34s %-7s %s\n' task_dir state
  local id name model effort mode branch workdir created window_id pane_id tab
  printf "$format" ID WINDOW STATE TAB MODEL WORKDIR
  while IFS= read -r task_dir; do
    IFS=$'\x1f' read -r id name model effort mode branch workdir created window_id pane_id \
      < <(read_task_fields "$task_dir")
    tab="$(window_name_or "$window_id" "$name")"
    state="$(task_state "$task_dir" "$pane_id")"
    if is_archived "$task_dir"; then state="archived"; fi
    printf "$format" "$id" "$window_id" "$state" "$tab" "$model" "${workdir/#$HOME/~}"
  done < <(task_dirs "$include_archived")
}

cmd_note() {
  (($# >= 2)) || die 'usage: note <id> "<text>" | note --standing "<text>"'
  local target="$1" file
  shift
  if [[ $target == --standing ]]; then
    file="$STANDING_NOTES"
    mkdir -p "$STATE_DIR"
  else
    file="$(require_task "$target")/notes.md"
  fi
  printf -- '- %s %s\n' "$(stamp)" "$*" >>"$file"
  echo "noted in ${file/#$HOME/~}"
}

cmd_done() {
  (($# >= 1)) || die 'usage: done <id> ["<summary>"]'
  local id="$1" task_dir window_id name
  task_dir="$(require_task "$id")"
  shift
  if (($#)); then printf -- '- %s done: %s\n' "$(stamp)" "$*" >>"$task_dir/notes.md"; fi
  update_meta "$task_dir" --arg at "$(date -Iseconds)" '.archivedAt=$at'
  window_id="$(jq -r '.windowId // ""' "$task_dir/meta.json")"
  if [[ -n $window_id ]] && window_exists "$window_id"; then
    name="$(tmux display-message -p -t "$window_id" '#{window_name}' | sed -E 's/-(blocked|review|done)$//')"
    cmd_rename "$window_id" "$name-done"
  fi
  echo "archived $id"
}

render_task() {
  local task_dir="$1" notes="$1/notes.md" total
  local id name model effort mode branch workdir created window_id pane_id tab
  IFS=$'\x1f' read -r id name model effort mode branch workdir created window_id pane_id \
    < <(read_task_fields "$task_dir")
  tab="$(window_name_or "$window_id" "$name")"
  echo
  echo "### $id"
  echo "tab \`$tab\` ($window_id) | $(task_state "$task_dir" "$pane_id") | $model${effort:+/$effort} | ${branch:-${workdir/#$HOME/~}} | since ${created%%T*}"
  if [[ ! -s $notes ]]; then
    echo "(no notes yet)"
    return
  fi
  total="$(wc -l <"$notes")"
  if ((total > NOTES_PER_TASK)); then
    echo "($((total - NOTES_PER_TASK)) earlier notes in ${notes/#$HOME/~})"
  fi
  tail -n "$NOTES_PER_TASK" "$notes"
}

render_brief() {
  local source="$1" task_dir
  local task_list=()
  mapfile -t task_list < <(task_dirs false)
  echo "# Coordinator ledger (loaded on $source, $(stamp))"
  echo
  echo "This is your state; the conversation may have been cleared or compacted. Keep it current with \`bash ~/.claude/skills/coordinator/scripts/agentctl.sh\`: \`note <id> \"...\"\` for every worker report and user decision, \`note --standing \"...\"\` for instructions that span tasks, \`done <id>\` once a task is finished."
  echo
  echo "## Standing instructions"
  if [[ -s $STANDING_NOTES ]]; then cat "$STANDING_NOTES"; else echo "(none)"; fi
  echo
  echo "## Active tasks (${#task_list[@]})"
  for task_dir in "${task_list[@]}"; do render_task "$task_dir"; done
}

cmd_brief() {
  local source="manual" text
  if [[ ${1:-} == --hook ]]; then
    source="$(jq -r '.source // "startup"' 2>/dev/null || echo startup)"
  fi
  text="$(render_brief "$source")"
  if ((${#text} > BRIEF_LIMIT)); then
    text="${text:0:BRIEF_LIMIT}"$'\n\n[truncated: run `agentctl.sh brief` for the rest]'
  fi
  printf '%s\n' "$text"
}

coordinator_settings() {
  local compact_window="$1"
  jq -n --arg hook "bash $(printf %q "$SCRIPT_PATH") brief --hook" --argjson window "$compact_window" \
    '{autoCompactWindow: $window,
      hooks: {SessionStart: [{matcher: "startup|resume|clear|compact",
                              hooks: [{type: "command", command: $hook}]}]}}'
}

cmd_coordinator() {
  local model="opus" effort="" name="coordinator" compact_window="$COORDINATOR_COMPACT_WINDOW"
  while (($#)); do
    case "$1" in
      --model) model="$2"; shift 2 ;;
      --effort) effort="$2"; shift 2 ;;
      --name) name="$2"; shift 2 ;;
      --compact-window) compact_window="$2"; shift 2 ;;
      *) die "unknown coordinator option: $1" ;;
    esac
  done
  if [[ -n ${TMUX_PANE:-} ]]; then
    name_window "$(tmux display-message -p -t "$TMUX_PANE" '#{window_id}')" "$name"
  fi
  cd "$DEFAULT_REPO"
  local args=(-n "$name" --model "$model" --append-system-prompt "$COORDINATOR_ROLE"
    --settings "$(coordinator_settings "$compact_window")")
  if [[ -n $effort ]]; then args+=(--effort "$effort"); fi
  exec claude "${args[@]}"
}

main() {
  local command="${1:-}"
  (($#)) && shift
  case "$command" in
    spawn) cmd_spawn "$@" ;;
    rename) cmd_rename "$@" ;;
    ls) cmd_ls "$@" ;;
    note) cmd_note "$@" ;;
    done) cmd_done "$@" ;;
    brief) cmd_brief "$@" ;;
    coordinator) cmd_coordinator "$@" ;;
    _settings) coordinator_settings "${1:-$COORDINATOR_COMPACT_WINDOW}" ;;
    _run) cmd_run "$@" ;;
    ""|-h|--help|help) usage ;;
    *) die "unknown command: $command (try --help)" ;;
  esac
}

main "$@"
