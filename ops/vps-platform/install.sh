#!/usr/bin/env bash
# Installs the auto-deploy timer. Run as root, once, from /opt/fabricxai-platform:
#   sudo ops/vps-platform/install.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

install -m 644 "$here/fabricxai-platform-autodeploy.service" /etc/systemd/system/
install -m 644 "$here/fabricxai-platform-autodeploy.timer" /etc/systemd/system/
chmod 755 "$here/deploy.sh" "$here/autodeploy.sh"

systemctl daemon-reload
systemctl enable --now fabricxai-platform-autodeploy.timer

systemctl list-timers fabricxai-platform-autodeploy.timer --no-pager
echo "installed. Follow deploys with: journalctl -u fabricxai-platform-autodeploy.service -f"
