#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const SLACK_API = 'https://slack.com/api'
export const MAX_MARKDOWN_CHARS = 12000

// The twism-triage-loop app token is reused on purpose: one Slack app, one secret.
export const DEFAULT_TOKEN_FILES = [
  path.join(os.homedir(), '.local/share/slack-send-as-app/.slack-token'),
  path.join(os.homedir(), '.local/share/twism-triage-loop/.slack-token'),
]

const USAGE = `Usage:
  slack-app.mjs send --channel <C…|G…|D…|U…|#name> (--file <path> | stdin) [--thread-ts <ts>] [--broadcast] [--no-unfurl] [--dry-run]
  slack-app.mjs whoami

The message body is standard markdown (sent as markdown_text), read from --file or stdin.
Prints one JSON object: { ok, channel, ts, threadTs, permalink }.`

const VALUE_FLAGS = { '--channel': 'channel', '--thread-ts': 'threadTs', '--file': 'file' }
const BOOLEAN_FLAGS = { '--broadcast': ['broadcast', true], '--no-unfurl': ['unfurl', false], '--dry-run': ['dryRun', true] }

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const parsed = { command, channel: undefined, threadTs: undefined, file: undefined, broadcast: false, unfurl: true, dryRun: false }
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    if (VALUE_FLAGS[flag]) {
      const value = rest[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      parsed[VALUE_FLAGS[flag]] = value
      i += 1
    } else if (BOOLEAN_FLAGS[flag]) {
      const [key, value] = BOOLEAN_FLAGS[flag]
      parsed[key] = value
    } else {
      throw new Error(`unknown flag ${flag}`)
    }
  }
  return parsed
}

function readTokenFile(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  if (stat.mode & 0o077) throw new Error(`Token file ${file} is readable by others; run: chmod 600 ${file}`)
  return fs.readFileSync(file, 'utf8').trim() || null
}

export function loadBotToken({ env = process.env, tokenFiles = DEFAULT_TOKEN_FILES } = {}) {
  const fromEnv = [env.SLACK_APP_BOT_TOKEN, env.SLACK_TRIAGE_TOKEN].map((v) => (v || '').trim()).find(Boolean)
  const token = fromEnv || tokenFiles.map(readTokenFile).find(Boolean)
  if (!token) {
    throw new Error(
      `No Slack bot token. Set SLACK_APP_BOT_TOKEN or create a 0600 token file at one of: ${tokenFiles.join(', ')}`,
    )
  }
  // Identity is the token alone: an xoxp- user token would post as the user, defeating the skill.
  if (!token.startsWith('xoxb-')) throw new Error('Configured Slack token is not a bot token (expected an xoxb- token)')
  return token
}

export function buildPostPayload({ channel, markdown, threadTs, broadcast = false, unfurl = true }) {
  if (!markdown || !markdown.trim()) throw new Error('Message body is empty')
  if (markdown.length > MAX_MARKDOWN_CHARS) {
    throw new Error(`Message body is ${markdown.length} chars; markdown_text allows at most ${MAX_MARKDOWN_CHARS}`)
  }
  if (broadcast && !threadTs) throw new Error('--broadcast only applies to a thread reply; pass --thread-ts')
  return {
    channel,
    markdown_text: markdown,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(broadcast ? { reply_broadcast: true } : {}),
    ...(unfurl ? {} : { unfurl_links: false, unfurl_media: false }),
  }
}

const ERROR_HINTS = {
  not_in_channel: 'the app is not a member; run /invite @<app> in that channel first',
  channel_not_found: 'unknown channel, or a private channel/DM the app cannot see; /invite the app or check the id',
  missing_scope: 'the app lacks a scope for this call; add it under Bot Token Scopes and reinstall the app',
  invalid_auth: 'the bot token was rejected; it may have been revoked or rotated',
  markdown_text_conflict: 'markdown_text cannot be combined with text or blocks',
}

function slackError(method, error, needed) {
  const hint = ERROR_HINTS[error]
  const scope = error === 'missing_scope' && needed ? ` (needs ${needed})` : ''
  const err = new Error(`slack ${method}: ${error || 'unknown'}${scope}${hint ? ` - ${hint}` : ''}`)
  err.slackError = error
  return err
}

async function callSlack(method, { token, fetchImpl, query, body }) {
  const url = `${SLACK_API}/${method}${query ? `?${new URLSearchParams(query)}` : ''}`
  const init = body
    ? {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
      }
    : { headers: { Authorization: `Bearer ${token}` } }
  const res = await fetchImpl(url, init)
  const json = await res.json()
  if (!json.ok) throw slackError(method, json.error, json.needed)
  return { json, headers: res.headers }
}

async function listMemberChannels({ token, fetchImpl }) {
  const channels = []
  let cursor = ''
  do {
    const query = { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '1000', ...(cursor ? { cursor } : {}) }
    const { json } = await callSlack('users.conversations', { token, fetchImpl, query })
    channels.push(...(json.channels || []))
    cursor = json.response_metadata?.next_cursor || ''
  } while (cursor)
  return channels
}

export async function resolveChannel(channel, { token, fetchImpl = fetch }) {
  if (!channel) throw new Error('--channel is required')
  if (/^[CGDUW][A-Z0-9]+$/.test(channel)) return channel
  const name = channel.replace(/^#/, '')
  const match = (await listMemberChannels({ token, fetchImpl })).find((c) => c.name === name)
  if (!match) throw new Error(`#${name} is not a channel the app is in; /invite the app there, or pass the channel id`)
  return match.id
}

export async function sendMessage(message, { token, fetchImpl = fetch }) {
  const channel = await resolveChannel(message.channel, { token, fetchImpl })
  const payload = buildPostPayload({ ...message, channel })
  const { json: posted } = await callSlack('chat.postMessage', { token, fetchImpl, body: payload })
  const result = { ok: true, channel: posted.channel, ts: posted.ts, threadTs: message.threadTs || null }
  try {
    const query = { channel: posted.channel, message_ts: posted.ts }
    const { json } = await callSlack('chat.getPermalink', { token, fetchImpl, query })
    return { ...result, permalink: json.permalink }
  } catch (err) {
    return { ...result, permalink: null, permalinkError: err.message }
  }
}

export async function describeApp({ token, fetchImpl = fetch }) {
  const { json: auth, headers } = await callSlack('auth.test', { token, fetchImpl })
  const scopes = (headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim()).filter(Boolean)
  const identity = { team: auth.team, botUser: auth.user, botUserId: auth.user_id, botId: auth.bot_id, scopes }
  try {
    const channels = (await listMemberChannels({ token, fetchImpl })).map((c) => ({ id: c.id, name: c.name, private: Boolean(c.is_private) }))
    return { ...identity, channels, channelsError: null }
  } catch (err) {
    return { ...identity, channels: [], channelsError: err.message }
  }
}

function readBody(file) {
  return fs.readFileSync(file ?? 0, 'utf8')
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.command === 'send') {
    const message = { channel: args.channel, markdown: readBody(args.file), threadTs: args.threadTs, broadcast: args.broadcast, unfurl: args.unfurl }
    if (args.dryRun) return buildPostPayload(message)
    return sendMessage(message, { token: loadBotToken() })
  }
  if (args.command === 'whoami') return describeApp({ token: loadBotToken() })
  throw new Error(USAGE)
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().then(
    (out) => process.stdout.write(`${JSON.stringify(out, null, 2)}\n`),
    (err) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: err.message })}\n`)
      process.exit(1)
    },
  )
}
