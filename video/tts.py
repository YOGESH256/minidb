#!/usr/bin/env python3
"""Piper-voice narration via sherpa-onnx (open source, works on macOS arm64 where the piper wheels do not).
Usage: echo "text" | python tts.py -m <model-dir> -f out.wav [--sentence-silence 0.35]
Model dir = an unpacked vits-piper-* bundle from the sherpa-onnx tts-models release (onnx + tokens.txt + espeak-ng-data).
"""
import argparse, array, sys, wave
import sherpa_onnx

ap = argparse.ArgumentParser()
ap.add_argument('-m', '--model', required=True)
ap.add_argument('-f', '--out', required=True)
ap.add_argument('--sentence-silence', type=float, default=0.35)
ap.add_argument('--speed', type=float, default=1.0)
a = ap.parse_args()
import glob, os
onnx = glob.glob(os.path.join(a.model, '*.onnx'))[0]
cfg = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
    vits=sherpa_onnx.OfflineTtsVitsModelConfig(model=onnx, tokens=os.path.join(a.model, 'tokens.txt'), data_dir=os.path.join(a.model, 'espeak-ng-data')),
    num_threads=4))
tts = sherpa_onnx.OfflineTts(cfg)
text = sys.stdin.read().strip()
# one generate() per sentence so the pause between sentences is under our control
import re
sentences = [s for s in re.split(r'(?<=[.!?])\s+', text) if s]
rate = None
pcm = array.array('h')
for s in sentences:
    g = tts.generate(s, sid=0, speed=a.speed)
    rate = g.sample_rate
    pcm.extend(max(-32768, min(32767, int(x * 32767))) for x in g.samples)
    pcm.extend([0] * int(rate * a.sentence_silence))
with wave.open(a.out, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm.tobytes())
