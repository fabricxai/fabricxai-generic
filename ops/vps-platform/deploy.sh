#!/usr/bin/env bash
# Deploy the platform stack to ONE specific image digest.
#
# Doubles as the forced command for a GitHub Actions deploy key (deploy.yml), which is
# why it reads SSH_ORIGINAL_COMMAND when no argument is given and refuses anything that
# is not a bare sha256 digest: a leaked key can re-deploy an already-published image and
# nothing else.
#
# Usage:  deploy.sh sha256:<64 hex>
set -euo pipefail

REPO_DIR=/opt/fabricxai-platform
IMG=ghcr.io/fabricxai/fabricxai-generic

digest="${1:-${SSH_ORIGINAL_COMMAND:-}}"
if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "refused: expected a bare sha256 image digest, got: ${digest}" >&2
  exit 1
fi

cd "$REPO_DIR"
compose() {
  docker compose -p fabricxai-platform \
    -f docker-compose.prod.yml -f docker-compose.platform.yml \
    --env-file .env.production "$@"
}

echo "deploying ${IMG}@${digest}"
sed -i "s|^IMAGE=.*|IMAGE=${IMG}@${digest}|" .env.production

compose pull app worker
# `up -d app worker` also recreates and re-runs `migrate` first (its image changed and
# app/worker depend on it completing) — schema before traffic, enforced not remembered.
compose up -d app worker

# Health is read from Docker rather than curling the public URL: this script must work
# the same before DNS existed, during a certificate re-issue, and at 2am over a broken
# resolver. fxp-app's own healthcheck is the app answering /api/health.
for _ in $(seq 1 36); do
  status="$(docker inspect -f '{{.State.Health.Status}}' fxp-app 2>/dev/null || echo absent)"
  if [[ "$status" == healthy ]]; then
    echo "deploy complete: ${digest}"
    exit 0
  fi
  sleep 5
done

echo "deploy finished but fxp-app never reported healthy (last status: ${status})" >&2
echo "inspect with: docker logs fxp-app --tail 100 ; docker logs fxp-migrate" >&2
exit 1
