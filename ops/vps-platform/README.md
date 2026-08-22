# platform.fabricxai.com — the shared-host deployment

This directory is the operating record for the `fabricxai-generic` instance that runs at
**https://platform.fabricxai.com** on the fabricxai VPS (`169.58.141.169`), **beside**
the baraka factory deployment (`/opt/fabricxai`, `baraka.fabricxai.com`). Set up
2026-08-22.

## How a change ships

```
git push origin main
  → CI (.github/workflows/ci.yml): nine quality jobs, then `publish`
  → ghcr.io/fabricxai/fabricxai-generic:<sha>  (+ the moving `:main` tag)
  → the VPS timer (autodeploy.sh, every 2 min) sees `:main` moved
  → deploy.sh pins .env.production to the DIGEST, pulls, re-runs migrate, up -d app worker
  → live on platform.fabricxai.com  (worst case ~CI time + 2 minutes)
```

Nothing deploys from a red main — `publish` needs all nine jobs green, so a failing
build simply never reaches the registry and the poller finds nothing new.

- **Watch a deploy land:** `journalctl -u fabricxai-platform-autodeploy.service -f`
- **Roll back:** `systemctl stop fabricxai-platform-autodeploy.timer` (or it rolls
  forward again), then `ops/vps-platform/deploy.sh sha256:<previous digest>`. Previous
  digests are in the journal and in `git log` of CI job summaries. Migrations are
  forward-only — rolling back across a destructive migration needs
  `docs/runbooks/restore.md`, not a redeploy.
- **Manual push-button path:** `.github/workflows/deploy.yml` (tag `v*`) exists but is
  dormant until the three `DEPLOY_*` repo secrets are set (needs repo admin).

## Topology on the shared host

Only one process can own 80/443, and the baraka stack's Caddy (`fxai-caddy`) already
does. So that Caddy fronts **both** domains, and this stack runs with its own caddy
parked behind a compose profile — see `docker-compose.platform.yml` (why each deviation
exists is written in that file). The hop from the shared Caddy into this project crosses
compose projects over the pre-created external `edge` network:

```
                      ┌────────────────────── VPS ──────────────────────┐
   baraka.fabricxai.com ─┐                                              │
                         ├─ fxai-caddy (80/443) ── app:3000 (baraka)    │
   platform.fabricxai.com┘        │ edge network                        │
                                  ├── platform-app:3000   (fxp-app)     │
                                  └── platform-minio:9000 (fxp-minio)   │
```

Every compose command needs both files and the explicit project name:

```bash
cd /opt/fabricxai-platform
docker compose -p fabricxai-platform \
  -f docker-compose.prod.yml -f docker-compose.platform.yml \
  --env-file .env.production ps
```

## The recorded drift on the baraka checkout

Serving two domains from `fxai-caddy` required two host-local edits inside
`/opt/fabricxai` that its own repo (`fabricxai-poc-baraka`) does not carry — a future
`git pull` there will conflict on them, and this section is where the resolution is
written down:

1. `docker/caddy/Caddyfile` — a `platform.fabricxai.com` site block appended (proxy to
   `platform-app:3000`, `/fabricxai/*` to `platform-minio:9000`, own access log). Marked
   in the file with `# ── platform.fabricxai.com`.
2. `docker-compose.prod.yml` — the caddy service joined `[default, edge]`, and a
   top-level `networks: edge: external: true` was added. A `.bak-<timestamp>` of each
   edited file sits next to it.

## What this deployment deliberately does not have

- **No backups.** `.env.backup` is absent, exactly like the baraka instance: WAL
  archiving fails loudly in `fxp-postgres` logs by design. This instance holds demo
  data; the day it holds anything real, `docs/runbooks/deploy.md` §3 (offsite bucket +
  rehearsed restore) stops being optional.
- **Trimmed Postgres.** `.env.production` sets `POSTGRES_SHARED_BUFFERS=256MB` and
  `POSTGRES_EFFECTIVE_CACHE_SIZE=1GB` — two databases share one 12 GB box and baraka
  keeps the runbook sizing.

Secrets live only in `/opt/fabricxai-platform/.env.production` (0600) and
`secrets/pgbouncer-userlist.txt` (0640, group 70) — generated on the host, never in a
repo or transcript.
