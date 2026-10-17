import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(new URL('./deny-mcp-slack-send.mjs', import.meta.url))

function runHook(toolName) {
  const res = spawnSync('node', [HOOK], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName }) })
  return { status: res.status, stdout: res.stdout.toString() }
}

test('denies the Slack MCP send tool from any server prefix and points to the skill', () => {
  for (const name of ['mcp__plugin_slack_slack__slack_send_message', 'mcp__claude_ai_Slack__slack_send_message']) {
    // Act
    const { status, stdout } = runHook(name)

    // Assert
    assert.equal(status, 0)
    const out = JSON.parse(stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /slack-send-as-app/)
  }
})

test('leaves drafts, reads and other tools alone', () => {
  for (const name of ['mcp__plugin_slack_slack__slack_send_message_draft', 'mcp__claude_ai_Slack__slack_read_thread', 'Bash']) {
    // Act
    const { status, stdout } = runHook(name)

    // Assert
    assert.equal(status, 0)
    assert.equal(stdout, '')
  }
})

test('fails open on unparseable input instead of blocking unrelated tools', () => {
  // Act
  const res = spawnSync('node', [HOOK], { input: 'not json' })

  // Assert
  assert.equal(res.status, 0)
  assert.equal(res.stdout.toString(), '')
})
