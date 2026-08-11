#!/usr/bin/env bash
# Install the backup timers. Run once, as root, on the VPS.
#
#   sudo /opt/fabricxai/ops/systemd/install.sh
#
# Replaces the crontab line docs/runbooks/deploy.md used to install. systemd rather than
# cron for three reasons that matter at 3am: `systemctl list-timers` answers "when did
# this last run and when does it run next" without reading a log, `Persistent=true`
# recovers a schedule a powered-off host missed, and a unit that fails leaves a state
# somebody can query instead of a silence.
set -Eeuo pipefail

REPO_DIR="${REPO_DIR:-/opt/fabricxai}"
UNIT_DIR=/etc/systemd/system

[[ $EUID -eq 0 ]] || { echo 'run as root'; exit 1; }
[[ -d "${REPO_DIR}" ]] || { echo "no repo at ${REPO_DIR}"; exit 1; }

# The scripts run from the repo checkout, not from a copy — a deploy that pulls a fix to
# backup.sh should not also need somebody to remember to reinstall it.
chmod +x "${REPO_DIR}"/scripts/backup.sh \
         "${REPO_DIR}"/scripts/docs-sync.sh \
         "${REPO_DIR}"/scripts/restore-verify.sh

for unit in fabricxai-backup fabricxai-docs-sync fabricxai-restore-verify; do
  install -m 0644 "${REPO_DIR}/ops/systemd/${unit}.service" "${UNIT_DIR}/${unit}.service"
  install -m 0644 "${REPO_DIR}/ops/systemd/${unit}.timer"   "${UNIT_DIR}/${unit}.timer"
done

systemctl daemon-reload

for unit in fabricxai-backup fabricxai-docs-sync fabricxai-restore-verify; do
  systemctl enable --now "${unit}.timer"
done

# The old crontab entry, if this host was deployed before the timers existed. Two things
# taking the same backup on the same schedule is not harmful, but it is confusing at
# exactly the wrong moment.
if crontab -l 2>/dev/null | grep -q 'scripts/backup.sh'; then
  echo
  echo '⚠ A crontab entry still runs scripts/backup.sh. The timer now does that.'
  echo '  Remove it:  crontab -e'
fi

echo
systemctl list-timers 'fabricxai-*' --no-pager
