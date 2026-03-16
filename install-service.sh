#!/bin/bash
# Install Echo as a systemd service (starts on boot)
# Run with: sudo ./install-service.sh
#           sudo ./install-service.sh pi /home/pi/Echo-Project-Client
#
# Prerequisites:
#   - Echo is deployed (default: /home/echo/Echo-Project-Client)
#   - .env is configured

set -e

SERVICE_NAME="echo-client"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_FILE="${SCRIPT_DIR}/${SERVICE_NAME}.service"

# Args override env (args work with sudo; env vars often don't)
USER="${1:-${ECHO_USER:-echo}}"
INSTALL_DIR="${2:-${ECHO_INSTALL_DIR:-/home/echo/Echo-Project-Client}}"

echo "Installing Echo systemd service..."
echo "  User: $USER"
echo "  Install dir: $INSTALL_DIR"
echo ""

# Create a temporary service file with correct paths
TMP_SERVICE=$(mktemp)
sed -e "s|User=.*|User=$USER|" \
    -e "s|Group=.*|Group=$USER|" \
    -e "s|/home/echo/Echo-Project-Client|$INSTALL_DIR|g" \
    -e "s|NVM_DIR=.*|NVM_DIR=/home/${USER}/.nvm|" \
    "$SERVICE_FILE" > "$TMP_SERVICE"

sudo cp "$TMP_SERVICE" "/etc/systemd/system/${SERVICE_NAME}.service"
rm -f "$TMP_SERVICE"

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

echo ""
echo "Done. Echo will start on boot."
echo ""
echo "Commands:"
echo "  sudo systemctl start $SERVICE_NAME   # Start now"
echo "  sudo systemctl stop $SERVICE_NAME    # Stop"
echo "  sudo systemctl status $SERVICE_NAME  # Status"
echo "  journalctl -u $SERVICE_NAME -f       # View logs"
echo ""
echo "To customize user/path, run:"
echo "  sudo ./install-service.sh pi /home/pi/Echo-Project-Client"
echo ""
