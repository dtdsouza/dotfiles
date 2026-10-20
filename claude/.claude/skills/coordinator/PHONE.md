# Agents dashboard on the phone (Tailscale)

The served dashboard (`agentctl.sh dashboard --serve`, `127.0.0.1:47317`) can be opened from the phone through `tailscale serve`: HTTPS on `https://<pc>.<tailnet>.ts.net`, reachable only inside the tailnet and proxied to 127.0.0.1. **Never use `tailscale funnel` for it**; the server refuses Funnel requests anyway.

On the phone, each live worker card has a **reply box** (types into that worker's Claude prompt, prefixed `[via dashboard]`) and a **Peek** button (the drawer shows the last 60 lines of that worker's pane, refreshed every 3 s while open). The **Coordinator** button in the header opens the same drawer for the coordinator, so its answers to your messages can be read on the phone. Copy jump, Open in terminal and Go to coordinator are hidden there: they only make sense on the PC.

## One-time setup

1. **Enable HTTPS certificates for the tailnet** (needed once per tailnet; `tailscale status --json` shows `"CertDomains": null` until it is done). In the admin console, open <https://login.tailscale.com/admin/dns>, check MagicDNS is on, then under **HTTPS Certificates** click **Enable HTTPS**. The machine name then appears in the public Certificate Transparency logs.
2. **Restart the dashboard server** so it picks up the code (it reads the tailnet name and owner login at start): in the `dashboard` tab, ctrl-c, then `agentctl.sh dashboard --serve`. Its second line should read `also accepting https://<pc>.<tailnet>.ts.net/ through tailscale serve for <your login>`.
3. **Start the proxy** (this machine has no Tailscale operator set, so it needs sudo):

   ```sh
   sudo tailscale serve --bg 47317
   ```

   This serves `https://<pc>.<tailnet>.ts.net/` on port 443 and proxies it to `http://127.0.0.1:47317`. `--bg` keeps it across reboots until you turn it off. Check it with `tailscale serve status`.
4. **Let your phone reach port 443 in the tailnet policy.** This tailnet's policy (<https://login.tailscale.com/admin/acls>) grants own devices only `tcp:22` and mosh's `udp:60000-61000`, so the phone's HTTPS request is dropped and Chrome shows `ERR_CONNECTION_ABORTED`, even though `tailscale ping` (which bypasses the policy) answers. Add `tcp:443` to that grant, which keeps it limited to your own devices:

   ```jsonc
   {
       "src": ["autogroup:member"],
       "dst": ["autogroup:self"],
       "ip":  ["tcp:22", "tcp:443", "udp:60000-61000"],
   },
   ```
5. **Open the keyed URL once on the phone.** Run `agentctl.sh dashboard --url --tailnet`. It prints `https://<pc>.<tailnet>.ts.net/?key=...`. Get it to the phone privately: paste it into your password manager, or pipe it to `qrencode -t ansiutf8` (`sudo apt install qrencode`) and scan the code. Open it in the phone's browser with Tailscale connected. The server swaps the key for a `Secure`, `HttpOnly`, `SameSite=Strict` cookie that lasts 400 days and redirects to `/`, so the key leaves the address bar. Bookmark `https://<pc>.<tailnet>.ts.net/` (without the key), or add it to the home screen.

## Turning it off

```sh
sudo tailscale serve --https=443 off   # removes just this proxy
sudo tailscale serve reset             # or: clears every serve config on this machine
```

Without the proxy the dashboard is back to 127.0.0.1 only. To also make the server refuse the tailnet name, start it with `COORDINATOR_DASHBOARD_TAILNET=off`.

## Configuration

| Env var (read when the server starts) | Default | Effect |
|---|---|---|
| `COORDINATOR_DASHBOARD_TAILNET_HOST` | `Self.DNSName` from `tailscale status --json` | The tailnet name to accept as Host |
| `COORDINATOR_DASHBOARD_TAILNET_LOGINS` | this machine's owner (`User[Self.UserID].LoginName`) | Comma-separated Tailscale logins allowed through the tailnet name |
| `COORDINATOR_DASHBOARD_TAILNET` | on | `off` keeps the server local-only |

Discovery is the default because it follows a machine rename after a restart and needs no setup. The env vars cover a second login or a node `tailscale status` cannot read.

## Security model

- **What `serve` sends** (tailscale v1.104.1, `ipn/ipnlocal/serve.go`):
  - It keeps the browser's `Host` (`<pc>.<tailnet>.ts.net`, no port) and sets `X-Forwarded-Host`, `X-Forwarded-For` and, on TLS, `X-Forwarded-Proto: https`.
  - It deletes any client-sent `Tailscale-User-*` headers, then sets `Tailscale-User-Login` for a tailnet peer that is a user-owned (not tagged) node.
  - Funnel traffic gets `Tailscale-Funnel-Request: ?1` and no login.
- **What the server checks on the tailnet name.** It accepts a request whose Host is exactly the tailnet name only when all of these hold:
  - `X-Forwarded-Proto` is `https`;
  - there is no `Tailscale-Funnel-Request`;
  - `Tailscale-User-Login` is on the allowlist.

  Every other Host except `127.0.0.1:<port>` and `localhost:<port>` gets a 403 (the DNS-rebinding guard). Actions from the tailnet name must carry `Origin: https://<pc>.<tailnet>.ts.net`; local actions keep the `http://127.0.0.1` and `http://localhost` origins.
- **The key cookie is still the primary gate.** The server only listens on 127.0.0.1, and any local process can forge every one of those headers there. The Tailscale checks narrow who may try (another tailnet user, a tagged node, a Funnel misconfiguration); they are not a secret. Without the 0600 key file nobody gets the cookie, the page or its CSRF token.
- **The rest is unchanged.** Actions still need the CSRF header, a same-origin `Sec-Fetch-Site` and JSON, and they are rate-limited (30 a minute). Peek is a GET that needs the cookie and the CSRF header, has its own budget (240 a minute) and sends `Cache-Control: no-store`.
- **The client only ever names a task id, never a pane.** Peek and reply take the pane from the ledger's `meta.json` and require it to still be that task's own pane, in its window and session. They refuse the coordinator's and the dashboard's tabs. The coordinator has its own endpoints, which take no id at all: `/api/coordinator/peek` (read) and `/api/message` (type).
- **A reply is refused when:**
  - the pane is not running `claude`;
  - a permission dialog or numbered menu is on screen. Answer those in the terminal: choosing from them on the phone is deliberately not supported.

  Replies get the same sanitizing and 2000-character cap as coordinator messages.
- **Audit log.** Every message typed into a pane (replies and coordinator messages) is appended to `~/.local/state/agentctl/dashboard-audit.jsonl` (0600) as `{at, task, source, text}`. `source` is `local` or `tailnet:<login>`.

## Still to check on a real phone

- iOS Safari and Android Chrome keep the `SameSite=Strict` cookie after the key redirect and after a home-screen launch.
- The keyboard does not cover the reply box, and the drawer scrolls while the peek panel refreshes.
- The page and peek keep working when the phone switches between Wi-Fi and mobile data (Tailscale reconnects).
