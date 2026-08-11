# RESTORE-RUNBOOK — the drill

**RTO ≤ 4h · RPO ≤ 15min** (architecture §9). This file is how those two numbers are
*proved*, on a schedule, while nothing is on fire.

> **This is not the incident procedure.** When something is actually broken, go to
> [`restore.md`](./restore.md) — it branches by failure mode and assumes you are under
> pressure. This file is the rehearsal: same commands, no urgency, and a scoring sheet at
> the end. The two must not drift; if a drill finds a command here that `restore.md` gets
> wrong, fix `restore.md` first and note it in the log.

A backup that has never been restored is a belief. Nothing below is optional because of
the specific way that belief fails: it fails silently, it looks healthy in `info`, and it
is discovered at the worst hour of the worst day.

---

## 0 · What runs without you

| | What | When | Where |
|---|---|---|---|
| **Postgres** | pgBackRest full backup | Sunday 01:15 | `fabricxai-backup.timer` → `scripts/backup.sh` |
| **Postgres** | pgBackRest differential | Mon–Sat 01:15 | same |
| **Postgres** | WAL archive | continuously, forced switch every 5 min | `archive_command` in the postgres container |
| **Documents** | rclone MinIO → offsite | every 15 min | `fabricxai-docs-sync.timer` → `scripts/docs-sync.sh` |
| **Proof** | real restore into a throwaway instance | Monday 03:30 | `fabricxai-restore-verify.timer` → `scripts/restore-verify.sh` |

```bash
# Is any of that actually happening?
systemctl list-timers 'fabricxai-*' --no-pager
journalctl -u fabricxai-backup -u fabricxai-docs-sync -u fabricxai-restore-verify --since '7 days ago'
```

### The buckets are locked, not just backed up

`scripts/r2-protect.sh`, run **once from an admin workstation**, makes the offsite
objects undeletable for a window:

| Prefix | Locked for | Why that number |
|---|---|---|
| `<repo>/archive/<stanza>/1…` (WAL) | 14 days | pgBackRest deletes nothing younger than ~28 days, so the lock never collides with `expire` |
| `<repo>/backup/<stanza>/20…` (backup sets) | 14 days | same |
| `<docs>/_replaced/` | 30 days | displaced document versions, then reaped by lifecycle at 90 days |

**The prefixes are narrow on purpose.** A lock blocks overwrites as well as deletes, and
pgBackRest rewrites exactly four objects on every backup — `archive.info`,
`backup.info` and their `.copy` twins. A whole-bucket lock breaks the second backup and
every one after it. Likewise `<docs>/live/` stays unlocked, because rclone's
`--backup-dir` replaces an object by moving the old one aside, which is a delete.

**The token that can remove a lock is not on the VPS.** That is the whole point: the S3
credentials pgBackRest and rclone hold can delete objects but cannot lift the rule that
refuses the delete. Only a read-only token lives in `.env.backup`, and
`restore-verify.sh` uses it weekly to confirm the rules are still there — reporting
`protection.walLockDays` alongside the restore result, and failing outright if the WAL
lock has vanished.

```bash
# Check by hand any time:
curl -fsS -H "Authorization: Bearer ${CLOUDFLARE_R2_READ_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${PGBACKREST_REPO1_S3_BUCKET}/lock" \
  | jq -r '.result.rules[] | "\(.prefix) → \(.condition.maxAgeSeconds / 86400)d"'
```

> If `expire` ever starts failing with a permission or retention error, the lock window
> has grown past the retention window. Shorten the lock; do not lengthen retention to
> match, or the repository grows without bound.

Weekly automated verification is not a substitute for the quarterly human drill in §3.
It proves the bytes restore. It cannot prove that a person can find the cipher
passphrase, or that DNS is under the control of somebody who answers the phone.

---

## 1 · Before the first drill — is the layer even armed

Run these once, after deploy. Every one of them should be boring.

```bash
cd /opt/fabricxai
export COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production --profile backup"

# 1 · The stanza exists and Postgres agrees with the repository about it.
$COMPOSE run --rm backup --stanza=fabricxai stanza-create   # once, ever
$COMPOSE run --rm backup --stanza=fabricxai check
```

`check` is the single most valuable command in this file. It forces a WAL switch and
confirms the segment arrives in the repository — the whole RPO promise, end to end, in
one command. Run it after **every** credential rotation.

```bash
# 2 · What is in the repository right now.
$COMPOSE run --rm backup --stanza=fabricxai info

# 3 · Is WAL still flowing? `last_archived_time` should be under 5 minutes old,
#     and failed_count should be 0.
$COMPOSE exec -T postgres psql -U fabricxai -d fabricxai -c \
  "select last_archived_wal, last_archived_time, failed_count, last_failed_time from pg_stat_archiver"

# 4 · Are the documents offsite?
$COMPOSE run --rm docs-sync size "dst:${DOCS_BACKUP_BUCKET}/live"
$COMPOSE run --rm docs-sync size "src:${S3_BUCKET}"
# The two should be within one sync interval of each other.
```

**If `failed_count` is climbing**, WAL is not reaching the repository. The spool is
capped at 8GiB (`archive-push-queue-max`) and when it fills pgBackRest starts *dropping*
segments to keep the database running — the PITR chain breaks at that instant and no
`info` output will say so in words. Fix the cause, then **take a full backup
immediately**:

```bash
$COMPOSE run --rm backup --stanza=fabricxai --type=full backup
```

---

## 2 · Drill A · The five-minute check (run any time)

The automated weekly verification, on demand. Restores the newest backup into a
throwaway volume on this host, replays WAL, interrogates the result, deletes it.

```bash
cd /opt/fabricxai
sudo ./scripts/restore-verify.sh
```

It needs free disk equal to ~1.2× the current database and refuses rather than filling
the disk the live database is on. Exit code is the verdict; the JSON it prints (and
POSTs to `BACKUP_MONITOR_URL`) carries backup age, WAL lag, restore seconds against the
RTO budget, and the row counts it found.

To skip the slow repository-wide checksum pass on a big repo:

```bash
sudo RESTORE_VERIFY_SKIP_REPO_VERIFY=1 ./scripts/restore-verify.sh
```

Skip it rarely. It is what catches bit-rot in an object store, and the alternative
discovery mechanism is a real restore during a real outage.

---

## 3 · Drill B · Full disaster recovery, on a scratch host — **quarterly**

The one that counts. Pretend the VPS is gone. **Do not run this against the production
host** — the point is to prove a *new* host can be built from what survives.

Book two hours. Take the timestamps; the RTO number is only real if somebody measured it.

### B.1 — Start the clock

```bash
date -u +%Y-%m-%dT%H:%M:%SZ    # T0. Write it down.
```

### B.2 — A host with nothing on it

```bash
# Any fresh VM. Same shape as production: 6 vCPU / 12GB / 200GB NVMe.
curl -fsSL https://get.docker.com | sh
timedatectl set-timezone Asia/Dhaka
git clone <repo> /opt/fabricxai && cd /opt/fabricxai
```

### B.3 — The secrets, from wherever they actually live

This is the step drills exist to test, and the step that fails. Restore
`.env.production` and `.env.backup` **from your secret store, not from the repo and not
from a note in this file**.

```bash
chmod 600 .env.production .env.backup
grep -q PGBACKREST_REPO1_CIPHER_PASS .env.backup || { echo 'STOP. Without this the backups are noise.'; exit 1; }

# The pooler's userlist (deploy.md §2).
mkdir -p secrets && chmod 700 secrets
source .env.production
printf '"pgbouncer_auth" "%s"\n' "$PGBOUNCER_AUTH_PASSWORD" > secrets/pgbouncer-userlist.txt
sudo chown "$(id -u)":70 secrets/pgbouncer-userlist.txt && chmod 640 secrets/pgbouncer-userlist.txt
```

> **Score this step honestly.** How long did it take to find the cipher passphrase? Who
> had it? Could they have been reached at 2am on a Friday? A four-hour RTO with a
> ninety-minute credential hunt inside it is a five-and-a-half-hour RTO.

### B.4 — Build the image and bring up an empty Postgres

```bash
export COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production --profile backup"

# postgres is BUILT, not pulled — it carries pgbackrest, which is what runs archive_command.
$COMPOSE build postgres
$COMPOSE up -d postgres
$COMPOSE exec -T postgres pg_isready -U fabricxai
```

### B.5 — Restore

```bash
$COMPOSE stop postgres

# Destructive on this host, which is the point of doing it on a scratch one.
# --delta is what makes the RTO achievable on a large database; on an empty volume it
# simply restores everything.
$COMPOSE run --rm backup --stanza=fabricxai --delta restore

$COMPOSE up -d postgres
$COMPOSE logs -f postgres      # wait for: "database system is ready to accept connections"
date -u +%Y-%m-%dT%H:%M:%SZ    # T1 — database back. Write it down.
```

### B.6 — The documents

```bash
# Direction is REVERSED from the sync, and there is deliberately no --delete: a restore
# must never remove objects the live bucket has and the backup does not.
$COMPOSE up -d minio
$COMPOSE run --rm docs-sync copy \
  "dst:${DOCS_BACKUP_BUCKET}/live" "src:${S3_BUCKET}" \
  --transfers 8 --checkers 16 --stats 30s --stats-one-line
```

### B.7 — Bring the rest up and verify

```bash
$COMPOSE up -d
curl -fsS http://localhost:3000/api/ready | jq
```

Then walk [`restore.md` §6](./restore.md#6--verify--do-not-skip-this) — sign-in,
a floor write, a document download, the worker, the outbox, row counts. Every box.

```bash
date -u +%Y-%m-%dT%H:%M:%SZ    # T2 — service verified. Write it down.
```

### B.8 — Tear it down

```bash
$COMPOSE down -v          # -v: the volumes too. A scratch host left running is a
                          #     second copy of the factory's payroll on a box nobody
                          #     is patching.
```

**Then destroy the VM.** Not "later".

---

## 4 · Drill C · Point-in-time — **twice a year**

The scenario the factory will actually hit: a bad bulk import at 14:32 Dhaka, discovered
at 16:00. §2's "restore the latest backup" restores the mistake.

Times are **UTC**; the factory thinks in Asia/Dhaka (UTC+6). Subtract six hours from
whatever anybody tells you and **confirm the arithmetic out loud with them** before you
type it. 14:30 Dhaka is `08:30:00+00`.

```bash
$COMPOSE stop postgres

$COMPOSE run --rm backup --stanza=fabricxai --delta \
  --type=time --target='2026-08-03 08:30:00+00' \
  --target-action=promote restore

$COMPOSE up -d postgres
```

Verify the target actually landed where you meant:

```bash
# The newest row should predate the target. If it does not, the recovery target was not
# reached — usually because the WAL covering it has been expired.
$COMPOSE exec -T postgres psql -U fabricxai -d fabricxai -c \
  "select max(created_at) from audit_log"
```

**Everything after the target is gone**, including work done between the mistake and the
restore. Say that number out loud to whoever authorised it, before running it.

The drill is passed when the restored database stops at the intended minute *and*
somebody can state, from the row counts, what the factory would have had to re-enter.

---

## 5 · Drill D · Documents only — **quarterly, with Drill B**

The database is fine; objects are missing or were overwritten.

```bash
# What did the sync displace, and when? Every run that replaced or deleted anything left
# it here rather than propagating the loss.
$COMPOSE run --rm docs-sync lsd "dst:${DOCS_BACKUP_BUCKET}/_replaced"

# Recover one object from a specific run.
$COMPOSE run --rm docs-sync copyto \
  "dst:${DOCS_BACKUP_BUCKET}/_replaced/20260803T091500Z/<object-key>" \
  "src:${S3_BUCKET}/<object-key>"

# Or the whole live mirror back into MinIO (no --delete, see B.6).
$COMPOSE run --rm docs-sync copy "dst:${DOCS_BACKUP_BUCKET}/live" "src:${S3_BUCKET}"
```

Pass condition: open an order in the UI and download its attachment. A file that exists
in the bucket and 404s through the app is a signing-endpoint problem, not a restore
problem — `S3_PUBLIC_ENDPOINT` (deploy.md).

---

## 6 · Drill E · One tenant's data — **on request, and once a year unprompted**

Not disaster recovery. This is the "a buyer's compliance team wants our records" and
"this factory is leaving" path, and it must not be the first time anybody has run it.

```bash
# The company id — a UUID. Never a name: names are not unique and exporting the wrong
# tenant is a breach, not a typo.
pnpm export:tenant -- --company=<uuid> --out=/var/exports/<name>-$(date +%F) --documents

# Verify what you are about to hand over.
cd /var/exports/<name>-$(date +%F)
cat MANIFEST.json | jq '{company, totalRows, documents}'
sha256sum -c <(jq -r '.tables[] | "\(.sha256)  data/\(.file)"' MANIFEST.json)
```

Then **spot-check for cross-tenant rows** before it leaves the building:

```bash
# Every file that carries the column must carry exactly one company id, and it must be
# the one you asked for.
for f in data/*.csv; do
  col=$(head -1 "$f" | tr ',' '\n' | grep -n '^company_id$' | cut -d: -f1)
  [ -n "$col" ] && echo "$f: $(tail -n +2 "$f" | cut -d, -f"$col" | sort -u | wc -l) distinct company_id"
done
# Anything other than 0 or 1 stops the handover.
```

The export deliberately does **not** delete anything. Erasure is a separate decision and
only one of the two is reversible.

---

## 7 · What each failure means

| What you see | What it is | What to do |
|---|---|---|
| `unable to find primary cluster` | Postgres is down, or the socket volume is not shared | `$COMPOSE up -d postgres`; check `pgsocket` is mounted into both services |
| `unable to load info file … cipher` | Wrong `PGBACKREST_REPO1_CIPHER_PASS` | The repository is unreadable without the exact passphrase. There is no recovery — find the right one |
| `HTTP 403` from the repo | Rotated or wrongly-scoped API token | Token needs read+write+delete on the bucket; `expire` deletes |
| `archive_command failed` in the postgres log | WAL is not shipping | `check`, then the §1 escalation. Watch the spool size |
| `WAL segment … was not archived` on restore | The PITR chain has a hole | The spool cap was crossed. Recover to the last good point; take a full backup |
| Restore fine, app 500s everywhere | Schema older than the deployed image | Deploy the image that matches, or apply migrations. `restore-verify.sh` checks for exactly this |
| Sign-in fails after a restore | Owner role lost `BYPASSRLS` | `pnpm db:setup-roles`, and see deploy.md §4 |
| `restore-verify` says "still in recovery" | WAL replay never completed | Missing archive segments — read the container log before assuming the backup is bad |

---

## 8 · The log

**A drill that was not written down did not happen.** Fill a row in immediately after,
while the timestamps are still on the whiteboard. `Elapsed` is T2−T0 from §3 — the whole
thing, credential hunt included, not just the restore command.

| Date | Drill | Performed by | Elapsed (RTO 4h) | Data lost (RPO 15min) | Found | Signed |
|---|---|---|---|---|---|---|
| — | — | — | — | — | **Never rehearsed. Do this before the pilot holds real data.** | — |

Add a row for every drill, including the ones that failed. Especially those — a drill
that passes teaches nothing that a drill that fails does not teach better, and a log with
no failures in it usually means the drills are too easy.

### Also record, once a quarter

- [ ] Who currently holds `PGBACKREST_REPO1_CIPHER_PASS`, and is that still the right people
- [ ] The offsite provider's bill is being paid by somebody who will notice if it stops
- [ ] Restore time as a percentage of the RTO budget — `restore-verify.sh` warns past 50%
- [ ] `docs/DEPLOYMENT-READINESS-AUDIT.md` reflects what the last drill actually found
