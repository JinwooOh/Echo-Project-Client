#!/bin/bash
# Run Echo Pi Client on Raspberry Pi
# Usage: ./run_echo.sh  or  SOUND_CARD_INDEX=1 ./run_echo.sh

set -e

# Load nvm if available (common on Pi)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Detect sound card (wm8960 or default)
card_index=${SOUND_CARD_INDEX:-1}
if [ -f /proc/asound/cards ]; then
  detected=$(awk '/wm8960|wm8960soundcard/ {print $1}' /proc/asound/cards | head -n1)
  [ -n "$detected" ] && card_index=$detected
fi
export SOUND_CARD_INDEX=$card_index

echo "===== Echo Pi Client $(date) ====="
echo "Sound card index: $SOUND_CARD_INDEX"
echo "Node: $(node -v 2>/dev/null || echo 'not found')"
echo "Working dir: $(pwd)"

# Ensure we're in client directory
cd "$(dirname "$0")"

if [ ! -f ".env" ]; then
  echo "Error: .env not found. Copy .env.example to .env and configure."
  exit 1
fi

if [ ! -d "dist" ] || [ ! -f "dist/index.js" ]; then
  echo "Building..."
  npm run build
fi

# Run with hardware display enabled
export WHISPLAY_DEVICE_ENABLED=${WHISPLAY_DEVICE_ENABLED:-true}
export WHISPLAY_WEB_ENABLED=${WHISPLAY_WEB_ENABLED:-false}

echo "Starting Echo client..."
exec node dist/index.js
