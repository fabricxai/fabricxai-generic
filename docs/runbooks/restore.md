# Runbook · restore from backup

**RTO 4h · RPO 15min** (dev-plan §7). This runbook is how those numbers are met, and it
is worthless until it has been **rehearsed once against a scratch host**. Until that
rehearsal is signed off, this deployment has an undefined RPO and should not hold a
factory's payroll.

> **This is the incident procedure — something is broken, restore it.** The rehearsal,
> the scoring sheet and the sign-off log live in
> [`RESTORE-RUNBOOK.md`](./RESTORE-RUNBOOK.md), along with what runs automatically
> (`scripts/restore-verify.sh` performs a real restore every Monday). If a drill finds a
> command in this file that is wrong, fix it **here** first — this is the copy somebody
> reads at 3am.

> Read the whole thing before typing anything. Step 3 is destructive and step 6 is the
> one people skip.

---

## 0 · Decide what you are recovering from

The procedure branches, and picking wrong costs more than reading for a minute.

| Situation | Go to | Why |
|---|---|---|
| Host is gone / disk failed | §2 full restore | Nothing local survives |
| Database is corrupt, host fine | §2 full restore | Same procedure, faster |
| Somebody destroyed data at a known time (bad import, wrong bulk update) | §4 point-in-time | Restoring the latest backup restores the mistake |
| One table's rows are wrong | §5 single-table | A full restore to fix one table loses everything since |
| Documents missing, database fine | §6 objects only | The database is authoritative for rows, not bytes |

Write down, before you start: **what you are restoring, to what moment, and what you
expect to lose.** The last one is the number the factory owner will ask for.

---

## 1 · Before touching anything

```bash
cd /opt/fabricxai

# Stop writes. The app and worker both write; leaving the worker running against a
# database you are about to replace produces jobs whose effects vanish.
docker compose -f docker-compose.prod.yml --env-file .env.production stop app worker

# What does the repository actually have? If this command fails, STOP — you have no
# usable backup and restoring is not the problem you are solving.
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm --entrypoint pgbackrest backup --stanza=fabricxai info
```

Read the `info` output properly. You want the newest backup whose `timestamp stop` is
**before** whatever went wrong, and you want its WAL range to cover the moment you intend
to recover to.

**Also preserve the evidence.** If this is corruption or a bad write rather than hardware,
copy the current data directory aside before you overwrite it — it is the only copy of
what actually happened, and the post-mortem needs it.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm -v fabricxai_pgdata:/src:ro -v /var/backups:/dst alpine \
  tar czf /dst/pgdata-before-restore-$(date -u +%Y%m%dT%H%M%SZ).tgz -C /src .
```

---

## 2 · Full restore (latest)

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production stop postgres

# Destructive: pgBackRest replaces the data directory. This is why §1 took a copy.
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm --entrypoint pgbackrest backup \
  --stanza=fabricxai --delta restore

docker compose -f docker-compose.prod.yml --env-file .env.production up -d postgres
```

`--delta` restores only the files that differ, which is what makes the 4h RTO
achievable on a large database over a factory uplink.

Postgres now replays WAL. Watch it finish before doing anything else:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f postgres
# Wait for: "database system is ready to accept connections"
```

Go to §6.

---

## 3 · If the host itself is new

Do these first, then §2.

1. Install Docker and clone the repo to `/opt/fabricxai`.
2. Restore `.env.production` and `.env.backup` **from wherever your secrets live — not
   from this repo, which has never contained them.** Without
   `PGBACKREST_CIPHER_PASS` the backups cannot be decrypted, and there is no recovery
   from losing it.
3. Write the pooler userlist (see `docs/runbooks/deploy.md` §2).
4. Point DNS at the new host **after** §6 passes, not before — otherwise the factory
   starts entering data into a half-restored system.
5. `docker compose … up -d postgres` once, so the volume exists, then §2.

---

## 4 · Point-in-time recovery

For "the bad import ran at 14:32, get me 14:30". Times are **UTC**; the factory thinks in
Asia/Dhaka (UTC+6), so subtract six hours from what anybody tells you and confirm the
arithmetic out loud with them.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production stop postgres

docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm --entrypoint pgbackrest backup \
  --stanza=fabricxai --delta \
  --type=time --target='2026-08-03 08:30:00+00' \
  --target-action=promote restore

docker compose -f docker-compose.prod.yml --env-file .env.production up -d postgres
```

Recovery stops at that instant and the database is promoted read-write. **Everything
after the target is gone** — including work the factory did between the mistake and your
restore. Say that number out loud to whoever authorised this before you run it.

Then §6.

---

## 5 · One table, without losing the rest

Restore into a scratch database and copy the rows across. Slower to read, far less
destructive than §2.

```bash
# Restore the backup somewhere harmless. No --target-action: pgBackRest refuses it
# unless you also name a recovery target (time/lsn/name/xid/immediate), and here you
# want the newest recoverable moment, which is what --type=default gives you.
docker compose -f docker-compose.prod.yml --env-file .env.production --profile backup \
  run --rm -v scratch-restore:/scratch backup \
  --stanza=fabricxai --pg1-path=/scratch --archive-mode=off --type=default restore

# Then dump the one table out of the scratch instance and load it, checking company_id
# scoping as you go — a cross-tenant row copied in by hand is a breach that no policy
# will catch, because you are the owner while you do this.
```

Two rules while doing this by hand:

- **`audit_log` is append-only by GRANT.** Do not restore rows into it; if the history
  needs repair, add a correcting entry rather than editing one.
- **Check `offline_keys` before restoring a floor table.** Re-inserting rows whose
  idempotency keys are still present makes the next tablet replay a no-op that returns a
  stale row id.

---

## 6 · Verify — do not skip this

A restore is not finished when Postgres starts. It is finished when these pass.

```bash
# 1 · Schema is at the head the code expects. A restore to an older schema than the
#     running image is a 500-storm the moment somebody opens a screen.
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm --entrypoint tsx app src/db/migrate.ts

# 2 · Roles and the pooler's lookup. The app REFUSES TO BOOT if its role can bypass RLS,
#     which is the correct behaviour and will look like a failed restore if you skip this.
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm --entrypoint node app scripts/setup-db-roles.mjs

# 3 · Tenancy still holds. The seed's isolation sweep connects as the app role with no
#     scope and demands zero rows from every RLS table — run it ONLY on a scratch host,
#     it writes seed data.

# 4 · Bring the app up and check the real dependency paths.
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
curl -fsS https://<domain>/api/ready | jq   # deps; /api/health is liveness only
```

Then check the things a factory will notice, in this order:

- [ ] **Sign in works.** Login reads memberships through a `SECURITY DEFINER` function
      that only works if the owner role kept `BYPASSRLS` — the single most likely thing
      to be wrong after a restore onto a fresh host.
- [ ] **The floor can write.** POST one row through `/api/sync` from a tablet, or open
      `/store/receive` and receive a test challan. Then delete it.
- [ ] **A document downloads.** Open any order's attached file. This proves §6's object
      restore and the `S3_PUBLIC_ENDPOINT` signing path together.
- [ ] **The worker is alive.** `/api/health/jobs` (needs `Authorization: Bearer $HEALTH_TOKEN`) — a schedule that has stopped firing is
      reported there, and after a restore the scheduler's baseline is new, so give it one
      cycle before believing a complaint.
- [ ] **The outbox drained.** `select count(*) from outbox where published_at is null` —
      a large number means the relay is not running, and those events are real
      consequences that have not happened yet.
- [ ] **Counts are sane.** Compare `orders`, `grns`, `hourly_outputs` and `payroll_runs`
      row counts against what the factory expects for the period. This is the check that
      catches a restore to the wrong point in time.

---

## 7 · Objects only

Documents sync offsite every 15 minutes via rclone (`scripts/docs-sync.sh`), so the
offsite copy is at most one quarter-hour behind the database. The mirror lives under
`live/`; anything a sync run replaced or deleted was moved aside into
`_replaced/<timestamp>/` rather than propagated.

```bash
export COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production --profile backup"

# The whole mirror, back into MinIO.
$COMPOSE run --rm docs-sync copy \
  "dst:${DOCS_BACKUP_BUCKET}/live" "src:${S3_BUCKET}" \
  --transfers 8 --checkers 16 --stats 30s --stats-one-line
```

`copy`, not `sync`, and the direction is reversed from `docs-sync.sh`: a restore must
never delete objects the live bucket has and the backup does not.

For a single file somebody overwrote rather than a whole-bucket loss:

```bash
# Which runs displaced anything, and when.
$COMPOSE run --rm docs-sync lsd "dst:${DOCS_BACKUP_BUCKET}/_replaced"

$COMPOSE run --rm docs-sync copyto \
  "dst:${DOCS_BACKUP_BUCKET}/_replaced/<timestamp>/<object-key>" \
  "src:${S3_BUCKET}/<object-key>"
```

---

## 8 · Afterwards

- Write down what was lost and tell the factory. People re-enter what they know is gone;
  they cannot re-enter what nobody told them about.
- If this was a point-in-time restore, the gap between the target and the moment of
  discovery is data the floor still has on paper for a day or two. That window is short.
- Note the actual elapsed time against the 4h RTO — in the log in
  [`RESTORE-RUNBOOK.md` §8](./RESTORE-RUNBOOK.md#8--the-log), which is where the
  rehearsal log now lives so that drills and real incidents accumulate in one place.

A restore that has never been performed is a document, not a capability. The log is
still empty.
