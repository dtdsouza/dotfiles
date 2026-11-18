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
  MAX_UPLOAD_BYTES,
  markdownToMrkdwn,
  checkUploadFile,
  uploadFile,
} from './slack-app.mjs'

const BOT = 'xoxb-test-not-real'

function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    const method = new URL(url).pathname.replace(/^\/(api\/)?/, '')
    calls.push({ method, url, init })
    const route = routes[method]
    if (!route) throw new Error(`unexpected call ${method}`)
    const { body, headers = {} } = typeof route === 'function' ? route(url, init) : route
    return {
      ok: true,
      status: 200,
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
      path: undefined,
      title: undefined,
      commentFile: undefined,
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

describe('parseArgs for upload', () => {
  test('parses upload flags', () => {
    // Act
    const result = parseArgs(['upload', '--channel', 'U1', '--path', 'a.mp4', '--title', 'Demo', '--comment-file', 'c.md', '--thread-ts', '1.2', '--dry-run'])

    // Assert
    assert.equal(result.command, 'upload')
    assert.equal(result.path, 'a.mp4')
    assert.equal(result.title, 'Demo')
    assert.equal(result.commentFile, 'c.md')
    assert.equal(result.threadTs, '1.2')
    assert.equal(result.dryRun, true)
  })
})

describe('markdownToMrkdwn', () => {
  test('converts links and bold, keeps italics and bullets', () => {
    // Act
    const out = markdownToMrkdwn('**Hi** _there_\n- see [MR](https://x.y/1)')

    // Assert
    assert.equal(out, '*Hi* _there_\n\u2022 see <https://x.y/1|MR>')
  })
})

describe('checkUploadFile', () => {
  test('returns name and size for a regular file', () => {
    // Arrange
    const file = path.join(tmpDir(), 'a.txt')
    fs.writeFileSync(file, 'hello')

    // Act
    const info = checkUploadFile(file)

    // Assert
    assert.deepEqual(info, { filename: 'a.txt', size: 5 })
  })

  test('refuses directories and missing paths', () => {
    assert.throws(() => checkUploadFile(tmpDir()), /not a regular file/)
    assert.throws(() => checkUploadFile(path.join(tmpDir(), 'nope')), /not a regular file|no such file/i)
  })

  test('refuses empty files and files over the cap', () => {
    // Arrange
    const empty = path.join(tmpDir(), 'e.txt')
    fs.writeFileSync(empty, '')

    // Act + Assert
    assert.throws(() => checkUploadFile(empty), /empty/)
    assert.throws(() => checkUploadFile(empty, { maxBytes: -1 }), /empty|exceeds/)
    const big = path.join(tmpDir(), 'b.txt')
    fs.writeFileSync(big, 'abcdef')
    assert.throws(() => checkUploadFile(big, { maxBytes: 3 }), /exceeds the 3 byte cap/)
    assert.ok(MAX_UPLOAD_BYTES <= 200 * 1024 * 1024)
  })
})

describe('uploadFile', () => {
  function uploadRoutes(extra = {}) {
    return {
      'files.getUploadURLExternal': { body: { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F1' } },
      'upload/v1/abc': { body: {} },
      'files.completeUploadExternal': { body: { ok: true, files: [{ id: 'F1', title: 'Demo' }] } },
      'files.info': { body: { ok: true, file: { permalink: 'https://twism.slack.com/files/U1/F1/a.txt' } } },
      ...extra,
    }
  }

  test('runs the three-step flow and returns the permalink', async () => {
    // Arrange
    const file = path.join(tmpDir(), 'a.txt')
    fs.writeFileSync(file, 'hello')
    const { impl, calls } = fakeFetch(uploadRoutes())

    // Act
    const result = await uploadFile(
      { channel: 'C1', path: file, title: 'Demo', comment: 'see [MR](https://x.y/1)', threadTs: '1.2' },
      { token: BOT, fetchImpl: impl },
    )

    // Assert
    assert.deepEqual(result, { ok: true, channel: 'C1', fileId: 'F1', permalink: 'https://twism.slack.com/files/U1/F1/a.txt' })
    assert.deepEqual(calls.map((c) => c.method), ['files.getUploadURLExternal', 'upload/v1/abc', 'files.completeUploadExternal', 'files.info'])
    const query = new URL(calls[0].url).searchParams
    assert.equal(query.get('filename'), 'a.txt')
    assert.equal(query.get('length'), '5')
    assert.equal(calls[1].init.method, 'POST')
    assert.equal(Buffer.from(calls[1].init.body).toString(), 'hello')
    assert.equal(calls[1].init.headers?.Authorization, undefined)
    assert.deepEqual(JSON.parse(calls[2].init.body), {
      files: [{ id: 'F1', title: 'Demo' }],
      channel_id: 'C1',
      thread_ts: '1.2',
      initial_comment: 'see <https://x.y/1|MR>',
    })
  })

  test('opens a DM first when the target is a user id', async () => {
    // Arrange
    const file = path.join(tmpDir(), 'a.txt')
    fs.writeFileSync(file, 'hi')
    const { impl, calls } = fakeFetch(uploadRoutes({ 'conversations.open': { body: { ok: true, channel: { id: 'D9' } } } }))

    // Act
    const result = await uploadFile({ channel: 'U1', path: file }, { token: BOT, fetchImpl: impl })

    // Assert
    assert.equal(result.channel, 'D9')
    assert.equal(calls[0].method, 'conversations.open')
    assert.deepEqual(JSON.parse(calls.find((c) => c.method === 'files.completeUploadExternal').init.body), {
      files: [{ id: 'F1', title: 'a.txt' }],
      channel_id: 'D9',
    })
  })

  test('still succeeds when only the permalink lookup fails', async () => {
    // Arrange
    const file = path.join(tmpDir(), 'a.txt')
    fs.writeFileSync(file, 'hi')
    const { impl } = fakeFetch(uploadRoutes({ 'files.info': { body: { ok: false, error: 'missing_scope', needed: 'files:read' } } }))

    // Act
    const result = await uploadFile({ channel: 'C1', path: file }, { token: BOT, fetchImpl: impl })

    // Assert
    assert.equal(result.ok, true)
    assert.equal(result.permalink, null)
    assert.match(result.permalinkError, /files:read/)
  })

  test('surfaces missing_scope with the needed scope', async () => {
    // Arrange
    const file = path.join(tmpDir(), 'a.txt')
    fs.writeFileSync(file, 'hi')
    const { impl } = fakeFetch(uploadRoutes({ 'files.getUploadURLExternal': { body: { ok: false, error: 'missing_scope', needed: 'files:write' } } }))

    // Act + Assert
    await assert.rejects(uploadFile({ channel: 'C1', path: file }, { token: BOT, fetchImpl: impl }), /missing_scope \(needs files:write\)/)
  })

  test('fails clearly when the byte upload is rejected, without leaking the token', async () => {
    // Arrange
    const file = path.join(tmpDir(), 'a.txt')
    fs.writeFileSync(file, 'hi')
    const { impl } = fakeFetch(uploadRoutes())
    const failing = async (url, init) => {
      const res = await impl(url, init)
      return url.includes('/upload/v1/') ? { ...res, ok: false, status: 500 } : res
    }

    // Act
    const err = await uploadFile({ channel: 'C1', path: file }, { token: BOT, fetchImpl: failing }).catch((e) => e)

    // Assert
    assert.match(err.message, /upload.*500/i)
    assert.equal(err.message.includes(BOT), false)
  })

  test('rejects a thread-ts that is not a message timestamp', async () => {
    const file = path.join(tmpDir(), 'a.txt')
    fs.writeFileSync(file, 'hi')
    await assert.rejects(uploadFile({ channel: 'C1', path: file, threadTs: 'abc' }, { token: BOT, fetchImpl: fakeFetch({}).impl }), /thread-ts/)
  })
})
