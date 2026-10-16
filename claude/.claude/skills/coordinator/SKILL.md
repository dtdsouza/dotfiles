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

## Status page

`agentctl.sh dashboard` writes a kanban page of every worker tab (needs you, blocked, working, done) to `status.html` next to the ledger and prints its `file://` path. `spawn`, `note`, `done` and `rename` regenerate it in the background. For live updates, ask the user before starting `agentctl.sh dashboard --watch` in a spare tmux tab: it regenerates every 20s and the page reloads itself. Give the user the page's `file://` path (`file://<state-dir>/status.html`, by default under the monorepo's `.claude/coordinator/`) whenever they ask what the agents are doing. It is read-only: nothing on it types into a worker.

The drawer's "Open in terminal" button is a `tmuxjump://` link. It only works after the user runs `agentctl.sh install-jump-handler` once (registers a desktop URL handler that runs `scripts/tmux-jump.sh`); it opens a new terminal window on that agent's tab (a grouped tmux session that removes itself when closed) and leaves the existing terminal alone. Raising an existing window is not possible on GNOME Wayland.
