# Agents dashboard on the phone (Tailscale)

The served dashboard (`agentctl.sh dashboard --serve`, `127.0.0.1:47317`) can be opened from the phone through `tailscale serve`: HTTPS on `https://<pc>.<tailnet>.ts.net`, reachable only inside the tailnet and proxied to 127.0.0.1. **Never use `tailscale funnel` for it**; the server refuses Funnel requests anyway.

On the phone, each live worker card has a **reply box** (types into that worker's Claude prompt, prefixed `[via dashboard]`) and a **Peek** button (the drawer shows the last 60 lines of that worker's pane, refreshed every 3 s while open). The **Coordinator** button in the header opens the same drawer for the coordinator, so its answers to your messages can be read on the phone. Copy jump, Open in terminal and Go to coordinator are hidden there: they only make sense on the PC.

The **Files** button in the header lists the workers' HTML reports, videos and PDFs, newest first, with the task each belongs to. Each task's drawer lists its own files, and the artifact paths in its ledger notes (`file://...`, `~/...`, `.claude/tmp/...`) become links. A file opens in a new tab: HTML as the report itself, a video in a player page (`<video controls playsinline>`, seekable), Markdown as plain text.

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
| `COORDINATOR_DASHBOARD_FILE_ROOTS` | `~/workspace/twism/**/.claude/tmp/**:~/workspace/twism/**/.claude/worktrees/*/{.claude/tmp,docs,openspec}/**` | Colon-separated absolute globs (`~`, `*`, `**`, `{a,b}`) of the folders whose files the viewer may serve; `off` turns the viewer off |

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

## File viewer security model

- **Roots.** Only files under `COORDINATOR_DASHBOARD_FILE_ROOTS` are served. A request names an absolute path; the server refuses `..`, empty or `.` segments, NUL bytes and relative paths. It then resolves symlinks with `realpath` and matches the *resolved* path against the roots, so a symlink out of a root is refused. Folders are never listed: the Files page comes from the server's own bounded walk of the roots.
- **Denylist, even inside the roots.** No wildcard may match a name that starts with `.` (`.git/`, `.env`), `node_modules`, a name ending in `.env`, `.pem`, `.key`, `.p12`, `.pfx`, `.crt` or `.kdbx`, an `id_rsa`-style key, or a name containing `token`, `secret`, `credential`, `passw`, `private-key` or `api-key`. Only segments the root spells out (such as `.claude`) may start with a dot. The file's own name is checked both before and after resolving symlinks.
- **Extension allowlist.** `.html .htm .mp4 .webm .png .jpg .jpeg .gif .webp .svg .pdf .md`. Anything else is refused, and Markdown is shown as escaped text.
- **Isolation: an opaque origin.** Every file response carries `Content-Security-Policy: sandbox ...` without `allow-same-origin`. A report runs in an opaque origin: it cannot read the dashboard's cookie or DOM, its requests to the dashboard carry `Origin: null` and no `SameSite=Strict` cookie, and its CSP adds `connect-src 'none'` and `form-action 'none'`. Scripts, popups and downloads stay allowed so interactive reports work. The action endpoints accept only the dashboard's exact origin, and the reads (peek) now also refuse any `Origin` header that is not the dashboard's. PDFs are the exception: Chrome cannot show a PDF in a sandboxed document, so they rely on the browser's PDF viewer isolation.
- **Auth: signed view links.** The sandboxed page's own `<img>` and `<video>` requests cannot carry the `SameSite=Strict` cookie, so files are opened by `/v/<expiry>.<depth>.<hmac>/<path>` links instead. The cookie-gated pages (the dashboard and Files) mint them.
  - The HMAC-SHA256 uses a random secret created at server start, and a link lasts 1 hour.
  - A link covers one file. An HTML report's link covers its artifact folder (`.claude/tmp/<folder>/`), so its relative images and videos load, but not a sibling task's folder.
  - The served file must still pass every check above.
  - Opening `/files` needs the cookie and refuses a navigation started by another site or by a sandboxed report.
- **Headers.** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (a link never leaks through `Referer`), `X-Frame-Options: DENY`. Files also carry `Cross-Origin-Resource-Policy: cross-origin`, because the sandboxed report is another origin from its own assets, and no `Cross-Origin-Opener-Policy`, because browsers refuse a sandboxed page that sends one.
- **No new surface.** The view links go through the same Host, Tailscale login and Funnel checks as everything else, so a leaked link is useless outside the tailnet and 127.0.0.1. Nothing changes in `tailscale serve`.
- **Revoking.**
  - Restart the dashboard server: every view link dies with its secret.
  - Delete `~/.local/state/agentctl/dashboard.key` and restart: every cookie dies too.
  - Start with `COORDINATOR_DASHBOARD_FILE_ROOTS=off`: the viewer is gone.

## Personal artifacts

The shared dashboard also serves Personal artifacts when its profile file
(`~/.config/agentctl/profiles/personal.env`) contains `AGENTCTL_FILE_ROOTS`, as in
`profiles/personal.env.example`. These colon-separated roots augment the defaults; they do
not replace another profile's folders. An explicit server-wide
`COORDINATOR_DASHBOARD_FILE_ROOTS` takes precedence over all profile roots, including `off`.
Restart the existing dashboard server after changing profile roots.

For Personal repo tasks, save final reports under `<workdir>/.claude/tmp/<task-id>/`.
For non-repo tasks, use `~/workspace/github/.claude/tmp/<task-id>/`. Copy finished output
from `/tmp` into that folder, including relative image/video assets, and include the final
absolute path in the task's ledger report. **Files** discovers HTML, videos and PDFs within
30 seconds; task notes link other supported types too. Personal drawers have their own file
links, and Files uses `personal/<task-id>` links so matching task names across profiles do
not point at the wrong card. Each profile owns the files under its own roots (Twism: the
defaults or the explicit global roots; Personal: exactly its `AGENTCTL_FILE_ROOTS`), and a
task's notes only claim and link files its profile owns, so a Personal note naming a Twism path
stays plain text, and the reverse. Ambiguous folder-only ownership is left unattributed; a
ledger path resolves it.

**Files** has All / Twism / Personal chips; each file carries its profile's badge, and the
chosen chip is remembered per browser (All by default). `/files?profile=personal` opens on one
profile; an unknown profile is refused.

Open **Files** from the existing authenticated phone dashboard, or the task drawer. The
sample is `~/workspace/github/.claude/tmp/sample-html/sample.html` on `personal/sample-html`.
Use a newly minted link from the dashboard if an individual `/v/` link has expired (one hour)
or the server has restarted. This uses the same cookie, Tailscale restrictions and sandboxed
viewer; no proxy or tailnet policy change is needed.

## Still to check on a real phone

- iOS Safari and Android Chrome keep the `SameSite=Strict` cookie after the key redirect and after a home-screen launch.
- The keyboard does not cover the reply box, and the drawer scrolls while the peek panel refreshes.
- The page and peek keep working when the phone switches between Wi-Fi and mobile data (Tailscale reconnects).
- Videos play and seek in the player on iOS Safari and Android Chrome. Desktop Chromium and WebKit do, through Range requests. A report opened from a home-screen launch shows in the browser's in-app view.
