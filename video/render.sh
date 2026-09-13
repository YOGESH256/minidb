#!/usr/bin/env bash
# Render video/minidb-explained.mp4: narration via sherpa-onnx (tts.py), frames via Playwright, stitch via ffmpeg.
#
# One-time setup (all open source):
#   python3 -m venv .venv && .venv/bin/pip install sherpa-onnx
#   curl -L -o vits.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-medium.tar.bz2
#   tar xjf vits.tar.bz2            # → vits-piper-en_US-lessac-medium/
#   npm i -D playwright && npx playwright install chromium   (or point PLAYWRIGHT_DIR at an existing install)
#   brew install ffmpeg
#
# Then:  PY=.venv/bin/python MODEL=./vits-piper-en_US-lessac-medium bash video/render.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${PY:?set PY to a python with sherpa-onnx installed}"
: "${MODEL:?set MODEL to an unpacked vits-piper-* directory}"
cat > .tts-wrapper.sh <<W
#!/usr/bin/env bash
exec "$PY" "$(pwd)/tts.py" "\$@"
W
chmod +x .tts-wrapper.sh
PIPER="$(pwd)/.tts-wrapper.sh" PIPER_MODEL="$MODEL" node render.mjs
