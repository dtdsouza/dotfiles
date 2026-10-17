import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseArgs,
  loadBotToken,
  buildPostPayload,
  resolveChannel,
  sendMessage,
  describeApp,
  MAX_MARKDOWN_CHARS,
} from './slack-app.mjs'

const BOT = 'xoxb-test-not-real'

function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    const method = new URL(url).pathname.replace('/api/', '')
    calls.push({ method, url, init })
    const route = routes[method]
    if (!route) throw new Error(`unexpected call ${method}`)
    const { body, headers = {} } = typeof route === 'function' ? route(url, init) : route
    return {
      json: async () => body,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    }
  }
  return { impl, calls }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slack-app-test-'))
}

describe('parseArgs', () => {
  test('parses send flags', () => {
    // Arrange
    const argv = ['send', '--channel', 'C123', '--thread-ts', '1.2', '--file', 'm.md', '--broadcast', '--no-unfurl']

    // Act
    const result = parseArgs(argv)

    // Assert
    assert.deepEqual(result, {
      command: 'send',
      channel: 'C123',
      threadTs: '1.2',
      file: 'm.md',
      broadcast: true,
      unfurl: false,
      dryRun: false,
    })
  })

  test('rejects unknown flags', () => {
    assert.throws(() => parseArgs(['send', '--as-user']), /unknown flag --as-user/)
  })

  test('rejects a flag missing its value', () => {
    assert.throws(() => parseArgs(['send', '--channel']), /--channel needs a value/)
  })
})

describe('loadBotToken', () => {
  test('prefers SLACK_APP_BOT_TOKEN over the token file', () => {
    // Arrange
    const env = { SLACK_APP_BOT_TOKEN: ` ${BOT} ` }

    // Act
    const token = loadBotToken({ env, tokenFiles: [] })

    // Assert
    assert.equal(token, BOT)
  })

  test('falls back to SLACK_TRIAGE_TOKEN, then the first readable 0600 file', () => {
    // Arrange
    const dir = tmpDir()
    const file = path.join(dir, '.slack-token')
    fs.writeFileSync(file, `${BOT}\n`, { mode: 0o600 })

    // Act
    const fromEnv = loadBotToken({ env: { SLACK_TRIAGE_TOKEN: BOT }, tokenFiles: [] })
    const fromFile = loadBotToken({ env: {}, tokenFiles: [path.join(dir, 'missing'), file] })

    // Assert
    assert.equal(fromEnv, BOT)
    assert.equal(fromFile, BOT)
  })

  test('refuses a token file readable by group or others', () => {
    // Arrange
    const dir = tmpDir()
    const file = path.join(dir, '.slack-token')
    fs.writeFileSync(file, BOT)
    fs.chmodSync(file, 0o644)

    // Act + Assert
    assert.throws(() => loadBotToken({ env: {}, tokenFiles: [file] }), /chmod 600/)
  })

  test('refuses a user token so a send can never post as the user', () => {
    assert.throws(
      () => loadBotToken({ env: { SLACK_APP_BOT_TOKEN: 'xoxp-user' }, tokenFiles: [] }),
      /not a bot token/,
    )
  })

  test('errors when no token is configured, without echoing any value', () => {
    assert.throws(() => loadBotToken({ env: {}, tokenFiles: [] }), /No Slack bot token/)
  })
})

describe('buildPostPayload', () => {
  test('sends the body as markdown_text so [text](url) links render', () => {
    // Act
    const payload = buildPostPayload({ channel: 'C1', markdown: 'see [MR](https://x.y/1)' })

    // Assert
    assert.deepEqual(payload, { channel: 'C1', markdown_text: 'see [MR](https://x.y/1)' })
    assert.equal('text' in payload, false)
  })

  test('adds thread, broadcast and unfurl options only when set', () => {
    // Act
    const payload = buildPostPayload({
      channel: 'C1',
      markdown: 'hi',
      threadTs: '1.2',
      broadcast: true,
      unfurl: false,
    })

    // Assert
    assert.deepEqual(payload, {
      channel: 'C1',
      markdown_text: 'hi',
      thread_ts: '1.2',
      reply_broadcast: true,
      unfurl_links: false,
      unfurl_media: false,
    })
  })

  test('rejects an empty or oversized body', () => {
    assert.throws(() => buildPostPayload({ channel: 'C1', markdown: '  \n' }), /empty/)
    assert.throws(
      () => buildPostPayload({ channel: 'C1', markdown: 'a'.repeat(MAX_MARKDOWN_CHARS + 1) }),
      /12000/,
    )
  })

  test('rejects broadcast without a thread', () => {
    assert.throws(() => buildPostPayload({ channel: 'C1', markdown: 'x', broadcast: true }), /--thread-ts/)
  })
})

describe('resolveChannel', () => {
  test('passes conversation and user ids through without an API call', async () => {
    // Arrange
    const { impl, calls } = fakeFetch({})

    // Act
    const ids = await Promise.all(
      ['C0ABC', 'G0ABC', 'D0ABC', 'U0ABC', 'W0ABC'].map((c) => resolveChannel(c, { token: BOT, fetchImpl: impl })),
    )

    // Assert
    assert.deepEqual(ids, ['C0ABC', 'G0ABC', 'D0ABC', 'U0ABC', 'W0ABC'])
    assert.equal(calls.length, 0)
  })

  test('resolves #name among the channels the bot is a member of, across pages', async () => {
    // Arrange
    const { impl } = fakeFetch({
      'users.conversations': (url) =>
        new URL(url).searchParams.get('cursor')
          ? { body: { ok: true, channels: [{ id: 'C2', name: 'squad-consumers' }] } }
          : { body: { ok: true, channels: [{ id: 'C1', name: 'general' }], response_metadata: { next_cursor: 'n' } } },
    })

    // Act
    const id = await resolveChannel('#squad-consumers', { token: BOT, fetchImpl: impl })

    // Assert
    assert.equal(id, 'C2')
  })

  test('explains that the app must be invited when #name is not found', async () => {
    // Arrange
    const { impl } = fakeFetch({ 'users.conversations': { body: { ok: true, channels: [] } } })

    // Act + Assert
    await assert.rejects(resolveChannel('#secret', { token: BOT, fetchImpl: impl }), /\/invite/)
  })
})

describe('sendMessage', () => {
  test('posts as the bot and returns channel, ts and permalink', async () => {
    // Arrange
    const { impl, calls } = fakeFetch({
      'chat.postMessage': { body: { ok: true, channel: 'C1', ts: '111.222' } },
      'chat.getPermalink': { body: { ok: true, permalink: 'https://twism.slack.com/archives/C1/p111222' } },
    })

    // Act
    const result = await sendMessage({ channel: 'C1', markdown: 'hello', threadTs: '100.1' }, { token: BOT, fetchImpl: impl })

    // Assert
    assert.deepEqual(result, {
      ok: true,
      channel: 'C1',
      ts: '111.222',
      threadTs: '100.1',
      permalink: 'https://twism.slack.com/archives/C1/p111222',
    })
    const post = calls[0]
    assert.equal(post.init.method, 'POST')
    assert.equal(post.init.headers.Authorization, `Bearer ${BOT}`)
    assert.deepEqual(JSON.parse(post.init.body), { channel: 'C1', markdown_text: 'hello', thread_ts: '100.1' })
  })

  test('still reports success when only the permalink lookup fails', async () => {
    // Arrange
    const { impl } = fakeFetch({
      'chat.postMessage': { body: { ok: true, channel: 'D9', ts: '1.1' } },
      'chat.getPermalink': { body: { ok: false, error: 'channel_not_found' } },
    })

    // Act
    const result = await sendMessage({ channel: 'U1', markdown: 'hi' }, { token: BOT, fetchImpl: impl })

    // Assert
    assert.equal(result.ok, true)
    assert.equal(result.channel, 'D9')
    assert.equal(result.permalink, null)
    assert.match(result.permalinkError, /channel_not_found/)
  })

  test('maps not_in_channel to an actionable error', async () => {
    // Arrange
    const { impl } = fakeFetch({ 'chat.postMessage': { body: { ok: false, error: 'not_in_channel' } } })

    // Act + Assert
    await assert.rejects(
      sendMessage({ channel: 'C1', markdown: 'hi' }, { token: BOT, fetchImpl: impl }),
      /not_in_channel.*\/invite/,
    )
  })

  test('never includes the token in error messages', async () => {
    // Arrange
    const { impl } = fakeFetch({ 'chat.postMessage': { body: { ok: false, error: 'invalid_auth' } } })

    // Act
    const err = await sendMessage({ channel: 'C1', markdown: 'hi' }, { token: BOT, fetchImpl: impl }).catch((e) => e)

    // Assert
    assert.equal(String(err.message).includes(BOT), false)
  })
})

describe('describeApp', () => {
  test('reports bot identity, scopes from the response header, and member channels', async () => {
    // Arrange
    const { impl } = fakeFetch({
      'auth.test': {
        body: { ok: true, team: 'Twism', user: 'danny_ai', bot_id: 'B1', user_id: 'U9' },
        headers: { 'x-oauth-scopes': 'chat:write,channels:read' },
      },
      'users.conversations': { body: { ok: true, channels: [{ id: 'C1', name: 'bug-reports', is_private: false }] } },
    })

    // Act
    const info = await describeApp({ token: BOT, fetchImpl: impl })

    // Assert
    assert.deepEqual(info, {
      team: 'Twism',
      botUser: 'danny_ai',
      botUserId: 'U9',
      botId: 'B1',
      scopes: ['chat:write', 'channels:read'],
      channels: [{ id: 'C1', name: 'bug-reports', private: false }],
      channelsError: null,
    })
  })
})
