#!/usr/bin/env bash
# Bucket locks + lifecycle on the offsite buckets. Run ONCE, from an admin workstation.
#
#   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… ./scripts/r2-protect.sh
#
# ⚠ DO NOT RUN THIS ON THE VPS, and do not put CLOUDFLARE_API_TOKEN in .env.backup.
#
# The whole point of a bucket lock is that the credential which can DELETE backups and
# the credential which can REMOVE THE LOCK are different credentials, living in
# different places. pgBackRest and rclone hold an S3 API token on the factory's VPS;
# that token cannot touch a lock. The moment the account API token that CAN remove locks
# is stored beside it, an attacker who owns the VPS owns both, and this protection is
# decoration. Run it from a laptop, then forget the token.
#
# ── Why the prefixes look so specific ─────────────────────────────────────────────
#
# A bucket lock prevents DELETION AND OVERWRITING. pgBackRest rewrites exactly four
# objects on every single backup — its indexes:
#
#     <repo>/archive/<stanza>/archive.info   + .copy
#     <repo>/backup/<stanza>/backup.info     + .copy
#
# Locking the whole bucket therefore breaks the second backup and every one after it.
# (Verified by taking three consecutive backups against a real S3 repository and diffing
# object mtimes; those four are the only objects that change.) Everything else —
# WAL segments, backup sets, bundles, backup.history — is written once and only ever
# deleted by `expire`, so those are what we lock.
#
# ── Why 14 days does not fight retention ──────────────────────────────────────────
#
# `repo1-retention-full=4` with weekly fulls means pgBackRest deletes nothing younger
# than ~28 days. A 14-day lock therefore never collides with `expire`: by the time
# pgBackRest wants an object gone, the lock on it has long lapsed. Raising the lock past
# ~21 days starts to risk expire failing, which surfaces as a backup error rather than a
# quiet problem — but it is still a broken backup, so don't.
set -Eeuo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-${REPO_DIR}/.env.backup}"
STANZA="${PGBACKREST_STANZA:-fabricxai}"
REPO_PATH="${PGBACKREST_REPO_PATH:-fabricxai}"

# The three numbers. Change them here, and re-read the two comment blocks above first.
REPO_LOCK_DAYS="${REPO_LOCK_DAYS:-14}"        # pgBackRest WAL + backup sets
REPLACED_LOCK_DAYS="${REPLACED_LOCK_DAYS:-30}" # displaced document versions
REPLACED_EXPIRE_DAYS="${REPLACED_EXPIRE_DAYS:-90}" # …and when they are finally reaped

log() { printf '[r2-protect] %s\n' "$*"; }

# shellcheck disable=SC1090
[[ -f "${BACKUP_ENV_FILE}" ]] && set -a && source "${BACKUP_ENV_FILE}" && set +a

: "${CLOUDFLARE_ACCOUNT_ID:?export it — the Cloudflare account that owns the buckets}"
: "${CLOUDFLARE_API_TOKEN:?export it for this run only; it must NOT live in .env.backup}"
: "${PGBACKREST_REPO1_S3_BUCKET:?set in ${BACKUP_ENV_FILE}}"
: "${DOCS_BACKUP_BUCKET:?set in ${BACKUP_ENV_FILE}}"

command -v jq >/dev/null || { echo 'jq is required'; exit 2; }

if (( REPLACED_EXPIRE_DAYS <= REPLACED_LOCK_DAYS )); then
  echo "[r2-protect] refusing: the lifecycle rule would try to delete objects the lock still protects"
  echo "             (expire ${REPLACED_EXPIRE_DAYS}d must exceed lock ${REPLACED_LOCK_DAYS}d)"
  exit 1
fi

cf() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-fsS -X "${method}"
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
    -H 'Content-Type: application/json')
  [[ -n "${body}" ]] && args+=(-d "${body}")
  curl "${args[@]}" "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}${path}"
}

days_to_seconds() { echo $(( $1 * 86400 )); }

# ── 1 · pgBackRest repository ─────────────────────────────────────────────────────
#
# Two rules, and the odd-looking prefixes are load-bearing:
#
#   archive/<stanza>/1   matches the WAL directories, which are named <pg-major>-<id>
#                        (`16-1`, `17-1`, …). It deliberately does NOT match
#                        `archive.info`, which begins with 'a'. Using the literal
#                        `16-1` instead would silently stop protecting anything the day
#                        the database is upgraded to Postgres 17.
#
#   backup/<stanza>/20   matches backup labels, which all begin with a four-digit year
#                        (`20260810-013000F`). It does NOT match `backup.info` ('b') or
#                        `backup.history` ('b'). Good until the year 2100.
log "locking ${PGBACKREST_REPO1_S3_BUCKET} for ${REPO_LOCK_DAYS} days"

repo_rules=$(jq -n \
  --arg walPrefix   "${REPO_PATH}/archive/${STANZA}/1" \
  --arg setPrefix   "${REPO_PATH}/backup/${STANZA}/20" \
  --argjson maxAge  "$(days_to_seconds "${REPO_LOCK_DAYS}")" \
  '{rules: [
     {id: "fabricxai-wal",        enabled: true, prefix: $walPrefix,
      condition: {type: "Age", maxAgeSeconds: $maxAge}},
     {id: "fabricxai-backupsets", enabled: true, prefix: $setPrefix,
      condition: {type: "Age", maxAgeSeconds: $maxAge}}
   ]}')

cf PUT "/r2/buckets/${PGBACKREST_REPO1_S3_BUCKET}/lock" "${repo_rules}" | jq -e '.success' >/dev/null
log "  ✓ WAL and backup sets are undeletable for ${REPO_LOCK_DAYS} days"

# ── 2 · Document versions ─────────────────────────────────────────────────────────
#
# ONLY `_replaced/`. `live/` must stay mutable — rclone's --backup-dir works by MOVING
# the outgoing object aside, which is a copy plus a delete, and a lock on `live/` makes
# every replacement of a recently-uploaded document fail. `_replaced/` is append-only by
# construction: nothing but the lifecycle rule below ever deletes from it.
log "locking ${DOCS_BACKUP_BUCKET}/_replaced/ for ${REPLACED_LOCK_DAYS} days"

docs_rules=$(jq -n \
  --argjson maxAge "$(days_to_seconds "${REPLACED_LOCK_DAYS}")" \
  '{rules: [
     {id: "fabricxai-replaced", enabled: true, prefix: "_replaced/",
      condition: {type: "Age", maxAgeSeconds: $maxAge}}
   ]}')

cf PUT "/r2/buckets/${DOCS_BACKUP_BUCKET}/lock" "${docs_rules}" | jq -e '.success' >/dev/null
log "  ✓ displaced document versions are undeletable for ${REPLACED_LOCK_DAYS} days"

# ── 3 · …and eventually reaped ────────────────────────────────────────────────────
#
# Without this, `_replaced/` grows forever: every document ever overwritten, kept for
# the life of the deployment. 90 days is long past the point where anybody discovers
# they replaced the wrong challan.
#
# Lifecycle is the S3-compatible API rather than the account API, so it uses the SAME
# credentials rclone already has — no extra privilege needed.
log "expiring ${DOCS_BACKUP_BUCKET}/_replaced/ after ${REPLACED_EXPIRE_DAYS} days"

lifecycle=$(jq -n \
  --argjson days "${REPLACED_EXPIRE_DAYS}" \
  '{Rules: [
     {ID: "fabricxai-reap-replaced", Status: "Enabled",
      Filter: {Prefix: "_replaced/"},
      Expiration: {Days: $days}}
   ]}')

docker run --rm \
  -e AWS_ACCESS_KEY_ID="${RCLONE_CONFIG_DST_ACCESS_KEY_ID}" \
  -e AWS_SECRET_ACCESS_KEY="${RCLONE_CONFIG_DST_SECRET_ACCESS_KEY}" \
  -e AWS_DEFAULT_REGION="${RCLONE_CONFIG_DST_REGION:-auto}" \
  amazon/aws-cli:2 \
  s3api put-bucket-lifecycle-configuration \
    --endpoint-url "${RCLONE_CONFIG_DST_ENDPOINT}" \
    --bucket "${DOCS_BACKUP_BUCKET}" \
    --lifecycle-configuration "${lifecycle}"

log "  ✓ lifecycle rule set"

# ── 4 · Read it back ──────────────────────────────────────────────────────────────
#
# Because "the API returned success" and "the rule is in effect" are different claims,
# and only one of them is worth telling the factory.
echo
log 'what is now in effect:'
cf GET "/r2/buckets/${PGBACKREST_REPO1_S3_BUCKET}/lock" \
  | jq -r '.result.rules[]? | "  repo    \(.prefix)  →  \(.condition.maxAgeSeconds / 86400 | floor)d"'
cf GET "/r2/buckets/${DOCS_BACKUP_BUCKET}/lock" \
  | jq -r '.result.rules[]? | "  docs    \(.prefix)  →  \(.condition.maxAgeSeconds / 86400 | floor)d"'

echo
log 'Now unset CLOUDFLARE_API_TOKEN. For the weekly check on the VPS, put a'
log 'READ-ONLY R2 token in .env.backup as CLOUDFLARE_R2_READ_TOKEN — restore-verify.sh'
log 'uses it to confirm nobody has quietly removed these rules.'
