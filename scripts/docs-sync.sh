#!/usr/bin/env bash
# Documents: MinIO → offsite object storage, every 15 minutes.
#
#   ops/systemd/fabricxai-docs-sync.{service,timer}
#
# WHY 15 MINUTES. The database's RPO is 15 minutes (architecture §9) and the documents
# used to be mirrored once a night inside scripts/backup.sh. That asymmetry is not a
# rounding error, it is a broken restore: rows referencing a challan photo, a bank
# advice or a wage sheet that the object store never received. A customs officer asking
# for the UD pack does not accept "the row is there".
#
# WHAT `sync` MEANS HERE, and why deletions are survivable:
#   `rclone sync` makes the destination match the source, deletions included. On its own
#   that propagates a mistake — somebody empties a prefix, fifteen minutes later the
#   offsite copy is empty too. So every object this run would delete or overwrite is
#   MOVED first, into `_replaced/<this run's timestamp>/`, which nothing ever syncs over.
#   That is object versioning built out of primitives every S3 host has, rather than a
#   bucket feature not all of them do (Cloudflare R2, in particular, has no S3 object
#   versioning — check current provider docs before relying on one). Where the provider
#   DOES offer native versioning, turn it on as well; the two are complementary.
#
# Layout on the destination:
#   <bucket>/live/…                     the mirror a restore reads
#   <bucket>/_replaced/<ts>/…           what each run displaced, oldest recoverable copy
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-/opt/fabricxai/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-/opt/fabricxai/.env.production}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/opt/fabricxai/.env.backup}"
LOCK_FILE="${DOCS_SYNC_LOCK:-/var/lock/fabricxai-docs-sync.lock}"

log() { printf '[docs-sync] %s · %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

fail() {
  log "FAILED at: ${1}"
  if [[ -n "${BACKUP_ALERT_URL:-}" ]]; then
    curl -fsS -m 20 -X POST "${BACKUP_ALERT_URL}" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"FabricXAI document sync FAILED at: ${1}\"}" || true
  fi
  exit 1
}

trap 'fail "${BASH_COMMAND}"' ERR

# ── Never two at once ──────────────────────────────────────────────────────────
#
# A sync that takes longer than 15 minutes — a bulk upload, a slow uplink — would
# otherwise have the next timer start a second one against the same destination, and two
# concurrent `sync --backup-dir` runs can move each other's objects aside. Exit 0 rather
# than non-zero when we skip: a skipped run is the lock doing its job, not an incident.
exec {lock_fd}>"${LOCK_FILE}"
if ! flock -n "${lock_fd}"; then
  log 'previous run still going — skipping this tick'
  exit 0
fi

# shellcheck disable=SC1090
[[ -f "${BACKUP_ENV_FILE}" ]] && set -a && source "${BACKUP_ENV_FILE}" && set +a

: "${DOCS_BACKUP_BUCKET:?set in ${BACKUP_ENV_FILE} — see .env.backup.example}"
: "${RCLONE_CONFIG_DST_ENDPOINT:?set in ${BACKUP_ENV_FILE}}"

SRC_BUCKET="${S3_BUCKET:-fabricxai}"
RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
started_at=$(date +%s)

log "syncing src:${SRC_BUCKET} → dst:${DOCS_BACKUP_BUCKET}/live"

docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" --profile backup run --rm docs-sync \
  sync "src:${SRC_BUCKET}" "dst:${DOCS_BACKUP_BUCKET}/live" \
  --backup-dir "dst:${DOCS_BACKUP_BUCKET}/_replaced/${RUN_TS}" \
  --transfers 8 \
  --checkers 16 \
  --retries 3 \
  --retries-sleep 10s \
  --s3-chunk-size 16M \
  --stats 60s \
  --stats-one-line \
  --log-level "${DOCS_SYNC_LOG_LEVEL:-NOTICE}"

elapsed=$(( $(date +%s) - started_at ))

# Its own heartbeat, not the nightly backup's: a monitor cannot express "should have run
# four times in the last hour" and "should have run once last night" at the same URL.
if [[ -n "${DOCS_SYNC_HEARTBEAT_URL:-}" ]]; then
  curl -fsS -m 20 "${DOCS_SYNC_HEARTBEAT_URL}" \
    || log 'heartbeat ping failed (the sync itself was fine)'
fi

log "done · ${elapsed}s"
