// Access through `tailscale serve` (HTTPS on the machine's MagicDNS name, proxied to 127.0.0.1).
// serve keeps the browser's Host, sets X-Forwarded-Proto https on TLS, strips any client-sent
// Tailscale-User-* headers and then sets Tailscale-User-Login for a tailnet peer that is not a
// tagged node; Funnel traffic gets Tailscale-Funnel-Request and no login
// (ipn/ipnlocal/serve.go, addProxyForwardedHeaders and addTailscaleIdentityHeaders, v1.104.1).
// Any local process can forge all of these against 127.0.0.1, so this gate only narrows who may
// try: the key cookie stays the real secret.
const { execFileSync } = require('child_process');

const STATUS_TIMEOUT_MS = 3000;

const normalizeHost = (name) => String(name || '').trim().replace(/\.$/, '').toLowerCase();
const parseLogins = (text) => String(text || '').split(',').map((l) => l.trim().toLowerCase()).filter(Boolean);

const tailnetFromStatus = (status) => {
  if (!status || status.BackendState !== 'Running') return null;
  const host = normalizeHost(status.Self && status.Self.DNSName);
  const owner = status.User && status.Self && status.User[status.Self.UserID];
  const login = owner ? String(owner.LoginName || '').toLowerCase() : '';
  return host && login ? { host, logins: [login] } : null;
};

const readTailscaleStatus = () =>
  JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: STATUS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }));

// The env wins over `tailscale status` so a renamed machine or a second login needs no code change.
const loadTailnetConfig = (env = process.env, readStatus = readTailscaleStatus) => {
  if (env.COORDINATOR_DASHBOARD_TAILNET === 'off') return null;
  let discovered = null;
  try {
    discovered = tailnetFromStatus(readStatus());
  } catch {
    discovered = null;
  }
  const host = normalizeHost(env.COORDINATOR_DASHBOARD_TAILNET_HOST) || (discovered && discovered.host);
  const logins = parseLogins(env.COORDINATOR_DASHBOARD_TAILNET_LOGINS);
  const allowed = logins.length ? logins : discovered ? discovered.logins : [];
  return host && allowed.length ? { host, logins: allowed } : null;
};

// Returns how the request arrived ({ via, origins, secure, source }) or a [status, message] refusal.
const classifyRequest = (headers, { port, tailnet }) => {
  const host = String(headers.host || '').toLowerCase();
  const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (localHosts.includes(host)) {
    return { via: 'local', origins: new Set(localHosts.map((h) => `http://${h}`)), secure: false, source: 'local' };
  }
  // DNS rebinding: a hostile name that resolves to 127.0.0.1 still sends its own Host.
  if (!tailnet || host !== tailnet.host) return { refusal: [403, 'Unexpected Host header.'] };
  if (headers['tailscale-funnel-request']) return { refusal: [403, 'Funnel requests are refused.'] };
  if (headers['x-forwarded-proto'] !== 'https') return { refusal: [403, 'The tailnet name is served over HTTPS only.'] };
  const login = String(headers['tailscale-user-login'] || '').trim().toLowerCase();
  if (!login || !tailnet.logins.includes(login)) return { refusal: [403, 'This Tailscale login may not use the dashboard.'] };
  return { via: 'tailnet', origins: new Set([`https://${tailnet.host}`]), secure: true, source: `tailnet:${login}` };
};

module.exports = { tailnetFromStatus, loadTailnetConfig, classifyRequest };
