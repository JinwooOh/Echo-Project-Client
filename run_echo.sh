#!/bin/bash
# Run Echo Pi Client on Raspberry Pi
# Usage: ./run_echo.sh
#        ./run_echo.sh --no-display   # Use web simulator only (no Whisplay hardware)
#        SOUND_CARD_INDEX=1 ./run_echo.sh

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

# Load .env for display settings (WHISPLAY_DEVICE_ENABLED, etc.)
if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  . ./.env
  set +a
fi

# Override: --no-display uses web simulator only (no Whisplay hardware / no GPIO)
for arg in "$@"; do
  if [ "$arg" = "--no-display" ]; then
    export WHISPLAY_DEVICE_ENABLED=false
    export WHISPLAY_WEB_ENABLED=true
    echo "Using web simulator only (--no-display)"
    break
  fi
done

if [ ! -d "dist" ] || [ ! -f "dist/index.js" ]; then
  echo "Building..."
  npm run build
fi

# Ensure Python venv exists for display
if [ -d "python" ] && [ ! -d "python/.venv" ]; then
  echo "Creating Python venv..."
  cd python
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
  cd ..
fi

# Run with hardware display (set WHISPLAY_DEVICE_ENABLED=false in .env if no Whisplay or GPIO errors)
export WHISPLAY_DEVICE_ENABLED=${WHISPLAY_DEVICE_ENABLED:-true}
export WHISPLAY_WEB_ENABLED=${WHISPLAY_WEB_ENABLED:-false}

echo "Starting Echo client..."
exec node dist/index.js
