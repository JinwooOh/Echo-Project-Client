# Echo Pi Client

Raspberry Pi Zero 2 frontend for the Echo Music Agent. Records voice, transcribes via OpenAI Whisper, sends to the backend, and plays generated music.

## Requirements

- Node.js 18+
- Python 3 with: Pillow, numpy, spidev (for Whisplay display)
- System: sox, mpg123
- Whisplay display hardware (or use web simulator)

---

## Running on Raspberry Pi

### 1. Install system dependencies

```bash
sudo apt update
sudo apt install -y sox mpg123 python3-pip python3-venv
# For Whisplay display (Raspberry Pi):
sudo apt install -y python3-spidev python3-rpi-lgpio python3-libgpiod
# rpi-lgpio: Pi 5 / Bookworm compatibility. libgpiod: button fallback.
# Or for Radxa: sudo apt install python3-libgpiod
```

### 2. Install Node.js (if not present)

```bash
# Option A: nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 20

# Option B: NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 3. Deploy the client

```bash
# Copy the client folder to the Pi (e.g. ~/echo-client)
# Or clone/copy from your repo
cd ~/echo-client   # or your path
```

### 4. Copy Python display files

Copy from `whisplay-ai-chatbot` into `client/python/`:

- `whisplay.py`
- `status-bar-icon/` (optional, for battery/network icons)
- `img/` (optional, for logo)

### 5. Configure

```bash
cp .env.example .env
nano .env   # or vim
```

Set:

- `ECHO_BASE_URL` – backend URL (e.g. `http://192.168.1.10:8000` or Tailscale)
- `ECHO_BEARER_TOKEN` – same as backend
- `OPENAI_API_KEY` – for Whisper STT
- `SOUND_CARD_INDEX` – usually `1` for wm8960

### 6. Install and build

```bash
npm install
npm run build

# Python deps for display (venv uses --system-site-packages for apt rpi-lgpio)
cd python
python3 -m venv --system-site-packages .venv
.venv/bin/pip install -r requirements.txt
cd ..
```

### 7. Run

**With Whisplay hardware:**
```bash
./run_echo.sh
```

If you get `RuntimeError: Failed to add edge detection`:
- **Pi 5 / Bookworm**: Use `rpi-lgpio` instead of RPi.GPIO. The venv includes it; if using system Python: `sudo apt install python3-rpi-lgpio`
- **GPIO permissions**: `sudo usermod -aG gpio $USER` then log out and back in
- **Code fallback**: If edge detection still fails, the code uses gpiod polling automatically

**Without Whisplay hardware (web simulator only):**
```bash
./run_echo.sh --no-display
# Or: WHISPLAY_DEVICE_ENABLED=false WHISPLAY_WEB_ENABLED=true ./run_echo.sh
# Open http://<pi-ip>:17880 from another device for the button UI
```

### 8. Run on boot (systemd)

Create `/etc/systemd/system/echo-client.service`:

```ini
[Unit]
Description=Echo Pi Client
After=network.target sound.target
Wants=sound.target

[Service]
Type=simple
User=pi
Group=audio
SupplementaryGroups=audio video gpio
WorkingDirectory=/home/pi/echo-client
ExecStart=/home/pi/echo-client/run_echo.sh
Environment=PATH=/home/pi/.nvm/versions/node/v20.x.x/bin:/usr/bin:/bin
Environment=NODE_ENV=production
PrivateDevices=no
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable echo-client
sudo systemctl start echo-client
sudo systemctl status echo-client
```

---

## Running on Mac (development)

**Web simulator only:**
```bash
WHISPLAY_DEVICE_ENABLED=false WHISPLAY_WEB_ENABLED=true npm start
# Open http://localhost:17880
```

---

## Button Behavior

- **Short press** (< 400ms): Cycle through genre presets
- **Long press** (> 400ms): Start recording; release to stop

## Flow

1. Idle: Display shows current genre
2. Long press: Record voice
3. Release: Transcribe (OpenAI Whisper) → Submit to backend → Long poll → Play audio
