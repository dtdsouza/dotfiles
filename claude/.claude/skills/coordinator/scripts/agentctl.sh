#!/usr/bin/env bash
# Worker-tab control for the coordinator skill: spawn, rename, list, the task ledger, and the
# coordinator launcher.
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
PRIMARY_PROFILE=twism
# Every profile but the primary is a shell env file; the vars below are all it may set.
PROFILE_VARS=(COORDINATOR_STATE_DIR COORDINATOR_DEFAULT_REPO AGENTCTL_LABEL AGENTCTL_SESSION AGENTCTL_HARNESS
  AGENTCTL_ALLOWED_HARNESSES AGENTCTL_MODEL AGENTCTL_COORDINATOR_MODEL AGENTCTL_DENY_ROOTS AGENTCTL_KEEP_ENV AGENTCTL_FILE_ROOTS)
PROFILE="${AGENTCTL_PROFILE:-$PRIMARY_PROFILE}"
if [[ ${1:-} == --profile ]]; then
  PROFILE="${2:-}"
  shift 2 || shift
fi
if [[ ! $PROFILE =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
  echo "agentctl: invalid profile name: '$PROFILE'" >&2
  exit 1
fi
PROFILE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/agentctl/profiles/$PROFILE.env"
# A pane of one profile carries that profile's vars; they must never leak into another profile.
if [[ $PROFILE != "${AGENTCTL_PROFILE:-$PRIMARY_PROFILE}" || $PROFILE != "$PRIMARY_PROFILE" ]]; then
  unset "${PROFILE_VARS[@]}"
fi
if [[ -f $PROFILE_FILE ]]; then
  # shellcheck disable=SC1090
  source "$PROFILE_FILE"
elif [[ $PROFILE != "$PRIMARY_PROFILE" ]]; then
  echo "agentctl: no profile '$PROFILE' ($PROFILE_FILE)" >&2
  exit 1
fi
HARNESS="${AGENTCTL_HARNESS:-claude}"
ALLOWED_HARNESSES="${AGENTCTL_ALLOWED_HARNESSES:-$HARNESS}"
PROFILE_SESSION="${AGENTCTL_SESSION:-}"
# An allowlist: every other env var is dropped from the profile's agents. Empty keeps everything.
KEEP_ENV="${AGENTCTL_KEEP_ENV:-}"
DENY_ROOTS="${AGENTCTL_DENY_ROOTS:-}"
DEFAULT_REPO="${COORDINATOR_DEFAULT_REPO:-$HOME/workspace/twism/platform/monorepo}"
# Lives under the coordinator's cwd (DEFAULT_REPO) because the agent sandbox only lets a session
# write inside its cwd.
STATE_DIR="${COORDINATOR_STATE_DIR:-$DEFAULT_REPO/.claude/coordinator}"
TASKS_DIR="$STATE_DIR/tasks"
STANDING_NOTES="$STATE_DIR/notes.md"
# The status page shows every profile and is always generated from the primary profile's ledger.
if [[ $PROFILE == "$PRIMARY_PROFILE" ]]; then
  PRIMARY_STATE_DIR="${AGENTCTL_PRIMARY_STATE_DIR:-$STATE_DIR}"
else
  PRIMARY_STATE_DIR="${AGENTCTL_PRIMARY_STATE_DIR:-$HOME/workspace/twism/platform/monorepo/.claude/coordinator}"
fi
DASHBOARD_FILE="$PRIMARY_STATE_DIR/status.html"
REPORT_RETRIES="${AGENTCTL_REPORT_RETRIES:-40}"
REPORT_RETRY_SECONDS="${AGENTCTL_REPORT_RETRY_SECONDS:-15}"
DASHBOARD_REFRESH_SECONDS=300
# Claude Code keeps at most 10,000 characters of SessionStart hook output in context.
BRIEF_LIMIT=9500
NOTES_PER_TASK=5
# A fresh session already holds ~48k tokens (tools, CLAUDE.md, memory, skills) and auto-compact
# reserves ~33k, so 150k leaves ~70k of conversation between compactions.
COORDINATOR_COMPACT_WINDOW=150000
COORDINATOR_ROLE="You are the coordinator session. The user hands you tasks and initiatives; you delegate each one to a worker Claude session in its own tmux tab and keep track of them in the agentctl ledger. Load the coordinator skill before acting on any request."
CODEX_PLAYBOOK="$(dirname "$(dirname "$SCRIPT_PATH")")/CODEX.md"

usage() {
  cat <<'EOF'
Usage:
  agentctl.sh [--profile <name>] <command> ...
      Profiles other than twism (the default) live in ~/.config/agentctl/profiles/<name>.env;
      AGENTCTL_PROFILE sets the default, and spawned tabs inherit their profile.
  agentctl.sh spawn --name <tab-name> --brief <file> --coordinator <session-name> [options]
      --id <id>              stable task id (default: slug of --name)
      --harness <h>          claude | codex (default: the profile's harness)
      --model <model>        opus | sonnet | haiku | full model id (default: the profile's, else sonnet)
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
  agentctl.sh report <id> done|blocked|question|progress "<text>"
                                            a worker's report: noted in the ledger and typed into its coordinator
  agentctl.sh brief                         standing instructions + active tasks with recent notes
  agentctl.sh dashboard [--watch]           regenerate the status page once; --watch loops every 5 min
  agentctl.sh dashboard --serve             serve the page with actions on 127.0.0.1 (and keep the file fresh)
  agentctl.sh dashboard --ensure            serve it in a `dashboard` tab unless something already serves it (idempotent)
  agentctl.sh dashboard --url [--tailnet]   print the keyed URL that opens the served page (--tailnet: the phone's https URL)
  agentctl.sh resume <id>                   new tmux session in the task's workdir running `claude --resume <id>`
  agentctl.sh adopt-tabs [--dry-run]        one-time: tag every profile's tabs spawned before task tags existed
  agentctl.sh install-jump-handler          register tmuxjump:// links (the page's "Open in terminal" button)
  agentctl.sh up [--no-attach]              after a reboot: per profile, create its tmux session and start its
                                            coordinator if missing, serve the dashboard if nothing does, list
                                            tasks whose tabs are gone (never resumes them), then attach to Twism
  agentctl.sh coordinator [--model <model>] [--effort <level>] [--name <session-name>]
                          [--compact-window <tokens>]
      Launches the coordinator in the default repo with a SessionStart hook that injects
      `brief` on startup, resume, /clear and compaction (compaction window default: 150000).
EOF
}

die() { echo "agentctl: $*" >&2; exit 1; }

self_command() {
  if [[ $PROFILE == "$PRIMARY_PROFILE" ]]; then
    printf 'bash %s' "$SCRIPT_PATH"
  else
    printf 'bash %s --profile %s' "$SCRIPT_PATH" "$PROFILE"
  fi
}

harness_allowed() { [[ " ${ALLOWED_HARNESSES//,/ } " == *" $1 "* ]]; }

# Twism work runs on the Claude subscription only: never through a gateway or another config dir.
guard_primary_env() {
  [[ $PROFILE == "$PRIMARY_PROFILE" ]] || return 0
  [[ -z ${ANTHROPIC_BASE_URL:-} ]] || die "ANTHROPIC_BASE_URL is set; profile $PROFILE only runs on the Claude subscription"
  [[ -z ${CLAUDE_CONFIG_DIR:-} ]] || die "CLAUDE_CONFIG_DIR is set; profile $PROFILE only runs with the default ~/.claude"
}

guard_dir() {
  local dir root
  dir="$(readlink -f "$1")"
  [[ -n $DENY_ROOTS ]] || return 0
  while IFS= read -r root; do
    [[ -n $root ]] || continue
    root="$(readlink -f "$root")"
    if [[ $dir == "$root" || $dir == "$root"/* ]]; then
      die "$dir is under $root, which is not allowed for profile $PROFILE"
    fi
  done < <(tr ':' '\n' <<<"$DENY_ROOTS")
}

scrub_env() {
  local name
  [[ -n $KEEP_ENV ]] || return 0
  while IFS= read -r name; do
    if [[ ! $name =~ $KEEP_ENV ]]; then unset "$name" 2>/dev/null || true; fi
  done < <(compgen -e)
}

# Codex's shell snapshot sources the user's rc files, which would export the work secrets that
# scrub_env just removed; the shared daemon would run commands with the env of whichever Codex
# started it, possibly a work shell.
CODEX_BASE_ARGS=(-s workspace-write -a on-request --no-daemon --disable shell_snapshot)

codex_effort() {
  case "$1" in
    max) echo xhigh ;;
    *) echo "$1" ;;
  esac
}

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

# A task's own tab is the pane tagged with its id and profile (or a legacy pane whose ids, session and
# start time fit its ledger entry); window ids alone recycle with every tmux server.
declare -A TAB_WINDOW=() TAB_PANE=() TAB_SESSION=() TAB_NAME=()
load_tabs() {
  local id window pane session legacy name
  TAB_WINDOW=() TAB_PANE=() TAB_SESSION=() TAB_NAME=()
  while IFS='|' read -r id window pane session legacy name; do
    [[ -n $id ]] || continue
    TAB_WINDOW[$id]="$window" TAB_PANE[$id]="$pane" TAB_SESSION[$id]="$session" TAB_NAME[$id]="$name"
  done < <(node "$(dirname "$SCRIPT_PATH")/task-tabs.cjs" tabs "$STATE_DIR" "$PROFILE" "$PRIMARY_STATE_DIR" "$PROFILE_SESSION" 2>/dev/null)
}

task_owning_window() {
  local id
  for id in "${!TAB_WINDOW[@]}"; do
    if [[ ${TAB_WINDOW[$id]} == "$1" ]]; then
      printf '%s' "$id"
      return 0
    fi
  done
}

tag_task_pane() {
  tmux set-option -p -t "$1" @agentctl-task "$2" \; set-option -p -t "$1" @agentctl-profile "$PROFILE"
}

caller_session() {
  if [[ -n ${TMUX_PANE:-} ]]; then
    tmux display-message -p -t "$TMUX_PANE" '#{session_name}'
  else
    echo twism
  fi
}

# Fire-and-forget: the page is a convenience and must never fail or slow the calling command.
refresh_dashboard() {
  (node "$(dirname "$SCRIPT_PATH")/dashboard.cjs" "$PRIMARY_STATE_DIR" "$DASHBOARD_FILE" </dev/null >/dev/null 2>&1 &) || true
}

update_meta() {
  local file="$1/meta.json" tmp
  shift
  tmp="$(mktemp "$file.XXXXXX")"
  jq "$@" "$file" >"$tmp" && mv "$tmp" "$file"
}

worker_footer() {
  local coordinator="$1" id="$2"
  if [[ $HARNESS != claude ]]; then
    cat <<EOF

---
## Reporting (appended by the coordinator's spawn script)
- You are a worker session spawned by the coordinator of profile \`$PROFILE\`; your task id is \`$id\`.
- When you finish, get blocked, or need a decision from the user, report to the coordinator with
  \`$(self_command) report $id done|blocked|question|progress "<1-3 lines with links and file paths>"\`.
  It notes the ledger and types the report into the coordinator's prompt. Run it on its own, never
  chained with other commands: only that exact form may leave the sandbox to reach the coordinator.
- The coordinator owns this tmux tab's name; don't rename it.
EOF
    return
  fi
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
  local name="" brief="" coordinator="" id="" model="" effort="" repo="$DEFAULT_REPO" harness="$HARNESS"
  local base="" branch="" cwd="" permission_mode="" session=""
  while (($#)); do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --brief) brief="$2"; shift 2 ;;
      --coordinator) coordinator="$2"; shift 2 ;;
      --id) id="$2"; shift 2 ;;
      --model) model="$2"; shift 2 ;;
      --harness) harness="$2"; shift 2 ;;
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
  harness_allowed "$harness" || die "harness $harness is not allowed for profile $PROFILE (allowed: $ALLOWED_HARNESSES)"
  [[ $harness == claude ]] && guard_primary_env
  if [[ -z $model ]]; then
    model="${AGENTCTL_MODEL:-}"
    [[ -n $model || $harness != claude ]] || model=sonnet
  fi

  id="${id:-$(slugify "$name")}"
  [[ -n $id ]] || die "could not derive an id from --name; pass --id"
  local task_dir="$TASKS_DIR/$id"
  [[ ! -e $task_dir ]] || die "task '$id' already exists ($task_dir); pass another --id"

  session="${session:-${PROFILE_SESSION:-$(caller_session)}}"
  local mode workdir
  if [[ -n $cwd ]]; then
    mode="cwd"
    workdir="$(cd "$cwd" && pwd)"
    guard_dir "$workdir"
  else
    repo="$(cd "$repo" && pwd)"
    guard_dir "$repo"
    git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die "$repo is not a git repo; pass --repo <repo> or --cwd <dir>"
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
    --arg profile "$PROFILE" --arg harness "$harness" \
    '{id:$id, name:$name, model:$model, effort:$effort, repo:$repo, mode:$mode, workdir:$workdir,
      base:$base, branch:$branch, permissionMode:$permissionMode, session:$session,
      coordinator:$coordinator, createdAt:$createdAt, profile:$profile, harness:$harness}' >"$task_dir/meta.json"

  local start_dir="$repo" created window_id pane_id
  if [[ $mode == cwd ]]; then start_dir="$workdir"; fi
  created="$(tmux new-window -d -P -F '#{window_id} #{pane_id}' -t "$session:" -n "$name" \
    -c "$start_dir" -e "COORDINATOR_STATE_DIR=$STATE_DIR" -e "AGENTCTL_PROFILE=$PROFILE" \
    "bash $(printf %q "$SCRIPT_PATH") _run $(printf %q "$id")")"
  window_id="${created% *}"
  pane_id="${created#* }"
  tag_task_pane "$pane_id" "$id"
  name_window "$window_id" "$name"
  update_meta "$task_dir" --arg w "$window_id" --arg p "$pane_id" '.windowId=$w | .paneId=$p'
  refresh_dashboard
  echo "spawned $id -> tab '$name' ($session $window_id $pane_id, $harness ${model:-default model}, $mode: $workdir)"
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

  local workdir model effort permission_mode harness
  workdir="$(field workdir)"
  model="$(field model)"
  effort="$(field effort)"
  permission_mode="$(field permissionMode)"
  harness="$(field harness)"
  harness="${harness:-claude}"
  export AGENT_PROFILE="$PROFILE" AGENTCTL_PROFILE="$PROFILE"

  if [[ $(field mode) == worktree ]]; then
    set_phase setting-up
    if ! setup_worktree "$(field repo)" "$(field base)" "$(field branch)" "$workdir"; then
      set_phase setup-failed
      echo "[agentctl] worktree setup failed (see above); claude was not started"
      exec "${SHELL:-bash}" -i
    fi
  fi

  cd "$workdir"
  local prompt="Read your task brief at $task_dir/brief.md and carry it out."
  set_phase running
  if [[ $harness == codex ]]; then
    scrub_env
    local args=(-C "$workdir" "${CODEX_BASE_ARGS[@]}")
    if [[ -n $model ]]; then args+=(-m "$model"); fi
    if [[ -n $effort ]]; then args+=(-c "model_reasoning_effort=\"$(codex_effort "$effort")\""); fi
    codex "${args[@]}" "$prompt" || true
  else
    local args=(-n "$id" --model "$model")
    if [[ -n $effort ]]; then args+=(--effort "$effort"); fi
    if [[ -n $permission_mode ]]; then args+=(--permission-mode "$permission_mode"); fi
    claude "${args[@]}" "$prompt" || true
  fi
  set_phase exited
  echo "[agentctl] claude exited; shell left open in $workdir"
  exec "${SHELL:-bash}" -i
}

cmd_rename() {
  (($# == 2)) || die "usage: rename <id|@window|%pane> <new-name>"
  local target="$1" name="$2" window_id id=""
  load_tabs
  case "$target" in
    @*) window_id="$target" ;;
    %*)
      pane_exists "$target" || die "pane $target no longer exists"
      window_id="$(tmux display-message -p -t "$target" '#{window_id}')"
      ;;
    *)
      require_task "$target" >/dev/null
      id="$target"
      window_id="${TAB_WINDOW[$id]:-}"
      [[ -n $window_id ]] || die "task '$id' has no open tab of its own; nothing renamed"
      ;;
  esac
  window_exists "$window_id" || die "window $window_id no longer exists"
  name_window "$window_id" "$name"
  id="${id:-$(task_owning_window "$window_id")}"
  if [[ -n $id ]]; then
    update_meta "$TASKS_DIR/$id" --arg n "$name" '.name=$n'
  fi
  refresh_dashboard
  echo "renamed $window_id -> '$name'"
}

# Reads TAB_PANE, so callers run load_tabs first.
task_state() {
  local task_dir="$1" id="$2"
  if [[ -z ${TAB_PANE[$id]:-} ]]; then
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

REVIEWS_FILE="${COORDINATOR_DASHBOARD_REVIEWS_FILE:-$HOME/.local/state/mr-review-autoloop/pending.json}"

# mr-review-autoloop reviews waiting on the user's approve decision, one line each. The MR title is
# left out on purpose: the MR author writes it, and this text lands in the coordinator's context.
pending_review_lines() {
  [[ $PROFILE == "$PRIMARY_PROFILE" && -r $REVIEWS_FILE ]] || return 0
  jq -r '
    def known($set): if (. as $v | $set | index($v)) then . else "UNKNOWN" end;
    (.reviews // [])[]
    | select((.ref | type) == "string" and (.ref | test("^[A-Za-z0-9._/-]+![0-9]+$")))
    | "- \(.ref) (\(.tier | tostring | known(["T0","T1","T2","T3"])), verdict \(.verdict | tostring | known(["BLOCK_MERGE","REQUEST_CHANGES","APPROVE_WITH_NITS","APPROVE"]))\(if .dry_run then ", dry run" else "" end))"
      + (if (.url | type) == "string" and (.url | test("^https://[A-Za-z0-9.-]+/[A-Za-z0-9._/-]+/-/merge_requests/[0-9]+$")) then " \(.url)" else "" end)
  ' "$REVIEWS_FILE" 2>/dev/null || true
}

cmd_ls() {
  local include_archived=false
  if [[ ${1:-} == --all ]]; then include_archived=true; fi
  local format='%-30s %-6s %-13s %-34s %-7s %s\n' task_dir state
  local id name model effort mode branch workdir created window_id pane_id
  load_tabs
  printf "$format" ID WINDOW STATE TAB MODEL WORKDIR
  while IFS= read -r task_dir; do
    IFS=$'\x1f' read -r id name model effort mode branch workdir created window_id pane_id \
      < <(read_task_fields "$task_dir")
    state="$(task_state "$task_dir" "$id")"
    if is_archived "$task_dir"; then state="archived"; fi
    printf "$format" "$id" "${TAB_WINDOW[$id]:--}" "$state" "${TAB_NAME[$id]:-$name}" "$model" "${workdir/#$HOME/~}"
  done < <(task_dirs "$include_archived")
  local reviews
  reviews="$(pending_review_lines)"
  if [[ -n $reviews ]]; then printf '\nReviews waiting on you (mr-review-autoloop):\n%s\n' "$reviews"; fi
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
  refresh_dashboard
  echo "noted in ${file/#$HOME/~}"
}

cmd_done() {
  (($# >= 1)) || die 'usage: done <id> ["<summary>"]'
  local id="$1" task_dir name
  task_dir="$(require_task "$id")"
  shift
  if (($#)); then printf -- '- %s done: %s\n' "$(stamp)" "$*" >>"$task_dir/notes.md"; fi
  update_meta "$task_dir" --arg at "$(date -Iseconds)" '.archivedAt=$at'
  load_tabs
  if [[ -n ${TAB_WINDOW[$id]:-} ]]; then
    name="$(sed -E 's/-(blocked|review|done)$//' <<<"${TAB_NAME[$id]}")"
    cmd_rename "$id" "$name-done"
  fi
  refresh_dashboard
  echo "archived $id"
}

cmd_report() {
  (($# >= 3)) || die 'usage: report <id> done|blocked|question|progress "<text>"'
  local id="$1" kind="$2" task_dir text
  shift 2
  [[ $kind =~ ^(done|blocked|question|progress)$ ]] || die "report kind must be done|blocked|question|progress, not '$kind'"
  task_dir="$(require_task "$id")"
  text="$*"
  # Inside Codex's sandbox a chained command can reach neither tmux nor the ledger; refuse before
  # writing anything so the rerun doesn't note it twice.
  tmux list-sessions >/dev/null 2>&1 ||
    die "can't reach tmux (sandboxed?); run this report again as a command on its own: $(self_command) report $id $kind \"$text\""
  printf -- '- %s [%s] %s\n' "$(stamp)" "$kind" "$text" >>"$task_dir/notes.md"
  refresh_dashboard
  deliver_report "[$id] $kind: $text"
}

# The coordinator may be showing a dialog; the note is already in the ledger, so delivery retries
# in the background and never fails the worker's command.
deliver_report() {
  local sender message="$1"
  sender="$(dirname "$SCRIPT_PATH")/coordinator-send.cjs"
  if node "$sender" "$PRIMARY_STATE_DIR" "$PROFILE" "$message"; then
    echo "reported to the $PROFILE coordinator"
    return 0
  fi
  if ((REPORT_RETRIES > 0)); then
    (
      for ((i = 0; i < REPORT_RETRIES; i++)); do
        sleep "$REPORT_RETRY_SECONDS"
        node "$sender" "$PRIMARY_STATE_DIR" "$PROFILE" "$message" >/dev/null 2>&1 && exit 0
      done
    ) </dev/null >/dev/null 2>&1 &
    disown
    echo "noted in the ledger; the coordinator can't take input right now, retrying for $((REPORT_RETRIES * REPORT_RETRY_SECONDS))s"
  else
    echo "noted in the ledger; the coordinator didn't get it (it reads the ledger brief on its next reset)"
  fi
}

dashboard_serving() {
  local port="${COORDINATOR_DASHBOARD_PORT:-47317}"
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
}

# Idempotent: a no-op while something listens on the dashboard port. Opens a `dashboard` window in the
# given session (default: the caller's) otherwise; the session is created if the tmux server lacks it.
ensure_dashboard() {
  local session="${1:-$(caller_session)}" env_args=() window command
  if dashboard_serving; then
    echo "dashboard already serving on 127.0.0.1:${COORDINATOR_DASHBOARD_PORT:-47317}"
    return 0
  fi
  mapfile -t env_args < <(passthrough_env_args)
  command="bash $(printf %q "$SCRIPT_PATH") dashboard --serve; exec \${SHELL:-bash} -i"
  if tmux has-session -t "=$session" 2>/dev/null; then
    window="$(tmux new-window -d -P -F '#{window_id}' -t "=$session:" -n dashboard -c "$DEFAULT_REPO" "${env_args[@]}" "$command")"
  else
    window="$(tmux new-session -d -P -F '#{window_id}' -s "$session" -n dashboard -c "$DEFAULT_REPO" "${env_args[@]}" "$command")"
  fi
  name_window "$window" dashboard
  echo "dashboard: started in session $session ($window)"
}

cmd_dashboard() {
  local generator server
  [[ $PROFILE == "$PRIMARY_PROFILE" ]] || die "the dashboard serves every profile; run it without --profile"
  generator="$(dirname "$SCRIPT_PATH")/dashboard.cjs"
  server="$(dirname "$SCRIPT_PATH")/dashboard-server.cjs"
  case "${1:-}" in
    "") node "$generator" "$STATE_DIR" "$DASHBOARD_FILE" ;;
    --serve)
      DASHBOARD_REFRESH_SECONDS="$DASHBOARD_REFRESH_SECONDS" exec node "$server" "$STATE_DIR" "$DASHBOARD_FILE"
      ;;
    --ensure) ensure_dashboard ;;
    --url) exec node "$server" --print-url "${2:-}" ;;
    --watch)
      echo "[agentctl] regenerating file://$DASHBOARD_FILE every ${DASHBOARD_REFRESH_SECONDS}s (ctrl-c to stop)"
      while true; do
        node "$generator" "$STATE_DIR" "$DASHBOARD_FILE" || echo "[agentctl] dashboard generation failed"
        sleep "$DASHBOARD_REFRESH_SECONDS"
      done
      ;;
    *) die "usage: dashboard [--watch|--serve|--ensure|--url [--tailnet]]" ;;
  esac
  [[ -z ${1:-} ]] && echo "file://$DASHBOARD_FILE"
  return 0
}

cmd_resume() {
  (($# == 1)) || die "usage: resume <id>"
  local id="$1" task_dir workdir
  export PATH="$HOME/.local/bin:$PATH"
  task_dir="$(require_task "$id")"
  [[ $(jq -r '.harness // "claude"' "$task_dir/meta.json") == claude ]] || die "resume only handles Claude tasks for now; run \`codex resume\` in the task's workdir"
  load_tabs
  if [[ -n ${TAB_WINDOW[$id]:-} ]]; then
    die "task '$id' still has its tab open (${TAB_SESSION[$id]}:${TAB_WINDOW[$id]}); switch to it instead of resuming"
  fi
  workdir="$(jq -r '.workdir // ""' "$task_dir/meta.json")"
  if [[ ! -d $workdir ]]; then
    echo "agentctl: workdir of '$id' is gone ($workdir); its session can't be resumed from here" >&2
    [[ -t 0 ]] && read -rp "press enter to close"
    exit 1
  fi
  exec tmux new-session -A -s "resume-$id" -c "$workdir" "claude --resume $(printf %q "$id")"
}

cmd_adopt_tabs() {
  [[ $PROFILE == "$PRIMARY_PROFILE" ]] || die "adopt-tabs covers every profile; run it without --profile"
  [[ -z ${1:-} || $1 == --dry-run ]] || die "usage: adopt-tabs [--dry-run]"
  node "$(dirname "$SCRIPT_PATH")/task-tabs.cjs" adopt "$PRIMARY_STATE_DIR" ${1:+"$1"}
  [[ -n ${1:-} ]] || refresh_dashboard
}

cmd_install_jump_handler() {
  local apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  local desktop_file="$apps_dir/tmuxjump.desktop" jump_script
  jump_script="$(dirname "$SCRIPT_PATH")/tmux-jump.sh"
  mkdir -p "$apps_dir"
  cat >"$desktop_file" <<DESKTOP
[Desktop Entry]
Type=Application
Name=tmux jump
Exec=$jump_script %u
NoDisplay=true
Terminal=false
MimeType=x-scheme-handler/tmuxjump;
DESKTOP
  xdg-mime default tmuxjump.desktop x-scheme-handler/tmuxjump
  update-desktop-database "$apps_dir" 2>/dev/null || true
  echo "registered tmuxjump:// -> $jump_script"
}

# Reads TAB_*, so callers run load_tabs first.
render_task() {
  local task_dir="$1" notes="$1/notes.md" total
  local id name model effort mode branch workdir created window_id pane_id
  IFS=$'\x1f' read -r id name model effort mode branch workdir created window_id pane_id \
    < <(read_task_fields "$task_dir")
  echo
  echo "### $id"
  echo "tab \`${TAB_NAME[$id]:-$name}\` (${TAB_WINDOW[$id]:--}) | $(task_state "$task_dir" "$id") | $model${effort:+/$effort} | ${branch:-${workdir/#$HOME/~}} | since ${created%%T*}"
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
  load_tabs
  echo "# Coordinator ledger (profile $PROFILE, loaded on $source, $(stamp))"
  echo
  echo "This is your state; the conversation may have been cleared or compacted. Keep it current with \`$(self_command)\`: \`note <id> \"...\"\` for every worker report and user decision, \`note --standing \"...\"\` for instructions that span tasks, \`done <id>\` once a task is finished."
  echo
  echo "## Standing instructions"
  if [[ -s $STANDING_NOTES ]]; then cat "$STANDING_NOTES"; else echo "(none)"; fi
  echo
  echo "## Active tasks (${#task_list[@]})"
  for task_dir in "${task_list[@]}"; do render_task "$task_dir"; done
  local reviews
  reviews="$(pending_review_lines)"
  if [[ -n $reviews ]]; then
    echo
    echo "## MR reviews waiting on the user (mr-review-autoloop)"
    echo "Record a decision only when the user's own message names the MR; see the coordinator skill."
    printf '%s\n' "$reviews"
  fi
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

# The served dashboard types into the pane carrying this option, so exactly one pane per profile may
# hold it. A marked pane without a profile option predates profiles and belongs to the primary.
mark_coordinator_pane() {
  local pane role profile
  while IFS='|' read -r pane role profile; do
    if [[ $role == coordinator && $pane != "$1" && ${profile:-$PRIMARY_PROFILE} == "$PROFILE" ]]; then
      tmux set-option -p -u -t "$pane" @agentctl-role \; set-option -p -u -t "$pane" @agentctl-profile
    fi
  done < <(tmux list-panes -a -F '#{pane_id}|#{@agentctl-role}|#{@agentctl-profile}')
  tmux set-option -p -t "$1" @agentctl-role coordinator \; set-option -p -t "$1" @agentctl-profile "$PROFILE"
}

# New panes in the profile's session start without the scrubbed vars, whatever env the tmux server
# was started with, and know their profile.
prepare_session_env() {
  local session="$1" name
  tmux set-environment -t "$session" AGENT_PROFILE "$PROFILE" \; set-environment -t "$session" AGENTCTL_PROFILE "$PROFILE"
  [[ -n $KEEP_ENV ]] || return 0
  while IFS= read -r name; do
    if [[ ! $name =~ $KEEP_ENV ]]; then tmux set-environment -t "$session" -r "$name"; fi
  done < <({ compgen -e; tmux show-environment -g | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'; } | sort -u)
}

codex_coordinator_prompt() {
  printf '%s\n\n' "You are the coordinator session of the ${AGENTCTL_LABEL:-$PROFILE} profile. The user hands you tasks; you delegate each one to a worker Codex session in its own tmux tab and keep track of them in the agentctl ledger. Read your playbook at $CODEX_PLAYBOOK before acting on any request. Run every agentctl command as \`$(self_command) <command>\`."
  render_brief startup
}

cmd_coordinator() {
  local model="${AGENTCTL_COORDINATOR_MODEL:-}" effort="" name="coordinator" compact_window="$COORDINATOR_COMPACT_WINDOW"
  while (($#)); do
    case "$1" in
      --model) model="$2"; shift 2 ;;
      --effort) effort="$2"; shift 2 ;;
      --name) name="$2"; shift 2 ;;
      --compact-window) compact_window="$2"; shift 2 ;;
      *) die "unknown coordinator option: $1" ;;
    esac
  done
  [[ $HARNESS == claude ]] && guard_primary_env
  export PATH="$HOME/.local/bin:$PATH"
  if [[ -n ${TMUX_PANE:-} ]]; then
    name_window "$(tmux display-message -p -t "$TMUX_PANE" '#{window_id}')" "$name"
    mark_coordinator_pane "$TMUX_PANE"
    [[ $PROFILE == "$PRIMARY_PROFILE" ]] || prepare_session_env "$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}')"
  fi
  # The dashboard serves every profile and refuses --profile, so only the primary profile's launch starts it.
  if [[ -n ${TMUX_PANE:-} && $PROFILE == "$PRIMARY_PROFILE" ]]; then
    ensure_dashboard "$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}')" >&2 || true
  fi
  cd "$DEFAULT_REPO"
  if [[ $HARNESS == codex ]]; then
    local prompt
    prompt="$(codex_coordinator_prompt)"
    scrub_env
    export AGENT_PROFILE="$PROFILE" AGENTCTL_PROFILE="$PROFILE"
    local codex_args=(-C "$DEFAULT_REPO" "${CODEX_BASE_ARGS[@]}")
    if [[ -n $model ]]; then codex_args+=(-m "$model"); fi
    if [[ -n $effort ]]; then codex_args+=(-c "model_reasoning_effort=\"$(codex_effort "$effort")\""); fi
    exec codex "${codex_args[@]}" "$prompt"
  fi
  model="${model:-opus}"
  local args=(-n "$name" --model "$model" --append-system-prompt "$COORDINATOR_ROLE"
    --settings "$(coordinator_settings "$compact_window")")
  if [[ -n $effort ]]; then args+=(--effort "$effort"); fi
  exec claude "${args[@]}"
}

profile_names() {
  local file
  for file in "${XDG_CONFIG_HOME:-$HOME/.config}"/agentctl/profiles/*.env; do
    [[ -e $file ]] || continue
    file="$(basename "$file" .env)"
    [[ $file =~ ^[a-z0-9][a-z0-9-]{0,31}$ && $file != "$PRIMARY_PROFILE" ]] && printf '%s\n' "$file"
  done
}

other_profile_sessions() {
  local file
  for file in "${XDG_CONFIG_HOME:-$HOME/.config}"/agentctl/profiles/*.env; do
    [[ -e $file && $(basename "$file" .env) != "$PROFILE" ]] || continue
    sed -n "s/^AGENTCTL_SESSION=['\"]\{0,1\}\([^'\"]*\).*/\1/p" "$file"
  done
}

# The profile's coordinator pane: marked with its role and profile (no profile = the primary), or for
# the primary an unmarked window named `coordinator` outside every other profile's session, the same
# rule the dashboard uses.
find_coordinator_pane() {
  local pane session window role profile others
  others=" $(other_profile_sessions | tr '\n' ' ') "
  local fallback=""
  while IFS='|' read -r pane session window role profile; do
    if [[ $role == coordinator && ${profile:-$PRIMARY_PROFILE} == "$PROFILE" ]]; then
      printf '%s' "$pane"
      return 0
    fi
    if [[ -z $fallback && $PROFILE == "$PRIMARY_PROFILE" && -z $role && $window == coordinator && $others != *" $session "* ]]; then
      fallback="$pane"
    fi
  done < <(tmux list-panes -a -F '#{pane_id}|#{session_name}|#{window_name}|#{@agentctl-role}|#{@agentctl-profile}' 2>/dev/null)
  printf '%s' "$fallback"
}

# Vars a tab started by tmux would otherwise miss: the server's env predates them.
passthrough_env_args() {
  local name
  for name in COORDINATOR_STATE_DIR COORDINATOR_DEFAULT_REPO COORDINATOR_DASHBOARD_PORT COORDINATOR_DASHBOARD_TAILNET \
    COORDINATOR_DASHBOARD_FILE_ROOTS AGENTCTL_PRIMARY_STATE_DIR XDG_CONFIG_HOME XDG_STATE_HOME; do
    if [[ -n ${!name:-} ]]; then printf -- '-e\n%s=%s\n' "$name" "${!name}"; fi
  done
}

# Reads TAB_*, so callers run load_tabs first.
list_lost_tabs() {
  local task_dir id harness
  while IFS= read -r task_dir; do
    id="$(jq -r '.id' "$task_dir/meta.json")"
    harness="$(jq -r '.harness // "claude"' "$task_dir/meta.json")"
    [[ -n ${TAB_WINDOW[$id]:-} ]] && continue
    if [[ $harness == claude ]]; then
      echo "  $id: $(self_command) resume $id"
    else
      echo "  $id: codex resume (in $(jq -r '.workdir' "$task_dir/meta.json"))"
    fi
  done < <(task_dirs false)
}

# One profile's part of `up`; prints `session=<name>` last so the caller knows where it lives.
cmd_up_profile() {
  local pane session env_args=() lost id
  mapfile -t env_args < <(passthrough_env_args)
  load_tabs
  pane="$(find_coordinator_pane)"
  if [[ -n $pane ]]; then
    session="$(tmux display-message -p -t "$pane" '#{session_name}')"
    echo "$PROFILE: coordinator already running in session $session ($pane)"
  else
    session="$PROFILE_SESSION"
    if [[ -z $session && $PROFILE == "$PRIMARY_PROFILE" ]]; then
      # Twism tabs may live in a session with another name (`0`); reuse it rather than adding one.
      while IFS= read -r id; do
        id="$(basename "$id")"
        if [[ -n ${TAB_SESSION[$id]:-} ]]; then
          session="${TAB_SESSION[$id]}"
          break
        fi
      done < <(task_dirs false)
    fi
    session="${session:-$PROFILE}"
    local command="bash $(printf %q "$SCRIPT_PATH") --profile $PROFILE coordinator"
    if tmux has-session -t "=$session" 2>/dev/null; then
      tmux new-window -d -t "=$session:" -n coordinator -c "$DEFAULT_REPO" "${env_args[@]}" "$command"
    else
      tmux new-session -d -s "$session" -n coordinator -c "$DEFAULT_REPO" "${env_args[@]}" "$command"
    fi
    echo "$PROFILE: started the coordinator in session $session"
  fi
  tmux set-environment -t "=$session" AGENT_PROFILE "$PROFILE" \; set-environment -t "=$session" AGENTCTL_PROFILE "$PROFILE"
  [[ $PROFILE == "$PRIMARY_PROFILE" ]] || prepare_session_env "=$session"
  lost="$(list_lost_tabs)"
  if [[ -n $lost ]]; then
    echo "$PROFILE: tasks whose tabs are gone (resume by hand if needed):"
    echo "$lost"
  fi
  echo "session=$session"
}

cmd_up() {
  local attach=true output twism_session name
  [[ ${1:-} == --no-attach ]] && attach=false
  [[ $PROFILE == "$PRIMARY_PROFILE" ]] || die "up starts every profile; run it without --profile"
  output="$(cmd_up_profile)"
  grep -v '^session=' <<<"$output"
  twism_session="$(sed -n 's/^session=//p' <<<"$output")"
  while IFS= read -r name; do
    output="$(bash "$SCRIPT_PATH" --profile "$name" _up_profile)" || { echo "$name: up failed"; continue; }
    grep -v '^session=' <<<"$output"
  done < <(profile_names)
  ensure_dashboard "$twism_session"
  echo "attach: tmux attach -t =$twism_session"
  $attach || return 0
  if [[ -n ${TMUX:-} ]]; then
    tmux switch-client -t "=$twism_session"
  else
    exec tmux attach -t "=$twism_session"
  fi
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
    report) cmd_report "$@" ;;
    brief) cmd_brief "$@" ;;
    dashboard) cmd_dashboard "$@" ;;
    resume) cmd_resume "$@" ;;
    adopt-tabs) cmd_adopt_tabs "$@" ;;
    install-jump-handler) cmd_install_jump_handler ;;
    up) cmd_up "$@" ;;
    _up_profile) cmd_up_profile ;;
    coordinator) cmd_coordinator "$@" ;;
    _settings) coordinator_settings "${1:-$COORDINATOR_COMPACT_WINDOW}" ;;
    _run) cmd_run "$@" ;;
    ""|-h|--help|help) usage ;;
    *) die "unknown command: $command (try --help)" ;;
  esac
}

main "$@"
