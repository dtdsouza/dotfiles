#!/usr/bin/env node
// The settings matcher may match by substring, so the exact-name check here is what keeps
// slack_send_message_draft allowed.
const SEND_TOOL = /^mcp__.+__slack_send_message$/

const REASON =
  'Sending Slack messages under your own account is disabled. Send as the app with the ' +
  'slack-send-as-app skill instead; for a draft under your account, use slack_send_message_draft.'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
})
process.stdin.on('end', () => {
  let toolName = ''
  try {
    toolName = JSON.parse(input).tool_name || ''
  } catch {
    process.exit(0)
  }
  if (!SEND_TOOL.test(toolName)) process.exit(0)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: REASON,
      },
    }),
  )
})
