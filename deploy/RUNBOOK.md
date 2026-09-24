# ASSAY production runbook

Everything ASSAY runs in production is in this directory. Nothing here is a description of the
host; it is the host's configuration, and the host is built from it. The one exception is the
`include` line in the `sonar.my.id` server block, which belongs to another project's file; the
drift check below covers what it pulls in. Until the nginx part of Install has been run, the host's
`/assay-mcp/` route is an older hand edit instead (see Install).

Host: **Sonar-VPS2**, Tencent Lighthouse, `170.106.175.243`. Ubuntu, 3.7 GB RAM (~1 GB available),
nginx 1.24, node at `/usr/bin/node`, pnpm 12. Checkout lives at `/home/ubuntu/assay`; the live
board lives outside it, in `/home/ubuntu/assay-data`.

The website is not on this host. It is deployed from `web/` to Vercel; [The website](#the-website)
covers its routes, the 3D kill switch and rollback.

## What runs

| unit | what it does | port |
|---|---|---|
| `assay-agent.service` | OpenServ agent; answers paid x402 tasks over a WebSocket tunnel | `*:7378` — see Firewall; nothing should reach it |
| `assay-mcp.service` | MCP server (SSE and Streamable HTTP), mounted at `/assay-mcp/` on the `sonar.my.id` cert | `127.0.0.1:7379` |
| `assay-sweep.timer` | re-sweeps Robinhood Chain every 8 min and republishes the board, unless the guard refuses | — |
| `nginx` | TLS for `https://sonar.my.id/assay-mcp/` → `127.0.0.1:7379`, plus a rate-limit backstop | 80, 443 |

**Never run the agent anywhere else while this host runs it.** `pnpm serve` or `pnpm serve:remote`
on a laptop with the production agent's credentials would share its tunnel. The unit sets
`FORCE_TUNNEL=true` so a reconnect takes over a stale registration instead of dying on it (about
one hourly reconnect in thirty was refused, once for 83s), and with that on both sides the two
instances evict each other on every reconnect.

## Install

```bash
cd /home/ubuntu/assay
sudo cp deploy/assay-*.service deploy/assay-sweep.timer /etc/systemd/system/
sudo cp deploy/assay.logrotate /etc/logrotate.d/assay

# nginx, in two parts: rate-limit zones may only live in http{}, a location only in server{}
sudo sed -n '/^# BEGIN http/,/^# END http/p'     deploy/assay-mcp.nginx.conf \
  | sudo tee /etc/nginx/conf.d/assay-mcp-limits.conf >/dev/null
sudo sed -n '/^# BEGIN server/,/^# END server/p' deploy/assay-mcp.nginx.conf \
  | sudo tee /etc/nginx/snippets/assay-mcp.conf >/dev/null
# then, once, in the 443 server block of /etc/nginx/sites-available/sonar, replace the inline
# `location /assay-mcp/ { ... }` with:   include snippets/assay-mcp.conf;

mkdir -p /home/ubuntu/assay-data
sudo systemctl daemon-reload
sudo systemctl enable --now assay-agent assay-mcp assay-sweep.timer
sudo nginx -t && sudo systemctl reload nginx
```

The stock Ubuntu `nginx.conf` includes `conf.d/*.conf` inside `http{}` (checked on the host). An
earlier version of this section installed a server block for `assay-mcp.sonar.my.id`, a name with
no DNS record, while the live route was a hand edit that no file here produced. Rebuilding from
the repo did not restore the endpoint the README and the agent card publish. The config file becomes
the live route once the two parts and the `include` above are installed. On 2026-09-23 they were
not: `conf.d` and `snippets` held no `assay-mcp` file and the inline hand edit still served
`/assay-mcp/`, and the drift check below reports exactly that until the install is done.

## TLS

**Live at `https://sonar.my.id/assay-mcp/`**, mounted as a `location` on the existing
`sonar.my.id` certificate. That needed no new DNS and no new cert, which is why it is what is
deployed.

To move it to its own subdomain later — preferable, because a bare origin is one fewer thing for an
MCP client to get wrong — add a DNS **A record** for `assay-mcp.sonar.my.id` → `170.106.175.243`,
then:

```bash
dig +short assay-mcp.sonar.my.id      # must return 170.106.175.243 before proceeding
sudo certbot certonly --cert-name sonar.my.id -d sonar.my.id -d assay-mcp.sonar.my.id \
     --webroot -w /var/www/html
sudo systemctl reload nginx
```

and remove `MCP_PUBLIC_PATH` from `assay-mcp.service`. `certbot.timer` is already enabled and
handles renewal.

## Firewall

⚠️ This is a **Tencent Lighthouse** instance. Its firewall is the **Lighthouse firewall panel**,
not the CVM *security groups* page — they are different products with similar screens, and a rule
added in the wrong one silently does nothing. Ports 80 and 443 must be open. **Ports 7378 and 7379
must NOT be open.** 7379 was, while the MCP server bound `0.0.0.0`; it now binds loopback.

**7378 cannot be bound to loopback.** The OpenServ SDK (2.4.1) calls `app.listen(port)` with no
host option, so the agent's express server listens on every interface even though tunnel mode only
needs loopback. It answers `/health` unauthenticated, and any other request costs a bcrypt compare
whose cost factor the client chooses. The Lighthouse panel is the only layer in front of it today:
**`ufw` is inactive** on the instance (an earlier version of this file called it "a second layer";
there was none). The recommended second layer, not yet applied, is one narrow persisted rule rather
than `ufw enable`, which would also need rules for 22, 80 and 443 to be right first time:

```bash
sudo iptables  -I INPUT -p tcp --dport 7378 ! -i lo -j DROP
sudo ip6tables -I INPUT -p tcp --dport 7378 ! -i lo -j DROP
sudo netfilter-persistent save      # from iptables-persistent; without it the rule dies on reboot
```

## Checks

**Does the host still match version control?** Run this first. The units drifted once, with
`MCP_PUBLIC_PATH` set on the box and absent from the repo, and a superseded
`assay-mcp-tunnel.service` — a Cloudflare quick tunnel from before TLS — survived on the host with
no counterpart here. Both quietly falsified the claim at the top of this file.

```bash
cd /home/ubuntu/assay
for u in assay-agent assay-mcp assay-sweep; do
  diff -q /etc/systemd/system/$u.service deploy/$u.service || echo "DRIFT: $u"
done
diff -q /etc/systemd/system/assay-sweep.timer deploy/assay-sweep.timer || echo "DRIFT: timer"
diff -q /etc/logrotate.d/assay deploy/assay.logrotate || echo "DRIFT: logrotate"
diff <(sed -n '/^# BEGIN http/,/^# END http/p' deploy/assay-mcp.nginx.conf) \
     /etc/nginx/conf.d/assay-mcp-limits.conf >/dev/null || echo "DRIFT: nginx limits"
diff <(sed -n '/^# BEGIN server/,/^# END server/p' deploy/assay-mcp.nginx.conf) \
     /etc/nginx/snippets/assay-mcp.conf >/dev/null || echo "DRIFT: nginx location"
grep -q 'include snippets/assay-mcp.conf;' /etc/nginx/sites-available/sonar || echo "DRIFT: include"

# Nothing should be listed here that is not in deploy/.
ls /etc/systemd/system/assay*
```

⚠️ **Do not reinstate a tunnel to expose 7379.** The endpoint is served through nginx so that TLS
terminates in one place and `MCP_TRUSTED_PROXIES` can name that one peer. A second path in — a
Cloudflare quick tunnel, ngrok, anything — arrives from an address the limiter does not trust, so
`X-Forwarded-For` is ignored and every caller through it collapses into a single bucket. The per-IP
limit silently becomes a global one.

**Is everything up, and is the sweep still publishing?**

```bash
systemctl is-active assay-agent assay-mcp
systemctl list-timers assay-sweep.timer          # NEXT must be a time, not "-"
curl -s https://sonar.my.id/assay-mcp/health     # ok, transports, and the sweep's state
curl -s -o /dev/null -w '%{http_code}\n' https://sonar.my.id/assay-mcp/health/sweep   # 200, or 503

# the LIVE board, not the tracked copy in the checkout: blockNumber must move between runs,
# and the age should stay under ~15 minutes
f=/home/ubuntu/assay-data/findings.json
jq -r '.blockNumber, .observedAt' "$f"
echo "$(( $(date +%s) - $(date -d "$(jq -r .observedAt "$f")" +%s) ))s old"

# the sweep's own account of its last run: published or refused, and why
jq . /home/ubuntu/assay-data/sweep-status.json
```

An earlier version of this check read `/home/ubuntu/assay/data/findings.json`, the tracked copy,
which only `git pull` changes. It showed a board ten hours old while the sweep was healthy.

A **404** from `/health/sweep`, whose body lists the server's endpoints and has no `/mcp`, means the
host runs code from before this endpoint and Streamable HTTP existed (it ran `9c70c5e` on
2026-09-23): deploy, as below.

`/health` stays 200 while the MCP process serves, so a stale board does not make the MCP look down.
`/health/sweep` answers **503** when the board is more than 20 minutes old or the last sweep refused
to publish.

**The external monitor** is `.github/workflows/monitor.yml`, so it needs no account beyond GitHub.
Every 15 minutes it checks that `/findings.json` is at most 20 minutes old and non-empty, that
`/health/sweep` answers (a 503 is noted in the run summary, not alerted on, since one refusal is
normal and a sustained one ages the board past the first check), that the wall at `/wall` renders
without `LIVE FEED UNREACHABLE`, and that the landing at `/` answers 200. An incident opens one
`sweep-monitor` issue mentioning the owner and fails the run; a change in the problems adds a
comment; recovery closes the issue. Run it by hand with `gh workflow run monitor`. GitHub disables
scheduled workflows in a public repo after 60 days without activity, and a disabled monitor fails
silently: re-enable it from the Actions tab.

The wall was at `/` until the redesign. Push a `monitor.yml` that probes `/wall` only once
production serves `/wall`, and point it back at `/` for as long as a rollback past the redesign
stands (see [Rollback](#rollback)); otherwise the monitor reports a 404 as an outage.

**Why a sweep refuses.** `scripts/sweep.ts` compares each new board with the one it would replace
(`src/sweep/guard.ts`) and exits 2 without publishing when more than 10% of assets could not be
read, the oracle cohort missed its read quorum, a board with findings would be replaced by an empty
one, `SHARE_COUNT_MISREAD_RISK` findings fell by more than 20% (held for at most 45 minutes), or the
run covered fewer than 80% of the assets the published board did. The unit counts exit 2 as
success, so a refusal never marks it failed; `sweep-status.json` and `/health/sweep` are where it
shows. `--force` publishes anyway; use it only when the smaller board is right, such as a registry
that really shrank. A run is stopped after 7 minutes (`TimeoutStartSec`), so one hung socket cannot
freeze the timer.

A port check is **not** a health check. The agent's tunnel can reach a terminal `failed` state
while the express listener keeps the process alive and the port open — which is exactly what
happened once, invisibly. `serve-remote.ts` polls the tunnel state every 5 seconds and exits
non-zero on a terminal state so `Restart=always` can do its job, and logs a real capability
round-trip every five minutes. Grep `agent.log` for `health ok` / `health FAILED`, `tunnel state:`
and `Tunnel exists`.

## A known-better production posture, deliberately not taken yet

OpenServ's own SDK skill (`.agents/skills/openserv-agent-sdk/SKILL.md`) says the tunnel is the
**development** path, and that production should set `DISABLE_TUNNEL=true` and serve the agent's
HTTP server at a public `endpointUrl` instead.

That would remove the entire failure class the watchdog above exists to catch — a tunnel that
reaches a terminal `failed` state cannot happen if there is no tunnel. nginx and a valid
certificate are already here, so the serving half is nearly free.

It is **not** done yet because the endpoint URL is bound at provision time, and getting it wrong
takes the paid x402 endpoint down entirely, whereas the current setup is verified working. Recorded
here rather than left as an unexamined default: the watchdog is a mitigation, not the right answer.

## Logs

`agent.log`, `mcp.log`, `sweep.log` in `/home/ubuntu/assay`. Rotated daily, 7 kept, 50 MB cap,
via `/etc/logrotate.d/assay`. Unrotated they grow unbounded on a box with ~1 GB free, and a full
disk takes down the paid endpoint and the MCP server together.

Every `agent.log` line starts with an ISO timestamp, and each paid request logs one line:
`request capability=… usd=… <inputs> outcome=… ms=… workspace=… task=…`. **For a payment dispute,
OpenServ's task history for the workspace is the record of truth**; the `workspace=` and `task=`
fields are how a log line is matched to it.

⚠️ The config must say **`su root root`**, not `su ubuntu ubuntu`. The units write with
`StandardOutput=append:`, which opens the file *before* dropping to `User=ubuntu`, so the logs are
`root:root` even though the service runs as ubuntu. With `su ubuntu ubuntu` logrotate exits 1 with
`Permission denied` and rotates nothing — silently, since the timer does not report it. Verify the
rotation actually works rather than assuming it does:

```bash
sudo logrotate -f /etc/logrotate.d/assay; echo "exit=$?"   # must be 0
ls -la /home/ubuntu/assay/*.log*                            # .log.1 should appear
```

## Deploying a change

```bash
cd /home/ubuntu/assay && git pull && pnpm install --frozen-lockfile
```

After a pull that changes `pnpm-workspace.yaml`, the first `pnpm` command also runs one automatic
install of about 10 seconds before it does anything else. `pnpm install --frozen-lockfile` exits 0
only while the committed lockfile matches every `package.json`, `web/` included.

Then restart only what the change touched, each once:

- **A unit file changed** (anything under `deploy/*.service` or the timer): copy it into
  `/etc/systemd/system/` and `sudo systemctl daemon-reload` first. `TimeoutStartSec` on the sweep
  takes effect at its next run; nothing needs restarting for it.
- **Agent code, or `assay-agent.service`:** before restarting, confirm the agent's `.env` holds
  none of the keys it refuses to start with. This prints a count, never a value, and must print 0:

  ```bash
  grep -cE '^(WALLET_PRIVATE_KEY|BUYER_PRIVATE_KEY|SERV_API_KEY|OPENSERV_USER_API_KEY)=.' /home/ubuntu/assay/.env
  ls /home/ubuntu/assay/.openserv.json 2>/dev/null   # must print nothing
  ```

  Then `sudo systemctl restart assay-agent`, and grep `agent.log` for `REFUSING TO START`, and for
  `Tunnel exists` across the next few hourly reconnects.
- **MCP code, or `assay-mcp.service`:** `sudo systemctl restart assay-mcp`, then
  `systemctl status assay-mcp` and `systemd-analyze security assay-mcp`. Check `/health`,
  `/health/sweep`, an SSE `tools/list`, and a Streamable HTTP initialize:

  ```bash
  curl -s -X POST https://sonar.my.id/assay-mcp/mcp -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"runbook","version":"0"}}}'
  ```

  `MCP_TRUSTED_PROXIES` must still be `127.0.0.1,::1` in the unit: with 6 streams per address, a
  missing trusted proxy would make every client share nginx's address and refuse each other. The
  process warns at startup when the list is empty.
- **`deploy/assay-mcp.nginx.conf`:** reinstall both parts as under Install, then
  `sudo nginx -t && sudo systemctl reload nginx`.
- **Sweep code:** nothing. The timer runs the new code at its next tick.

**One-time setup, without which `git pull` aborts.** The live board must live **outside the git
working tree**:

```bash
mkdir -p /home/ubuntu/assay-data
cd /home/ubuntu/assay && git checkout -- data/findings.json   # release the tracked copy, once
git update-index --no-skip-worktree data/findings.json 2>/dev/null || true
```

The units set `ASSAY_FINDINGS_PATH=/home/ubuntu/assay-data/findings.json`, so the sweep writes
there and the MCP server serves from there. Beside it the sweep writes `sweep-status.json` and
`findings.private.json`, the unredacted board with the named-integrator rows. Nothing serves the
private file; the public board, the wall and the MCP only ever see the redacted one.

**A manual sweep on the host must set the same path**, or it writes the tracked
`data/findings.json` and the next `git pull` aborts:

```bash
ASSAY_FINDINGS_PATH=/home/ubuntu/assay-data/findings.json pnpm sweep
```

Why not simply let the tracked file diverge: the sweep rewrites it every 8 minutes, so `git pull`
aborts with *"local changes would be overwritten"*, and because of the `&&` nothing restarts —
leaving the host on old code while the command looks like it ran. **`git update-index
--skip-worktree` does not fix this**, which is worth stating because it looks like it should:
verified in a scratch repo, with a local modification *and* an upstream change to the same path,
pull still exits *"Please commit your changes or stash them before you merge."* And
`git checkout -- data/findings.json` "fixes" it by discarding the fresh sweep and serving a stale
board until the next tick — which is exactly what happened once.

The committed `data/findings.json` stays in the repo as the **wall's fallback** for when this host
is unreachable. It is not the live board, and it is redacted like the live one.

## The website

The site is the Next.js app in `web/`, on Vercel, deployed from a laptop with `vercel --prod` run
in `web/` (the CLI's link to the project is `web/.vercel`, gitignored). Vercel uploads only `web/`
and installs it with npm and no lockfile, which is why `web/package.json` pins exact versions.
Every route below except the static files reads the live board from
`https://sonar.my.id/assay-mcp/findings.json` and falls back to the committed one when it cannot;
the landing and the wall both say which one they are showing.

| route | what it is | how it renders |
|---|---|---|
| `/` | The landing: one Stock Token bar assayed in five steps (01 weigh to 05 re-fetch), who reads it wrong, how to use ASSAY, the way into the wall | static, rebuilt from the live board at most once every 60 s; its provenance line says *live board* or *committed snapshot*, with the block |
| `/wall` | The findings wall. It was `/` until the redesign | on every request |
| `/f/<id>` | One finding, as a certificate | on every request |
| `/pricing` | Every tier, its price, and whether it can be bought today | on every request |
| `/og` | The social card image | on every request |
| `/agent-card.json`, `/attestations/*` | Documents third parties fetch and hash: the ERC-8004 token points at the card, and each attestation's on-chain hash is of its exact bytes. They never move and are never edited | static files |
| `/landing/v1/*` | The landing's poster frames, cached as immutable for a year; a changed frame ships under `v2`, never over `v1` | static files |

Links to the wall's old anchors (`/#check`, `/#use-it`, `/#exposure` and the rest) land on the same
section of `/wall`. A fragment never reaches the server, so the landing does this in the browser;
curl cannot check it.

### Deploying the site

```bash
cd web
vercel ls        # note the Production deployment serving the domain now: the rollback target
vercel --prod
```

Then check it from outside:

```bash
S=https://assay-steel.vercel.app
for p in / /wall /f/CRWD-share-count /pricing; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$S$p")" "$p"   # 200 each
done
curl -s -o /dev/null -w '%{http_code}\n' "$S/f/nope"                            # 404
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$S/og"                # 200 image/png
curl -s "$S/wall" | grep -c 'LIVE FEED UNREACHABLE'                             # 0

# Served bytes must equal git's: an attestation's on-chain hash is of exactly these bytes.
cd "$(git rev-parse --show-toplevel)"
for f in agent-card.json attestations/95265.json \
  attestations/95374/0x8e9f35901bb72c4efb62d6818a14d644c523513d5ba117ed4fc8e9296ff21aeb.json \
  attestations/95374/0x8e9f35901bb72c4efb62d6818a14d644c523513d5ba117ed4fc8e9296ff21aeb.request.json; do
  cmp -s <(curl -s "$S/$f") <(git show "HEAD:web/public/$f") && echo "same  $f" || echo "DIFFERS  $f"
done
npx tsx scripts/verify-attestation.ts                                           # VERIFIES
```

### The 3D kill switch

The landing's assay scene runs in one of three modes, chosen in the browser before the first paint.
*webgl* is the default. *posters* keeps the same scrolling stage but crossfades still frames of the
scene; it is used without WebGL2, with Save-Data on, on low-memory devices, or after the page's own
frame-time guard gives up on a slow device for the rest of that tab's session. *static* stacks the
frames and captions in plain flow, for reduced motion and no JavaScript. Every number and byte is
page text, never part of a frame, so the fallbacks lose motion, not information.

To put everyone on posters, set the kill switch and rebuild:

```bash
cd web
printf off | vercel env add NEXT_PUBLIC_LANDING_3D production
vercel --prod
```

A `NEXT_PUBLIC_` variable is compiled into the page when it is built, so setting it changes nothing
until that production build; there is no switch that acts on a running deployment. To undo it:
`vercel env rm NEXT_PUBLIC_LANDING_3D production`, then `vercel --prod` again.

Use it when the scene misbehaves on some class of device (dropped frames, a crashed GPU process,
WebGL contexts leaking across navigations) and the rest of the site is fine. For one browser, with
no deploy, `?3d=0` shows the posters and `?3d=1` forces WebGL; the second is for testing only.

### Rollback

When the site is broken, not just the scene, put the previous production deployment back. It takes
effect at once, with no build:

```bash
cd web
vercel rollback                      # the production deployment before the current one
vercel rollback <deployment-url>     # or a specific one
vercel rollback status
```

A Hobby account can only go back to the deployment immediately before the current one. Two things
follow from a rollback:

- Vercel stops assigning the production domain to new production deployments. Once a fix is
  deployed with `vercel --prod`, `vercel promote <its deployment URL>` puts it live.
- A rollback past the redesign puts the wall back at `/`, and `/wall` becomes a 404. Point the
  monitor's `WALL` at `https://assay-steel.vercel.app/` while the rollback stands, or expect an
  incident within 15 minutes. `/f/<id>`, `/pricing`, `/agent-card.json` and `/attestations/*` have
  the same paths on both sides, so the agent card and the attestation hashes are unaffected.

### Local builds

```bash
cd web
NEXT_DIST_DIR=.next-local npx next build
NEXT_DIST_DIR=.next-dev npx next dev -p 3001
```

Give each build and each dev server its own directory: two processes sharing `.next` corrupt
whichever finishes second. `.next-*` is gitignored. Unset, it is `.next`, which is what Vercel
builds with. Both commands also rewrite `web/next-env.d.ts` and `web/tsconfig.json` to point at the
directory they used, so `git diff web/next-env.d.ts web/tsconfig.json` must be empty before a
commit; restore the two files from git unless you meant to change them.

## Secrets

The agent runs with **no signing key** — no `WALLET_PRIVATE_KEY`, no `BUYER_PRIVATE_KEY` — and no
inference or account key: no `SERV_API_KEY`, no `OPENSERV_USER_API_KEY`, and no `.openserv.json`
in the working directory. This is enforced, not documented: `serve-remote.ts` refuses to start if
any of them is present. (An earlier version of this paragraph claimed that for the SERV key while
only the two wallet keys were checked.) It holds only the agent's own `OPENSERV_API_KEY` and
`OPENSERV_AUTH_TOKEN`, which can receive and answer tasks and nothing else. A compromise of this
host can serve audit answers; it cannot move funds, touch the ERC-8004 identity, spend inference
credits or reconfigure the paid workflows.

The MCP unit is narrower still. It runs `node_modules/.bin/tsx` directly rather than through pnpm
(pnpm rewrites a state file in `node_modules` on every script, which was the only reason the unit
could write to the tree), has no `ReadWritePaths` at all, and cannot see `.env`, `.openserv.json`
or `~/.assay`. A future change that makes the MCP write a file needs a `ReadWritePaths` entry, or
it fails at runtime.

**The OpenServ account behind both paid workflows is not on this host, and has one credential.**
The account was created by signing in with the wallet `0x0C3A…14B5`, whose key is lost, and signing
in with the current wallet reaches a different, empty account. Its only admin credential is the
`userApiKey` in `.openserv.json` on the operator's laptop (mode 600, gitignored, with dated copies
at `~/.assay/openserv.json.backup.<time>`). Losing it would freeze the workflow configuration —
payTo, prices, triggers — but not the live endpoints, which run on this host's agent credentials.
Never "rotate" it by re-running `provision()`. Before revoking any key, confirm it is a SERV console
key and not this one.
