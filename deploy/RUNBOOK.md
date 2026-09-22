# ASSAY production runbook

Everything ASSAY runs in production is in this directory. Nothing here is a description of the
host; it is the host's configuration, and the host is built from it.

Host: **Sonar-VPS2**, Tencent Lighthouse, `170.106.175.243`. Ubuntu, 3.7 GB RAM (~1 GB available),
nginx 1.24, node via `pnpm`. Checkout lives at `/home/ubuntu/assay`.

## What runs

| unit | what it does | port |
|---|---|---|
| `assay-agent.service` | OpenServ agent; answers paid x402 tasks over a WebSocket tunnel | none inbound |
| `assay-mcp.service` | MCP server over SSE | `127.0.0.1:7379` |
| `assay-sweep.timer` | re-sweeps Robinhood Chain every 30 min and republishes `data/findings.json` | — |
| `nginx` | TLS for `assay-mcp.sonar.my.id` → `127.0.0.1:7379` | 80, 443 |

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

The box already holds a Let's Encrypt cert for `sonar.my.id`. Extend it to the MCP subdomain —
this needs the DNS A record to resolve first:

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

```bash
systemctl is-active assay-agent assay-mcp
systemctl list-timers assay-sweep.timer
curl -sI https://assay-mcp.sonar.my.id/sse | head -3
curl -s https://assay-mcp.sonar.my.id/health
# the sweep is advancing -- blockNumber must move between runs
jq -r '.blockNumber, .observedAt' /home/ubuntu/assay/data/findings.json
```

A port check is **not** a health check. The agent's tunnel can reach a terminal `failed` state
while the express listener keeps the process alive and the port open — which is exactly what
happened once, invisibly. `serve-remote.ts` now polls the tunnel state and exits non-zero on a
terminal state so `Restart=always` can do its job, and logs a real capability round-trip every
five minutes. Grep `agent.log` for `health ok` / `health FAILED` and for `tunnel state:`.

## Logs

`agent.log`, `mcp.log`, `sweep.log` in `/home/ubuntu/assay`. Rotated daily, 7 kept, 50 MB cap,
via `/etc/logrotate.d/assay`. Before that existed they grew unbounded on a box with ~1 GB free,
and a full disk takes down the paid endpoint and the MCP server together.

## Deploying a change

```bash
cd /home/ubuntu/assay && git pull && pnpm install --frozen-lockfile
sudo systemctl restart assay-agent assay-mcp
```

The agent runs with **no signing key** — no `WALLET_PRIVATE_KEY`, no `BUYER_PRIVATE_KEY`, no SERV
key. This is enforced, not documented: `serve-remote.ts` refuses to start if any of them is in
the environment. A compromise of this host can serve audit answers; it cannot move funds, touch
the ERC-8004 identity, or spend inference credits.
