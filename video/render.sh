#!/usr/bin/env bash
# Convenience wrapper: narration via sherpa-onnx (see tts.py), frames via Playwright, stitch via ffmpeg.
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-/private/tmp/claude-501/-Users-yogeshkhatri-provue-backend/c7733ba6-a41a-4558-abb0-6ad0873d53dd/scratchpad/piper-venv/bin/python}
MODEL=${MODEL:-/private/tmp/claude-501/-Users-yogeshkhatri-provue-backend/c7733ba6-a41a-4558-abb0-6ad0873d53dd/scratchpad/vits-piper-en_US-lessac-medium}
cat > .tts-wrapper.sh <<W
#!/usr/bin/env bash
exec "$PY" "$(pwd)/tts.py" "\$@"
W
chmod +x .tts-wrapper.sh
PIPER="$(pwd)/.tts-wrapper.sh" PIPER_MODEL="$MODEL" node render.mjs
