#!/usr/bin/env bash
# Push-to-deploy for platform.fabricxai.com, from the VPS side.
#
# CI publishes every green push to main as ghcr.io/fabricxai/fabricxai-generic:<sha>
# and moves the `:main` tag to it. This script — run every 2 minutes by
# fabricxai-platform-autodeploy.timer — resolves `:main` to its digest and, when it has
# moved, hands that digest to deploy.sh. The tag is only the doorbell; what is written
# into .env.production and what runs is the digest, so rollback stays one line
# (IMAGE=…@<previous digest>, then `deploy.sh <previous digest>` — after stopping the
# timer, or it will roll forward again).
#
# Why polling and not a GitHub Actions push: the SSH-push path needs repo secrets, which
# need repo admin. Polling needs only the GHCR read credential the host already holds,
# and a poll that finds nothing new exits silently in ~1s.
set -euo pipefail

REPO_DIR=/opt/fabricxai-platform
IMG=ghcr.io/fabricxai/fabricxai-generic

cd "$REPO_DIR"

digest="$(docker buildx imagetools inspect "${IMG}:main" \
  --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"')" || true
if [[ ! "${digest:-}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  # No :main tag yet (nothing green has been published), or GHCR/auth is unreachable.
  # Say so and exit 0 — a registry blip must not mark the timer's unit failed forever.
  echo "no deployable :main image resolved (got: ${digest:-nothing}) — skipping"
  exit 0
fi

current="$(grep -E '^IMAGE=' .env.production | sed -n 's/.*@//p')"
if [[ "$current" == "$digest" ]]; then
  exit 0
fi

echo "main moved: ${current:-none} -> ${digest}"
exec "$(dirname "$0")/deploy.sh" "$digest"
