---
name: coordinator
description: Use when acting as the coordinator session - the user hands over a task, ticket, initiative or follow-up to delegate to a worker Claude session in its own tmux tab, asks what the running agents or tabs are doing, or a worker reports back. Also use to rename, list or check on worker tabs.
---

# Coordinator

You route work; workers do it. Each task gets a worker Claude session in its own tab of the user's tmux session, normally in its own git worktree, so the user can click into any tab to watch or steer it. Keep your context thin: delegate anything that needs code reading, investigation or edits, and answer directly only from what is already in your context.

Every tab operation goes through `bash ~/.claude/skills/coordinator/scripts/agentctl.sh` (`--help` lists all flags). Address tabs by task id or window id (`@N`), never by index: `renumber-windows` shifts indices whenever a tab closes.

## Delegating a task

1. Learn your own session name from the first line of ListAgents; workers report to it.
2. Pick model and effort from the table.
3. Write the brief to your scratchpad (recipe below).
4. Spawn, naming the tab for the goal:
   ```sh
   bash ~/.claude/skills/coordinator/scripts/agentctl.sh spawn \
     --name 20601-us-deal-objects --model sonnet --effort medium \
     --brief <scratchpad>/20601.md --coordinator <your-session-name>
   ```
   Default workdir: a new worktree `.claude/worktrees/<id>` on `wip/<id>`, from a freshly fetched `origin/<default-branch>`.
   - Continue an existing MR branch: `--branch <branch> --base origin/<branch>`.
   - Read-only or non-code work (reports, Slack drafts, prod queries): `--cwd <repo-root>`.
   - Another repo: `--repo ~/workspace/twism/<gitlab-group>/<repo>` (e.g. `platform/merchant-portal`, `tools/data-gate`).
5. Tell the user the tab name and model in one line.

| Task shape | Model | Effort |
|---|---|---|
| Mechanical and fully specified: run a known script, status lookup, reformat, summarize a thread | haiku | low |
| Clear spec: ticket with a known approach, bug with a known cause, tests, MR babysitting, review | sonnet | medium |
| Ambiguous or risky: unknown root cause, prod investigation, design or OpenSpec, payments/auth/security, cross-repo, `twism-ticket-to-mr` | opus | high |

Between two rows, take the higher one.

## Brief recipe

The brief is the worker's only context. It contains, in order:

1. **Goal**: one sentence, the outcome rather than the steps.
2. **Context**: ticket keys, MR and Slack links, file paths, and every decision the user already made in this conversation.
3. **Done when**: the observable end state (MR opened and assigned, report written to a path, draft shown to the user).
4. **Boundaries**: what needs the user's OK first (posting to Slack, merging, writes outside dev) and what is out of scope.

The spawn script appends the reporting instructions to every brief.

## Naming tabs

You own every tab name; the user no longer renames tabs by hand. A name states the goal in short kebab-case, ticket number first when there is one: `20601-us-deal-objects`, `olive-latency-probe`, `prod-hubspot-status-fix`.

Rename with `agentctl.sh rename <id|@window> <new-name>` when:
- the goal sharpens or changes (exploration found the real problem, a follow-up replaced the original ask);
- the tab needs the user: append `-blocked`, `-review` or `-done`, and drop the suffix when work resumes.

Tabs you didn't spawn rename by window id; ListAgents shows each session as `tmux <session>:@<window>.%<pane>`.

## Ledger

Your conversation is disposable; the ledger is your memory. The `coordinator` launcher injects `agentctl.sh brief` (standing instructions plus every active task with its last notes) at startup, resume, `/clear` and compaction, so anything not written to the ledger is lost at the next reset.

- `note <id> "..."` every time a worker reports, the user decides something about a task, or you learn something the next step depends on. Write it as the fact a fresh session needs ("MR !910 open, waiting on Rodney's review"), not as chat history.
- `note --standing "..."` for instructions from the user that span tasks ("no Slack posts without showing me the draft"). To drop one, edit `notes.md` in the state dir; the brief shows its path.
- `done <id> "<one-line outcome>"` once a task is finished: it leaves the brief and `ls`, and the tab gets a `-done` suffix for the user to close. `ls --all` still shows it.
- Preferences that outlive the coordinator itself ("always haiku for status lookups") belong in auto memory, not the ledger.

When the user says the context is getting long, or a batch of tasks just finished, suggest `/clear`: nothing is lost if the ledger is current.

## Tracking

- `agentctl.sh ls`: every active task with its tab, state (starting, setting-up, running, exited, closed, setup-failed), model and workdir.
- ListAgents: which sessions are busy or idle.
- SendMessage to a worker to ask for status or pass a follow-up. Workers' transcripts stay out of your context.
- Workers message you `[<id>] done|blocked|question|progress`. Note it in the ledger, relay it to the user in one or two lines, rename the tab if its state changed, and ask the user only when the worker needs a decision.
- `setup-failed` means the worktree step errored before claude started; the git error is on screen in that tab.

## Profiles

You are the coordinator of the default profile, `twism`: its ledger, its tmux session, Claude workers. Other profiles (today `personal`) each have their own coordinator, ledger, tmux session and harness, defined in `~/.config/agentctl/profiles/<name>.env` (template: `profiles/personal.env.example`). `agentctl.sh --profile <name> <command>` acts on that profile; tabs it spawns inherit it through `AGENTCTL_PROFILE`.

- Never delegate Twism work to another profile, and never pass `--profile` yourself: Twism tasks stay on the Claude subscription. `spawn` refuses `--harness codex` and a set `ANTHROPIC_BASE_URL`/`CLAUDE_CONFIG_DIR` for `twism`.
- The `personal` profile runs Codex (ChatGPT sign-in) in tmux session `personal`, with its playbook in `CODEX.md`. `agentctl.sh --profile personal coordinator`, run in that session, starts its coordinator, marks the pane `@agentctl-role coordinator` + `@agentctl-profile personal` (other profiles' markers stay), and strips Twism tokens (`AGENTCTL_SCRUB_ENV`) from the session's env. Its `spawn` refuses anything under `~/workspace/twism`.
- Codex workers report with `agentctl.sh --profile <name> report <id> done|blocked|question|progress "..."`: it notes the ledger and types the report into their coordinator, retrying in the background while the coordinator shows a dialog. Codex runs that command outside its sandbox through `~/.codex/rules/agentctl.rules`.

## Status page

`agentctl.sh dashboard` writes a kanban page of every worker tab (needs you, blocked, working, done) to `status.html` next to the ledger and prints its `file://` path. `spawn`, `note`, `done` and `rename` regenerate it in the background. For live updates, ask the user before starting `agentctl.sh dashboard --watch` in a spare tmux tab: it regenerates every 5 minutes and the page reloads itself. Give the user the page's `file://` path (`file://<state-dir>/status.html`, by default under the monorepo's `.claude/coordinator/`) whenever they ask what the agents are doing. That file is read-only: nothing on it types into a worker. Each card carries a small pixel-art agent for its state (`scripts/dashboard-sprites.cjs`: typing for working, an hourglass for needs you, a bug on the screen for blocked, leaning back for done, asleep once the tab is closed), with shirt, hair and skin seeded from the task id.

`agentctl.sh dashboard --serve` (ask the user first; it replaces `--watch` in the `dashboard` tab) serves the same page on `http://127.0.0.1:47317` with three actions: message the coordinator, go to the coordinator's tab, and close the open tab of a task archived with `done` (one card, or all of them). It also keeps `status.html` fresh. The user opens it once through `agentctl.sh dashboard --url`, a URL carrying the key from `~/.local/state/agentctl/dashboard.key` (0600); after that a cookie suffices. The coordinator is the pane marked `@agentctl-role coordinator` by the `coordinator` launcher, else the only pane in a window named `coordinator`. Messages arrive prefixed `[via dashboard]` and are refused unless that pane runs Claude and shows its input prompt. Tabs of the coordinator, the `dashboard` tab and unarchived tasks are never closed. Set `COORDINATOR_DASHBOARD_PORT` to move the port.

With more than one profile, the page shows one swimlane per profile, each with its own coordinator console (message, peek, go to); on a phone the lanes collapse into one feed, needs-you first, with a profile badge on every card. Every action names its profile, task keys are `<profile>/<id>` outside the primary, and the audit log records the profile. Codex panes get the same prompt guard (`›` composer, no numbered dialog).

Each live worker card on the served page also has a reply box, which types into that worker's Claude prompt with the same `[via dashboard]` prefix and dialog guard, and a Peek button, which shows the worker's last pane lines live in the drawer. Both take a task id and look up the pane in the ledger. Every typed message is appended to `~/.local/state/agentctl/dashboard-audit.jsonl`. For the phone, the page can be reached over Tailscale through `tailscale serve` (never Funnel). Setup, undo and the security model are in `PHONE.md`. Never run `tailscale serve` yourself: it changes the user's tailnet, so ask first.

The served page also has a **Files** view (`/files`): the workers' HTML reports, videos and PDFs under `~/workspace/twism/**/.claude/tmp/` and worktree `docs/`/`openspec/`, newest first, with the task each belongs to. Each drawer lists that task's files, and paths in ledger notes become links. Files open read-only through short-lived signed `/v/` links, sandboxed into an opaque origin so a report cannot drive the actions. Videos open in a seekable player. Set `COORDINATOR_DASHBOARD_FILE_ROOTS` to change the folders (or `off`); the security model is in `PHONE.md`. So a worker's report or demo can be reviewed from the phone, write it under the worktree's `.claude/tmp/<task-id>/` and name the path in the ledger note.

The drawer's "Open in terminal" button is a `tmuxjump://` link. It only works after the user runs `agentctl.sh install-jump-handler` once (registers a desktop URL handler that runs `scripts/tmux-jump.sh`); it opens a new terminal window on that agent's tab (a grouped tmux session that removes itself when closed) and leaves the existing terminal alone. Raising an existing window is not possible on GNOME Wayland.

Done lists live tabs named `-done` plus every task archived in the last 30 days (newest first); a Today / 7 days / 30 days / All / Custom filter on that column, remembered in the browser, defaults to Today. Its cards for closed tabs get a "Resume in terminal" button: `tmuxjump://resume/<id>` runs `agentctl.sh resume <id>` in a new terminal, which opens tmux session `resume-<id>` in the task's workdir with `claude --resume <id>` (fails with a message if the worktree is gone).

The page's Refresh button is a `tmuxjump://refresh` link that regenerates it (the page then reloads itself); the page also reloads when the browser tab regains focus after a minute.
