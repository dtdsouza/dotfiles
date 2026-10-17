---
name: slack-send-as-app
description: Use whenever the user asks to send, post, reply or DM on Slack (a channel message, a thread reply, a DM, the parent-then-thread announcement pattern). Sends as the user's Slack app "Danny AI Assistant" (bot token), never as the user's own account, and returns channel, ts and permalink. Not for drafts (use the Slack MCP slack_send_message_draft, under the user's account) or for reading Slack (use the Slack MCP read/search tools).
---

# Slack: send as the app

Every Slack **send** goes out as the app. **Drafts** stay under the user's account via the Slack MCP (`slack_send_message_draft`), and reading Slack stays on the MCP read/search tools. The MCP `slack_send_message` tool posts as the user and is blocked by a PreToolUse hook.

Only send when the user explicitly said to send. Otherwise prepare a draft or show the text (global CLAUDE.md rule).

## Send

Always run the script by this exact path: `node /home/dtdsouza/.claude/skills/slack-send-as-app/scripts/slack-app.mjs …`. It is the path the `settings.json` allow rule matches; any other spelling (`~`, the dotfiles path, `$SKILL_DIR`) falls back to a permission check.

1. Write the message to a file in your scratchpad. The body is **standard markdown**, the same you would give the MCP: `[text](url)` links, `_italic_`, `**bold**`, `•` or `-` bullets, `:emoji:` codes. Never pass the body on the command line. Single line breaks are kept, but blank lines between sections collapse, so let the `_italic_` header lines separate sections.
2. Post it:
   ```bash
   node /home/dtdsouza/.claude/skills/slack-send-as-app/scripts/slack-app.mjs send --channel <target> --file <scratchpad>/msg.md [--thread-ts <parentTs>] [--no-unfurl]
   ```
   `<target>`:
   - a channel id (`C…`/`G…`), or `#name` for a channel the app is already in;
   - a user id (`U…`) for a DM from the app;
   - an existing DM id (`D…`).

   Look up ids with the Slack MCP (`slack_search_channels`, `slack_search_users`).
3. It prints `{ ok, channel, ts, threadTs, permalink }`. Show the user the permalink. On failure it prints `{ ok: false, error }` to stderr and exits 1. Do not fall back to the MCP send tool.

**Thread pattern** (parent message, details in the thread): send the parent, take the `ts` it returns, then send the reply with `--thread-ts <that ts>`. Always pass the parent's `ts`, never a reply's. Add `--broadcast` only when the user asks to also show the reply in the channel.

**Mentions:** a plain `@name` does not ping. Resolve the user id with `slack_search_users` and write `<@U…>`.

`--dry-run` prints the exact `chat.postMessage` payload without sending or loading the token. Use it to check what a send would post.

## Errors

| Error | Fix |
|---|---|
| `not_in_channel` / `#name is not a channel the app is in` | The user must `/invite @Danny AI Assistant` in that channel. Do not retry until they say it's done. |
| `channel_not_found` | Wrong id, or a private channel the app cannot see. |
| `invalid_auth` / `No Slack bot token` | Token missing or revoked; see Setup. Never ask the user to paste a token into the chat. |
| `not a bot token` | The configured token is `xoxp-` (it would post as the user). Replace it with the app's Bot User OAuth Token. |

`whoami` prints the app's identity, scopes and the channels it is in, without the token: `node /home/dtdsouza/.claude/skills/slack-send-as-app/scripts/slack-app.mjs whoami`.

## Setup

- **Token.** The script uses the first of:
  1. `SLACK_APP_BOT_TOKEN`;
  2. `SLACK_TRIAGE_TOKEN`;
  3. `~/.local/share/slack-send-as-app/.slack-token`;
  4. `~/.local/share/twism-triage-loop/.slack-token` (the triage loop's app, the same Slack app).

  A token file must be `chmod 600`. Never Read, cat or print a token file, and never echo the token.
- **Scopes.** `chat:write` is required. DMs to a user id work with `chat:write` alone; the message lands in the app's Messages tab for that user.
- **Channels.** The app must be invited to each channel it posts to.
