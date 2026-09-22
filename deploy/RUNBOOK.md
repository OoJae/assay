# ASSAY production runbook

Everything ASSAY runs in production is in this directory. Nothing here is a description of the
host; it is the host's configuration, and the host is built from it.

Host: **Sonar-VPS2**, Tencent Lighthouse, `170.106.175.243`. Ubuntu, 3.7 GB RAM (~1 GB available),
nginx 1.24, node via `pnpm`. Checkout lives at `/home/ubuntu/assay`.

## What runs

| unit | what it does | port |
|---|---|---|
| `assay-agent.service` | OpenServ agent; answers paid x402 tasks over a WebSocket tunnel | none inbound |
| `assay-mcp.service` | MCP server over SSE, mounted at `/assay-mcp/` on the `sonar.my.id` cert | `127.0.0.1:7379` |
| `assay-sweep.timer` | re-sweeps Robinhood Chain every 30 min and republishes `data/findings.json` | — |
| `nginx` | TLS for `https://sonar.my.id/assay-mcp/` → `127.0.0.1:7379` | 80, 443 |

## Install

```bash
sudo cp deploy/assay-*.service deploy/assay-sweep.timer /etc/systemd/system/
sudo cp deploy/assay.logrotate /etc/logrotate.d/assay
sudo cp deploy/assay-mcp.nginx.conf /etc/nginx/sites-available/assay-mcp
sudo ln -sf /etc/nginx/sites-available/assay-mcp /etc/nginx/sites-enabled/assay-mcp
sudo systemctl daemon-reload
sudo systemctl enable --now assay-agent assay-mcp assay-sweep.timer
sudo nginx -t && sudo systemctl reload nginx
```

## TLS

**Currently live at `https://sonar.my.id/assay-mcp/`**, mounted as a `location` block on the
existing `sonar.my.id` certificate. That needed no new DNS and no new cert, which is why it is what
is deployed.

To move it to its own subdomain — preferable, because a bare origin is one fewer thing for an MCP
client to get wrong — add a DNS **A record** for `assay-mcp.sonar.my.id` → `170.106.175.243`, then:

```bash
dig +short assay-mcp.sonar.my.id      # must return 170.106.175.243 before proceeding
sudo certbot certonly --cert-name sonar.my.id -d sonar.my.id -d assay-mcp.sonar.my.id \
     --webroot -w /var/www/html
sudo systemctl reload nginx
```

`certbot.timer` is already enabled and handles renewal.

## Firewall

⚠️ This is a **Tencent Lighthouse** instance. Its firewall is the **Lighthouse firewall panel**,
not the CVM *security groups* page — they are different products with similar screens, and a rule
added in the wrong one silently does nothing. Ports 80 and 443 must be open. **Port 7379 should
NOT be open**: it was, while the MCP server bound `0.0.0.0`, and closing it is part of moving
behind nginx. `ufw` on the instance is a second layer, not the effective one.

## Checks

**Does the host still match version control?** Run this first — the units drifted once, with
`MCP_PUBLIC_PATH` set on the box and absent from the repo, which quietly falsified the claim at the
top of this file.

```bash
cd /home/ubuntu/assay
for u in assay-agent assay-mcp assay-sweep; do
  diff -q /etc/systemd/system/$u.service deploy/$u.service || echo "DRIFT: $u"
done
diff -q /etc/logrotate.d/assay deploy/assay.logrotate || echo "DRIFT: logrotate"
```

```bash
systemctl is-active assay-agent assay-mcp
systemctl list-timers assay-sweep.timer
curl -s https://sonar.my.id/assay-mcp/health
curl -sI https://sonar.my.id/assay-mcp/health | head -3
# the sweep is advancing -- blockNumber must move between runs
jq -r '.blockNumber, .observedAt' /home/ubuntu/assay/data/findings.json
```

A port check is **not** a health check. The agent's tunnel can reach a terminal `failed` state
while the express listener keeps the process alive and the port open — which is exactly what
happened once, invisibly. `serve-remote.ts` now polls the tunnel state and exits non-zero on a
terminal state so `Restart=always` can do its job, and logs a real capability round-trip every
five minutes. Grep `agent.log` for `health ok` / `health FAILED` and for `tunnel state:`.

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
sudo systemctl restart assay-agent assay-mcp
```

**One-time setup, without which that command aborts.** The sweep timer rewrites
`data/findings.json` every 8 minutes and the file is git-tracked, so a bare `git pull` fails with
*"local changes would be overwritten"* — and because of the `&&`, nothing restarts, leaving the host
on old code while the command looks like it ran. Tell git the host's copy is allowed to diverge:

```bash
cd /home/ubuntu/assay && git update-index --skip-worktree data/findings.json
git ls-files -v data/findings.json      # expect: S data/findings.json
```

Divergence is the intended state here. The host regenerates that file every 8 minutes and serves it
at `/assay-mcp/findings.json`, which is where the wall actually reads from; the committed copy is
only the wall's fallback for when this host is unreachable. `git checkout -- data/findings.json`
would "fix" the conflict by throwing away the fresh sweep and serving a stale board until the next
tick — which is exactly what happened once.

The agent runs with **no signing key** — no `WALLET_PRIVATE_KEY`, no `BUYER_PRIVATE_KEY`, no SERV
key. This is enforced, not documented: `serve-remote.ts` refuses to start if any of them is in
the environment. A compromise of this host can serve audit answers; it cannot move funds, touch
the ERC-8004 identity, or spend inference credits.
