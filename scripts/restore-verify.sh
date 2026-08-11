#!/usr/bin/env bash
# Weekly proof that the backups restore. Not that they exist — that they RESTORE.
#
#   ops/systemd/fabricxai-restore-verify.{service,timer}   — Mondays 03:30 Asia/Dhaka
#
# A backup nobody has restored is a belief, and the belief is usually wrong in a way
# that is only discoverable at the worst possible moment: a credential rotated three
# weeks ago, an archive_command failing silently, a cipher passphrase that no longer
# matches, a repository whose newest backup is from before the last migration. Every one
# of those leaves `pgbackrest info` looking healthy.
#
# So this actually restores the newest backup into a throwaway volume, starts a real
# Postgres on it, replays WAL out of the repository, and asks the restored database
# questions only a correct restore can answer. Then it deletes all of it and reports.
#
# It touches nothing in production: a separate volume, a separate container, no
# published port, and `--archive-mode=off` so the scratch instance can never push WAL
# into the live stanza.
#
# Exit code is the verdict. Anything non-zero means the disaster-recovery position of
# this deployment is not what the runbook claims.
set -Eeuo pipefail

REPO_DIR="${REPO_DIR:-/opt/fabricxai}"
COMPOSE_FILE="${COMPOSE_FILE:-${REPO_DIR}/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-${REPO_DIR}/.env.production}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-${REPO_DIR}/.env.backup}"
STANZA="${PGBACKREST_STANZA:-fabricxai}"

# The promises this script measures against, from architecture §9.
RTO_BUDGET_SECONDS="${RTO_BUDGET_SECONDS:-14400}"   # 4h
RPO_BUDGET_SECONDS="${RPO_BUDGET_SECONDS:-900}"     # 15min
# How stale the newest backup may be before this is a failure. Daily diffs mean 36h
# allows exactly one missed night — enough to not page on a blip, short enough that two
# missed nights are an incident.
MAX_BACKUP_AGE_SECONDS="${MAX_BACKUP_AGE_SECONDS:-129600}"  # 36h

RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
SCRATCH_VOL="fxai-restore-verify-${RUN_TS}"
SCRATCH_PG="fxai-restore-verify-pg-${RUN_TS}"

log() { printf '[restore-verify] %s · %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

FAILED_STEP=''

cleanup() {
  # Always, on every path out. A scratch volume left behind is a full second copy of the
  # database on a disk sized for one.
  log 'cleaning up scratch instance'
  docker rm -f "${SCRATCH_PG}" >/dev/null 2>&1 || true
  docker volume rm -f "${SCRATCH_VOL}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  FAILED_STEP="$1"
  log "FAILED · ${FAILED_STEP}"
  report 'false'
  exit 1
}
trap 'fail "${BASH_COMMAND}"' ERR

# shellcheck disable=SC1090
[[ -f "${BACKUP_ENV_FILE}" ]] && set -a && source "${BACKUP_ENV_FILE}" && set +a

command -v jq >/dev/null || { echo '[restore-verify] jq is required (apt-get install -y jq)'; exit 2; }

: "${PGBACKREST_REPO1_S3_BUCKET:?set in ${BACKUP_ENV_FILE}}"
: "${PGBACKREST_REPO1_CIPHER_PASS:?set in ${BACKUP_ENV_FILE}}"

PG_USER="${POSTGRES_USER:-fabricxai}"
PG_DB="${POSTGRES_DB:-fabricxai}"

# `--profile backup` explicitly: `run` would activate the profile on its own, but
# `config` would not, and this script reads the resolved image name out of it.
compose() { docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" --profile backup "$@"; }

# Findings, filled in as we go and reported whatever happens.
backup_label='' backup_type='' backup_age_seconds='null'
wal_lag_seconds='null' wal_failed_count='null'
restore_seconds='null' replay_seconds='null'
rows_companies='null' rows_migrations='null' migrations_on_disk='null'
lock_days='null'
repo_verify='skipped'

report() {
  local ok="$1"
  local payload
  payload=$(jq -n \
    --arg check 'restore-verify' \
    --argjson ok "${ok}" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg stanza "${STANZA}" \
    --arg failedStep "${FAILED_STEP}" \
    --arg backupLabel "${backup_label}" \
    --arg backupType "${backup_type}" \
    --argjson backupAgeSeconds "${backup_age_seconds}" \
    --argjson walLagSeconds "${wal_lag_seconds}" \
    --argjson walFailedCount "${wal_failed_count}" \
    --argjson restoreSeconds "${restore_seconds}" \
    --argjson replaySeconds "${replay_seconds}" \
    --argjson rowsCompanies "${rows_companies}" \
    --argjson migrationsApplied "${rows_migrations}" \
    --argjson migrationsOnDisk "${migrations_on_disk}" \
    --arg repoVerify "${repo_verify}" \
    --argjson lockDays "${lock_days}" \
    --argjson rtoBudgetSeconds "${RTO_BUDGET_SECONDS}" \
    --argjson rpoBudgetSeconds "${RPO_BUDGET_SECONDS}" \
    '{check:$check, ok:$ok, at:$ts, stanza:$stanza,
      failedStep:(if $failedStep == "" then null else $failedStep end),
      backup:{label:$backupLabel, type:$backupType, ageSeconds:$backupAgeSeconds},
      archive:{lagSeconds:$walLagSeconds, failedCount:$walFailedCount},
      restore:{seconds:$restoreSeconds, replaySeconds:$replaySeconds, repoVerify:$repoVerify},
      protection:{walLockDays:$lockDays},
      restored:{companies:$rowsCompanies, migrationsApplied:$migrationsApplied, migrationsOnDisk:$migrationsOnDisk},
      budget:{rtoSeconds:$rtoBudgetSeconds, rpoSeconds:$rpoBudgetSeconds}}')

  printf '[restore-verify] result %s\n' "${payload}"

  # The structured result, for whatever holds history. A heartbeat says "it ran"; this
  # says what it found, which is what makes a slow drift visible before it is a failure.
  if [[ -n "${BACKUP_MONITOR_URL:-}" ]]; then
    curl -fsS -m 30 -X POST "${BACKUP_MONITOR_URL}" \
      -H 'Content-Type: application/json' -d "${payload}" \
      || log 'monitor POST failed'
  fi

  if [[ "${ok}" == 'true' ]]; then
    [[ -n "${BACKUP_HEARTBEAT_URL:-}" ]] && { curl -fsS -m 20 "${BACKUP_HEARTBEAT_URL}/restore-verify" || true; }
  elif [[ -n "${BACKUP_ALERT_URL:-}" ]]; then
    curl -fsS -m 20 -X POST "${BACKUP_ALERT_URL}" \
      -H 'Content-Type: application/json' \
      -d "$(jq -n --arg t "FabricXAI RESTORE VERIFICATION FAILED at: ${FAILED_STEP}" '{text:$t}')" || true
  fi
}

# ── 0 · Room to do this at all ─────────────────────────────────────────────────
#
# A restore is a second full copy of the database. Running out of disk halfway through
# leaves a half-written volume and a paged engineer, on a host whose remaining space the
# LIVE database also needs.
log 'checking free disk'
docker_root="$(docker info --format '{{.DockerRootDir}}')"
free_kb="$(df -Pk "${docker_root}" | awk 'NR==2 {print $4}')"
pgdata_kb="$(compose run --rm --user root --entrypoint sh backup -c 'du -sk /var/lib/postgresql/data' 2>/dev/null | tail -1 | awk '{print $1}')"

if [[ -n "${pgdata_kb}" ]] && (( free_kb < pgdata_kb * 12 / 10 )); then
  fail "not enough free disk: need ~$(( pgdata_kb * 12 / 10 / 1024 ))MB, have $(( free_kb / 1024 ))MB"
fi

# ── 1 · What does the repository hold ──────────────────────────────────────────
log 'reading repository state'
info_json="$(compose run --rm backup --stanza="${STANZA}" --output=json info)"

# Stanza status FIRST. An unreachable or misconfigured repository also reports zero
# backups, and "the repository contains no backups at all" sends somebody looking for a
# missing backup when the real answer is a rotated key or a DNS failure. The repo-level
# message is the one that names the cause; the stanza-level one is usually just "other".
stanza_status="$(jq -r '.[0].status.code' <<<"${info_json}")"
if [[ "${stanza_status}" != '0' ]]; then
  fail "stanza status ${stanza_status}: $(jq -r '[.[0].repo[]?.status.message, .[0].status.message] | map(select(. != null)) | join(" · ")' <<<"${info_json}")"
fi

backup_count="$(jq -r '.[0].backup | length' <<<"${info_json}")"
[[ "${backup_count}" -gt 0 ]] || fail 'the repository is reachable but contains no backups at all'

backup_label="$(jq -r '.[0].backup[-1].label' <<<"${info_json}")"
backup_type="$(jq -r '.[0].backup[-1].type' <<<"${info_json}")"
backup_stop="$(jq -r '.[0].backup[-1].timestamp.stop' <<<"${info_json}")"
backup_age_seconds=$(( $(date +%s) - backup_stop ))

log "newest backup: ${backup_label} (${backup_type}), $(( backup_age_seconds / 3600 ))h old"
(( backup_age_seconds <= MAX_BACKUP_AGE_SECONDS )) \
  || fail "newest backup is $(( backup_age_seconds / 3600 ))h old, budget is $(( MAX_BACKUP_AGE_SECONDS / 3600 ))h"

# ── 2 · Is WAL still arriving ──────────────────────────────────────────────────
#
# The RPO check, and the one most likely to catch a real problem. `pg_stat_archiver`
# knows whether the live database's archive_command is succeeding right now, which no
# amount of repository inspection can tell you.
log 'checking WAL archive freshness against the live database'
archiver="$(compose exec -T -e PGPASSWORD="${POSTGRES_PASSWORD}" postgres \
  psql -U "${PG_USER}" -d "${PG_DB}" -At -F'|' -c \
  "select coalesce(extract(epoch from now() - last_archived_time)::bigint, -1), failed_count from pg_stat_archiver")"

wal_lag_seconds="${archiver%%|*}"
wal_failed_count="${archiver##*|}"

if [[ "${wal_lag_seconds}" == '-1' ]]; then
  fail 'pg_stat_archiver has never archived a segment — archive_command is not working'
fi
log "last WAL archived ${wal_lag_seconds}s ago; ${wal_failed_count} failures since stats reset"

# archive_timeout is 300s, so a healthy system is always well inside the 15-minute RPO.
# Twice the budget is the alarm threshold: one missed switch is noise, sustained lag is
# the RPO quietly not being met.
(( wal_lag_seconds <= RPO_BUDGET_SECONDS * 2 )) \
  || fail "WAL lag ${wal_lag_seconds}s exceeds twice the ${RPO_BUDGET_SECONDS}s RPO budget"

# ── 2b · Is the repository still protected ─────────────────────────────────────
#
# A bucket lock nobody checks is one that quietly gets removed — during a cleanup, a
# provider migration, or by whoever was "just tidying up the rules". The token used here
# is READ-ONLY on purpose: this host must never hold a credential that can remove the
# protection it is verifying (see scripts/r2-protect.sh).
lock_days='null'
if [[ -n "${CLOUDFLARE_R2_READ_TOKEN:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  log 'checking the repository bucket lock is still in place'
  lock_json="$(curl -fsS -m 30 \
    -H "Authorization: Bearer ${CLOUDFLARE_R2_READ_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${PGBACKREST_REPO1_S3_BUCKET}/lock")" \
    || fail 'could not read the bucket lock configuration'

  # The WAL rule specifically. Backup sets matter too, but WAL is what a point-in-time
  # recovery is made of and it is the larger, more tempting thing to delete.
  lock_days="$(jq -r --arg p "${PGBACKREST_REPO_PATH:-fabricxai}/archive/${STANZA}/1" \
    '[.result.rules[]? | select(.enabled and .prefix == $p) | .condition.maxAgeSeconds] | if length == 0 then 0 else (max / 86400 | floor) end' \
    <<<"${lock_json}")"

  (( lock_days > 0 )) || fail 'the WAL bucket lock is GONE — backups can be deleted by anyone holding the S3 token'
  log "  WAL locked for ${lock_days} days"
else
  log 'skipping the bucket-lock check — CLOUDFLARE_R2_READ_TOKEN is not set'
fi

# ── 3 · Checksums across the repository ────────────────────────────────────────
#
# Reads every file pgBackRest holds and verifies it against the manifest. Expensive on a
# large repo, so it is skippable — but skipping it means bit-rot in an object store is
# only ever discovered by a real restore, during a real outage.
if [[ "${RESTORE_VERIFY_SKIP_REPO_VERIFY:-0}" != '1' ]]; then
  log 'verifying repository checksums (this is the slow step)'
  compose run --rm backup --stanza="${STANZA}" verify
  repo_verify='passed'
fi

# ── 4 · Actually restore it ────────────────────────────────────────────────────
log "restoring ${backup_label} into scratch volume ${SCRATCH_VOL}"
docker volume create "${SCRATCH_VOL}" >/dev/null

# The volume is created owned by root; pgBackRest runs as postgres and Postgres refuses
# a data directory it does not own with permissions wider than 0700.
compose run --rm --user root --entrypoint sh -v "${SCRATCH_VOL}:/scratch" backup \
  -c 'chown postgres:postgres /scratch && chmod 700 /scratch'

restore_started=$(date +%s)

# --archive-mode=off is not optional and not tidiness: without it the restored instance
# inherits archive_mode=on and starts pushing its own WAL timeline into the PRODUCTION
# stanza, corrupting the repository this script exists to protect.
# No --target-action here: pgBackRest rejects it unless an explicit recovery target is
# given (time, lsn, name, xid, immediate). `--type=default` replays every WAL segment the
# repository has and Postgres promotes itself at the end of the stream, which is exactly
# what this drill wants — the newest recoverable moment, not a chosen one.
compose run --rm -v "${SCRATCH_VOL}:/scratch" backup \
  --stanza="${STANZA}" \
  --pg1-path=/scratch \
  --archive-mode=off \
  --type=default \
  restore

restore_seconds=$(( $(date +%s) - restore_started ))
log "restore wrote in ${restore_seconds}s"

# ── 5 · Start it and let it replay ─────────────────────────────────────────────
#
# No published port, no compose network, no connection to anything this deployment
# serves. It needs egress only, to pull WAL out of the repository through restore_command.
log 'starting scratch Postgres and replaying WAL'
replay_started=$(date +%s)

image="$(compose config --format json | jq -r '.services.backup.image')"
[[ -n "${image}" && "${image}" != 'null' ]] || fail 'could not resolve the backup service image'

# Two things here are load-bearing and both were found by running this rather than by
# reading it:
#
# 1. PGDATA=/scratch, with the volume mounted at /scratch rather than the image's
#    default path. `restore` bakes the --pg1-path it was given into the restore_command
#    it writes to postgresql.auto.conf, so an instance started from a different
#    directory fails every archive-get with "unable to chdir()" and then dies on "could
#    not locate required checkpoint record" — a message that reads like a corrupt
#    backup and is not one.
#
# 2. max_connections must be >= the value the PRIMARY had when the backup was taken, or
#    WAL replay aborts outright ("insufficient parameter settings"). This deployment
#    sets it to 200 through the compose `command:` flags rather than in
#    postgresql.conf, which means the restored data directory does NOT carry it — a
#    bare container has to re-supply it. A restore through compose is fine, because
#    compose re-applies the same flags; this one is not going through compose.
#    Raise POSTGRES max_connections and this default has to follow.
docker run -d --name "${SCRATCH_PG}" \
  --env-file "${BACKUP_ENV_FILE}" \
  -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
  -e PGDATA=/scratch \
  -v "${SCRATCH_VOL}:/scratch" \
  -v "${REPO_DIR}/docker/backup/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro" \
  "${image}" \
  postgres -c archive_mode=off \
           -c shared_buffers=128MB \
           -c "max_connections=${RESTORE_VERIFY_MAX_CONNECTIONS:-200}" >/dev/null

scratch_psql() {
  docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" "${SCRATCH_PG}" \
    psql -U "${PG_USER}" -d "${PG_DB}" -At -c "$1"
}

# Same, but for questions whose answer is fed to arithmetic. An empty result — the query
# errored, the container went away — would otherwise reach `(( ))` as an empty string
# and surface as a bash syntax error, which sends the reader looking at this script
# instead of at the restore that actually failed.
#
# Assigns through a nameref (`scratch_number rows_companies 'select …'`) rather than
# returning on stdout, because `fail` has to run in THIS shell: called inside a `$( )`
# its `exit 1` would only leave the subshell, the ERR trap would then fire again in the
# parent, and on-call would get two alerts describing one failure in different words.
scratch_number() {
  local -n dest="$1"
  local query="$2"
  local out
  out="$(scratch_psql "${query}")" || fail "query failed against the restored database: ${query}"
  [[ "${out}" =~ ^-?[0-9]+$ ]] || fail "expected a number from the restored database, got '${out}' for: ${query}"
  dest="${out}"
}

# Wait for PROMOTION, not for readiness. Postgres accepts connections while it is still
# replaying (hot standby), so `pg_isready` goes green seconds before recovery finishes —
# asserting `pg_is_in_recovery() = f` straight after it is a race that fails on a fast
# machine and passes on a slow one. The condition that matters is the one below.
deadline=$(( $(date +%s) + ${RESTORE_VERIFY_START_TIMEOUT:-1800} ))
until [[ "$(scratch_psql 'select pg_is_in_recovery()' 2>/dev/null)" == 'f' ]]; do
  (( $(date +%s) < deadline )) || {
    docker logs --tail 50 "${SCRATCH_PG}" || true
    fail 'restored Postgres never finished recovery — see the container log above'
  }
  # Dead rather than replaying is a different failure, and worth naming as one.
  docker inspect -f '{{.State.Running}}' "${SCRATCH_PG}" 2>/dev/null | grep -q true || {
    docker logs --tail 50 "${SCRATCH_PG}" || true
    fail 'restored Postgres exited during recovery — see the container log above'
  }
  sleep 5
done

replay_seconds=$(( $(date +%s) - replay_started ))
log "restored database finished recovery and promoted after ${replay_seconds}s"

# ── 6 · Ask it questions only a correct restore can answer ─────────────────────

# A restored database with no companies is a restore of an empty stanza — which is
# exactly what a mis-pointed repo1-path produces, silently and quickly.
scratch_number rows_companies 'select count(*) from companies'
(( rows_companies > 0 )) || fail 'restored database has zero companies'

# The schema must be at the head the running code expects. A restore to an older schema
# than the deployed image is a 500-storm the moment somebody opens a screen — and it is
# what happens when the newest backup predates the last migration.
scratch_number rows_migrations 'select count(*) from drizzle.__drizzle_migrations'
migrations_on_disk="$(find "${REPO_DIR}/src/db/migrations" -maxdepth 1 -name '*.sql' | wc -l)"
(( rows_migrations >= migrations_on_disk )) \
  || fail "restored schema is behind: ${rows_migrations} migrations applied, ${migrations_on_disk} in the repo"

# Row counts a human can sanity-check against what the factory did last week. Logged
# rather than asserted — the right number is a judgement, and a threshold here would
# either page on a quiet Eid week or never fire at all.
for t in orders grns hourly_outputs payroll_runs audit_log; do
  scratch_number n "select case when to_regclass('public.${t}') is null then -1 else (select count(*) from ${t}) end"
  log "  ${t}: ${n} rows"
done

# ── 7 · Verdict ────────────────────────────────────────────────────────────────
total_seconds=$(( restore_seconds + replay_seconds ))
log "restore+replay took ${total_seconds}s of the ${RTO_BUDGET_SECONDS}s RTO budget ($(( total_seconds * 100 / RTO_BUDGET_SECONDS ))%)"

if (( total_seconds > RTO_BUDGET_SECONDS / 2 )); then
  # Not a failure — a warning with a number on it. Restore time grows with the database,
  # and the useful moment to notice is when it passes half the budget, not when it
  # passes all of it during an actual outage.
  log "WARNING: restore is over half the RTO budget. Plan the next step (bigger host, more process-max) now, not during an incident."
fi

log 'PASSED — the backups restore'
report 'true'
