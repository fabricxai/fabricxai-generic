# Runbook · deploy

One VPS, one factory. First deploy is §1–§4; every deploy after that is §5, which is
three commands.

**Sizing:** 6 vCPU / 12GB / 200GB **NVMe** carries one factory (~2,400 workers, 20 lines)
comfortably. The arithmetic, because "8GB is fine" was written before the memory limits
in `docker-compose.prod.yml` existed and did not add up against them:

| | |
|---|---|
| container limits | postgres 2G + app 1.2G + worker 900M + redis 700M + minio 700M = **5.5G** |
| caddy, pgbouncer, migrate | ~250M |
| Ubuntu + Docker daemon | ~1G |
| **left for page cache** | **~5G** — which is what decides whether reads feel fast |

8GB works and leaves almost nothing for cache; 12GB is the comfortable floor. CPU is not
the constraint — a floor posts ~50 hourly counts an hour, while `production_burst`
generates 600 writes a minute, about 12× a real peak.

**NVMe, not SATA.** Postgres is tuned for it (`random_page_cost=1.1`) and this schema
carries 24 indexes the stock value would talk the planner out of using. On other storage,
raise `POSTGRES_RANDOM_PAGE_COST` back toward 4 — it is a claim about the hardware, and a
wrong claim produces bad plans rather than an error.

**The backup repo does not live on that disk.** Same disk is not a backup, and pgBackRest
is also the thing most likely to fill it. Growth to watch is MinIO — documents are capped
at 25MB each and are what consumes the 200GB, not the database
comfortably. The memory limits in `docker-compose.prod.yml` add to ~5.5GB, leaving the
host room for the page cache Postgres actually runs on.

---

## 1 · Host baseline

```bash
# Docker from the official repo, not the distro's — the distro's is usually old enough
# to lack the compose features this file uses.
curl -fsSL https://get.docker.com | sh

# Firewall: only SSH and HTTP(S). Postgres, Redis and MinIO are NOT published by the
# compose file, but a firewall is what makes that a guarantee rather than a property of
# a file somebody may edit later.
ufw default deny incoming
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# Brute-force protection on SSH. The factory's static IP will be scanned within hours.
apt-get install -y fail2ban
systemctl enable --now fail2ban

# The factory reads Asia/Dhaka. Set the host to match so `docker logs` timestamps and
# the cron schedule in scripts/backup.sh mean what they appear to mean. The APPLICATION
# does not depend on this — every schedule registers its own tz — but the humans do.
timedatectl set-timezone Asia/Dhaka
```

DNS must already point at this host before §4: Caddy proves domain control over port 80
to get its certificate, and a name that does not resolve yet fails that.

---

## 2 · Secrets

```bash
git clone <repo> /opt/fabricxai && cd /opt/fabricxai
cp .env.production.example .env.production

# Generate every value marked GENERATE. Do not reuse a secret from anywhere else.
for k in BETTER_AUTH_SECRET; do echo "$k=$(openssl rand -base64 32)"; done
for k in POSTGRES_PASSWORD APP_DB_PASSWORD PGBOUNCER_AUTH_PASSWORD REDIS_PASSWORD MINIO_ROOT_PASSWORD; do
  echo "$k=$(openssl rand -base64 24 | tr -d '/+=')"
done
```

> Strip `/+=` from the database and Redis passwords. They end up inside connection URLs,
> where those characters need percent-encoding and will otherwise produce an
> authentication failure that reads exactly like a wrong password.

Then edit `.env.production`: paste those in, set `APP_DOMAIN`, `APP_URL`, `TLS_EMAIL`,
`IMAGE`, and the SMTP block. **`APP_URL` must be `https://`** — Better Auth infers
secure-cookie behaviour from its scheme, so `http://` silently issues non-secure session
cookies.

### The pooler's userlist

One line, for one low-privilege role. This is the only credential on the pooler's disk;
the application's password never leaves Postgres (migration 0070).

```bash
mkdir -p secrets && chmod 700 secrets
source .env.production
printf '"pgbouncer_auth" "%s"\n' "$PGBOUNCER_AUTH_PASSWORD" > secrets/pgbouncer-userlist.txt

# 0640, group 70 — NOT 0600. PgBouncer runs as uid 70 inside its container and reads this
# file through the bind mount, so a file owned 0600 by the deploy user is one the pooler
# cannot open. It then authenticates with no password at all and Postgres rejects it, which
# surfaces as `password authentication failed for user "pgbouncer_auth"` — a message that
# sends you looking for a wrong password rather than an unreadable file. Owner stays the
# deploy user so the file can still be regenerated on a rotation.
sudo chown "$(id -u)":70 secrets/pgbouncer-userlist.txt
chmod 640 secrets/pgbouncer-userlist.txt
```

`secrets/` is gitignored. Back up `.env.production` and
`PGBACKREST_REPO1_CIPHER_PASS` somewhere that survives this host, and **separately from
the backups it unlocks** — without the cipher pass the repository is unreadable
ciphertext, and there is no recovery from that. How long it takes to find that
passphrase is scored in the quarterly drill, because it is inside the RTO whether
anybody counts it or not.

---

## 3 · Backup configuration

Do this **before** the factory enters real data, not after.

```bash
cp .env.backup.example .env.backup && chmod 600 .env.backup
# Then fill it in. Two buckets, not one — pgBackRest expires objects and rclone deletes
# them, and pointing both at the same bucket means each destroys the other's work.
```

The repositories must be **somewhere else** — R2, B2, another region. A backup on the
host you are recovering from is not a backup.

> The variable names in that file are pgBackRest's, not ours:
> `PGBACKREST_REPO1_S3_BUCKET`, not `PGBACKREST_BUCKET`. pgBackRest does not expand
> `${VAR}` inside its config file — it takes the literal characters — so credentials
> reach it as environment variables it matches by name. Renaming them breaks archiving
> silently, which is the worst way for this to break.

```bash
export COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production --profile backup"

# The postgres image is BUILT here, not pulled: archive_command runs inside that
# container, so pgbackrest has to be in it. See docker/postgres/Dockerfile.
$COMPOSE build postgres
$COMPOSE up -d postgres

# Initialise the stanza once. Until this runs, archive_command fails every 5 minutes and
# says so in the postgres log — which is the intended behaviour, not a reason to delay.
$COMPOSE run --rm backup --stanza=fabricxai stanza-create

# Prove the round trip: this forces a WAL switch and confirms the segment reaches the
# repository. It is the whole RPO promise in one command. Run it after every credential
# rotation, forever.
$COMPOSE run --rm backup --stanza=fabricxai check

# First full backup, and the first document sync.
sudo ./scripts/backup.sh
sudo ./scripts/docs-sync.sh

# Timers: nightly backup, 15-minute document sync, weekly restore verification.
sudo ./ops/systemd/install.sh
systemctl list-timers 'fabricxai-*' --no-pager
```

Then, **from your own machine and not from this host**, lock the buckets so a stolen S3
token cannot delete the backups:

```bash
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… ./scripts/r2-protect.sh
```

The account token stays off the VPS deliberately — see
[`RESTORE-RUNBOOK.md`](./RESTORE-RUNBOOK.md). Put only a read-only R2 token in
`.env.backup` as `CLOUDFLARE_R2_READ_TOKEN`, and the weekly verification will tell you
if anybody removes the locks.

Backups are **full on Sunday, differential the other six nights**, with WAL archived
continuously and a forced segment switch every five minutes so an idle afternoon cannot
stretch the recovery point past the 15-minute promise. Documents sync every 15 minutes,
so both halves of a restore land at the same moment in time.

Then **rehearse the restore** against a scratch host — [`RESTORE-RUNBOOK.md`](./RESTORE-RUNBOOK.md)
§3, exact commands, and sign the log in §8. Until that is done the RPO is a claim.

---

## 4 · First bring-up

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production pull --ignore-buildable
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

`--ignore-buildable` skips `postgres`, which §3 already built. Order is enforced by the
file, not by you: `postgres` → `migrate` (migrations + roles,
runs to completion) → `pgbouncer`/`redis`/`minio` → `app`/`worker` → `caddy`. If
`migrate` exits non-zero, app and worker never start — which is the point, because a new
image serving requests against an un-migrated schema is a 500-storm with no obvious
cause.

```bash
# Watch it settle. The app validates its whole environment, warms the module registry
# and asserts its database role before serving anything, so give it up to a minute.
docker compose -f docker-compose.prod.yml --env-file .env.production ps
# /api/ready is the dependency check — Postgres and Redis through the pooler.
# /api/health is liveness only and answers 200 from a process that cannot reach either.
curl -fsS https://<domain>/api/ready | jq
```

Expected failures and what they mean:

| Symptom | Cause |
|---|---|
| `refusing to start: runtime database role … has SUPERUSER` | `DATABASE_URL` points at the owner. It must be `APP_DB_USER`. |
| `Invalid environment (N problems)` | A `.env.production` value is missing or malformed. The message lists every one. |
| Caddy cannot get a certificate | DNS does not resolve to this host yet, or 80/tcp is blocked. |
| App healthy, worker restarting | Check `PGBOUNCER_AUTH_PASSWORD` reached the userlist — the worker connects through the pooler too. |
| `password authentication failed for user "pgbouncer_auth"` | Usually NOT a wrong password. Check the pooler can *read* the userlist: `docker exec fxai-pgbouncer head -c1 /etc/pgbouncer/userlist.txt`. Permission denied ⇒ see §2 — it needs group 70 and 0640. |
| `bouncer config error`, and `permission denied for schema app` in the pooler's log | `pgbouncer_auth` is missing `USAGE ON SCHEMA app`. EXECUTE on the function is not sufficient. Migration 0080 grants it; a database migrated before that migration existed needs it applied. |
| `/api/ready` 503 | Postgres or Redis unreachable from the app. The body says which; the reason is in the container logs, deliberately not in the response. |
| `/api/health/jobs` 503, `health_token_not_configured` | `HEALTH_TOKEN` is unset in `.env.production`. The route refuses rather than publishing the schedule — set one (`openssl rand -hex 24`) and `compose up -d app`. |
| Caddy 502s while the app container is healthy | Caddy routes on `/api/ready`, not `/api/health`. A 502 here means the app is alive but cannot reach Postgres or Redis — check those, not the app. |
| `/api/health/jobs` 503, tasks `silent` | Expected for one cycle after a first boot; the baseline is set from first observed run. |

### Create the first factory

> **If you harden the owner role to non-superuser** — the standard move, and what the
> `owner-privileges` CI job runs against — three things must be done once, as a superuser,
> because `BYPASSRLS` does not imply any of them:
>
> ```sql
> -- 1. Extensions. `vector` is not "trusted", so a non-superuser cannot create it.
> --    Migration 0000 then becomes a no-op via IF NOT EXISTS rather than a hard failure.
> CREATE EXTENSION IF NOT EXISTS vector;
> CREATE EXTENSION IF NOT EXISTS pg_trgm;
> CREATE EXTENSION IF NOT EXISTS btree_gin;
> CREATE EXTENSION IF NOT EXISTS pgcrypto;
>
> -- 2. The pooler's auth_query. app.pgbouncer_get_auth is SECURITY DEFINER, so it reads
> --    verifiers with the OWNER's rights. Without this, PgBouncer refuses every client.
> GRANT SELECT ON pg_shadow TO <owner>;
>
> -- 3. CREATEROLE on the owner, which provisions the app and pooler roles.
> ALTER ROLE <owner> CREATEROLE BYPASSRLS;
> ```
>
> `pnpm db:setup-roles` warns if the `pg_shadow` grant is missing, and
> `node scripts/verify-owner-privileges.mjs` proves all twelve SECURITY DEFINER helpers
> still answer. Note that `0000_extensions.sql`'s own comment — "a fresh production
> database is fully provisioned by `pnpm db:migrate` alone" — is true only when the owner
> is a superuser.

Sign up through the UI at `https://<domain>/signup`. That path creates the company and
the owner role in one hook; there is no admin CLI, deliberately — one code path for
creating a factory means one code path that gets exercised.

Verification email is **required** to sign in, so confirm the SMTP block works before
you need it. If the mail never arrives, the account exists and cannot be used.

> **Do not run `pnpm seed` against production.** It creates verified users with a
> published password. The script now refuses before it opens a connection — on
> `NODE_ENV=production`, and on any `DATABASE_URL`/`DIRECT_DATABASE_URL` that is not
> loopback, which covers the compose service names the production stack resolves. It
> names what it found and exits 1 (audit INFRA-M10).
>
> `SEED_FORCE=1` overrides it, for a scratch host or a staging tenant. That flag does not
> re-enable the seeded passwords: those stay refused whenever `NODE_ENV=production`, so a
> forced run leaves rows and no way in. An SSH tunnel that publishes a production database
> on localhost still looks local to this check — the guard is for the careless invocation,
> not the determined one.

---

## 5 · Every deploy after that

```bash
cd /opt/fabricxai
git pull                                    # for compose/Caddyfile changes
# Pin the new image by digest in .env.production, then:
docker compose -f docker-compose.prod.yml --env-file .env.production pull --ignore-buildable
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

`--ignore-buildable` because `postgres` is built here rather than pulled — it carries
pgbackrest, for the reason in `docker/postgres/Dockerfile`. Without the flag, `pull`
tries to fetch a local image tag from a registry and fails the deploy on a service that
was never going to be pulled. **After a base-image bump** (a new Postgres minor, a
pgvector release) rebuild it explicitly and restart the database in a maintenance
window:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production build --pull postgres
docker compose -f docker-compose.prod.yml --env-file .env.production up -d postgres
```

`up -d` re-runs `migrate` to completion first, then recreates `app` and `worker`. The
worker gets a 40s grace period so its in-flight jobs drain rather than being killed
mid-transaction.

**Pin by digest, never `:latest`.** During an incident "which build is running" is the
question you least want to be unable to answer.

### Rolling back

```bash
# Set IMAGE back to the previous digest, then up -d.
```

Migrations are **forward-only**: rolling the image back does not roll the schema back, so
a rollback across a migration that dropped or renamed something needs a restore
([`restore.md`](./restore.md)) rather than a redeploy. In practice every migration in this
repo has been additive, which is what makes rollback usually safe — check the diff before
relying on it.

---

## 6 · What is still missing

Honest list, from `docs/DEPLOYMENT-READINESS-AUDIT.md`:

- **No error tracking.** `SENTRY_DSN` is required at boot and read by nothing —
  `@sentry/nextjs` is not installed (INFRA-B5). Container logs are the only sink, and
  they are unstructured `console.*`. Ship them somewhere before the pilot.
- **No rate limiting** on auth, `/api/sync`, or document presigning (INFRA-H7). Caddy's
  `request_body` cap is the only ceiling that exists.
- **No AV scan** on uploads, though `documents.status = 'quarantined'` is checked on
  download (INFRA-M12).
- **MARBIM does not work.** No real provider is registered, so every AI answer hard-fails
  and uploaded documents accumulate unprocessed while job health reports green
  (AI-B1). Tell the factory the copilot is off rather than letting them find it.
- **The floor mostly reads English.** Bangla covers `store/receive` and the route
  boundaries; the other eleven floor routes do not (FE-B1).
