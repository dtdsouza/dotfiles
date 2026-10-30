#!/usr/bin/env node
// Usage: coordinator-send.cjs <primary-state-dir> <profile> <text>
// Types <text> into the profile's coordinator through the same guards as the dashboard.
// Exit 0: typed. Exit 3: the coordinator can't take it now (dialog, missing pane); retry later.
const actions = require('./dashboard-actions.cjs');
const { loadProfiles } = require('./profiles.cjs');

const REPORT_PREFIX = '[via agentctl] ';

const main = async () => {
  const [primaryStateDir, profileName, text] = process.argv.slice(2);
  const profiles = loadProfiles({ primaryStateDir });
  const profile = profiles.find((p) => p.name === profileName);
  if (!profile) {
    console.error(`[agentctl] unknown profile: ${profileName}`);
    return 1;
  }
  const scope = {
    name: profile.name,
    session: profile.session,
    excludeSessions: profiles.filter((p) => p !== profile && p.session).map((p) => p.session),
  };
  try {
    await actions.sendToCoordinator(text, scope, REPORT_PREFIX);
    return 0;
  } catch (err) {
    if (err instanceof actions.ActionError) {
      console.error(`[agentctl] ${err.message}`);
      return 3;
    }
    throw err;
  }
};

main().then((code) => process.exit(code));
