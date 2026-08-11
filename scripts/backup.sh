#!/usr/bin/env bash
# Nightly Postgres backup via pgBackRest: FULL on Sunday, DIFFERENTIAL every other day.
#
#   systemd:  ops/systemd/fabricxai-backup.{service,timer}   ← preferred
#   cron:     15 1 * * * /opt/fabricxai/scripts/backup.sh >> /var/log/fabricxai-backup.log 2>&1
#
# 01:15 Asia/Dhaka — after the nightly derivations at 00:30 have finished, before the
# morning shift starts entering anything. A backup that runs during the day-close job
# captures a database mid-derivation, which restores fine but takes longer to reason
# about at 3am.
#
# DOCUMENTS ARE NOT HERE ANY MORE. They used to be mirrored at the end of this script,
# once a night, which gave the database a 15-minute RPO and its attachments a 24-hour
# one — a restore could produce a GRN row whose challan photo did not exist. They now
# sync every 15 minutes via scripts/docs-sync.sh, so both halves of a restore land at
# the same moment in time.
#
# Exits non-zero on any failure and says which step failed. A backup script that fails
# quietly is the specific way people discover they have no backups.
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-/opt/fabricxai/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-/opt/fabricxai/.env.production}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/opt/fabricxai/.env.backup}"
STANZA="${PGBACKREST_STANZA:-fabricxai}"

started_at=$(date +%s)

log() { printf '[backup] %s · %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

fail() {
  log "FAILED at: ${1}"
  # Surface it where somebody is looking. The app's own notification path needs the
  # database, which is the thing that may be broken, so this deliberately does not use
  # it — wire BACKUP_ALERT_URL to whatever the factory's on-call actually watches.
  if [[ -n "${BACKUP_ALERT_URL:-}" ]]; then
    curl -fsS -m 20 -X POST "${BACKUP_ALERT_URL}" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"FabricXAI backup FAILED at: ${1}\"}" || true
  fi
  exit 1
}

trap 'fail "${BASH_COMMAND}"' ERR

# shellcheck disable=SC1090
[[ -f "${BACKUP_ENV_FILE}" ]] && set -a && source "${BACKUP_ENV_FILE}" && set +a

: "${PGBACKREST_REPO1_S3_BUCKET:?set in ${BACKUP_ENV_FILE} — see .env.backup.example}"
: "${PGBACKREST_REPO1_CIPHER_PASS:?set in ${BACKUP_ENV_FILE} — without it the repository is unreadable}"

compose() { docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" --profile backup "$@"; }
# The `backup` service's entrypoint IS pgbackrest, so everything after the service name
# is arguments to it.
pgbackrest() { compose run --rm backup "$@"; }

# ── 1 · Which kind of backup ───────────────────────────────────────────────────
#
# Weekly full, daily differential. DIFFERENTIAL rather than incremental on purpose: a
# restore from a diff reads two backups — the full and one diff — where a chain of
# incrementals reads up to seven, each a serial dependency inside the 4h RTO. Saturday's
# diff is larger than an incremental would be; storage is cheap and the sixth hour of an
# outage is not.
TYPE=diff
[[ "$(date +%u)" == '7' ]] && TYPE=full
log "pgBackRest ${TYPE} backup starting (stanza=${STANZA})"

pgbackrest --stanza="${STANZA}" --type="${TYPE}" backup

log "pgBackRest ${TYPE} backup complete"

# ── 2 · Prove it, rather than trusting the exit code ───────────────────────────
#
# `check` is the end-to-end assertion the exit code above cannot make: it forces a WAL
# switch and confirms the segment actually arrives in the repository. That is the whole
# RPO promise in one command, and it is the check that catches an archive_command which
# has been failing since a credential rotation three weeks ago.
log "verifying archive round-trip"
pgbackrest --stanza="${STANZA}" check

# What does the repository think it holds? `info` failing here means the backup wrote
# something the repo cannot read back.
pgbackrest --stanza="${STANZA}" info

# Retention is applied by `backup` itself per repo1-retention-* in pgbackrest.conf —
# there is no separate expire step, and adding one would only risk expiring more than
# the config intends.

# ── 3 · Say so ─────────────────────────────────────────────────────────────────
#
# A heartbeat on SUCCESS, not only an alert on failure. The failure mode this catches is
# the one that matters: the timer silently stopping, where no alert ever fires because
# nothing ever runs. Point BACKUP_HEARTBEAT_URL at a dead-man's-switch monitor.
elapsed=$(( $(date +%s) - started_at ))

if [[ -n "${BACKUP_HEARTBEAT_URL:-}" ]]; then
  curl -fsS -m 20 "${BACKUP_HEARTBEAT_URL}" \
    || log 'heartbeat ping failed (the backup itself was fine)'
fi

log "done · type=${TYPE} · ${elapsed}s"
