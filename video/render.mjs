#!/usr/bin/env node
/**
 * Render video/scenes.html into an MP4 with open-source tools only:
 *   Playwright (Chromium) renders each frame deterministically via window.seekTo(t)
 *   Piper (optional) synthesizes narration per scene → scene durations follow the audio
 *   ffmpeg stitches frames + narration
 *
 * Usage:
 *   node video/render.mjs                       # captions only
 *   PIPER=/path/to/piper PIPER_MODEL=/path/voice.onnx node video/render.mjs   # with voice
 *   PLAYWRIGHT_DIR=/path/to/node_modules/playwright (defaults to ../provue-backend)
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
const frames = path.join(out, 'frames');
const audioDir = path.join(out, 'audio');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(frames, { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });

const script = JSON.parse(fs.readFileSync(path.join(here, 'script.json'), 'utf8'));
const FPS = script.fps;
const PIPER = process.env.PIPER;
const MODEL = process.env.PIPER_MODEL;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout.toString();
}
const probe = (f) => parseFloat(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]));

// ---- 1. narration (optional) → scene durations
const durations = [];
const wavs = [];
for (const [i, s] of script.scenes.entries()) {
  let dur = s.minSeconds;
  if (PIPER && MODEL) {
    const wav = path.join(audioDir, `${String(i).padStart(2, '0')}-${s.id}.wav`);
    const text = s.lines.join(' ');
    const r = spawnSync(PIPER, ['-m', MODEL, '-f', wav, '--sentence-silence', '0.35'], { input: text, env: process.env });
    if (r.status !== 0) throw new Error(`piper failed on scene ${s.id}: ${r.stderr}`);
    const a = probe(wav);
    dur = Math.max(s.minSeconds, a + 0.9); // breathing room after the last sentence
    wavs.push({ wav, dur });
    console.log(`scene ${s.id}: audio ${a.toFixed(1)}s → ${dur.toFixed(1)}s`);
  }
  durations.push(dur);
}
const total = durations.reduce((a, b) => a + b, 0);
console.log(`total ${total.toFixed(1)}s, ${Math.ceil(total * FPS)} frames`);

// ---- 2. frames
const pwDir = process.env.PLAYWRIGHT_DIR ?? path.resolve(here, '../../provue-backend/node_modules/playwright');
const require = createRequire(import.meta.url);
const { chromium } = require(pwDir);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto('file://' + path.join(here, 'scenes.html'));
await page.evaluate(() => document.fonts.ready);
await page.evaluate(([d, c]) => window.setTimeline(d, c), [durations, script.scenes.map((s) => s.lines)]);
const nFrames = Math.ceil(total * FPS);
let lastScene = -1;
for (let i = 0; i < nFrames; i++) {
  const t = i / FPS;
  const sc = await page.evaluate((t) => window.seekTo(t), t);
  if (sc !== lastScene) {
    lastScene = sc;
    process.stdout.write(`\nscene ${sc + 1}/${script.scenes.length} `);
  }
  await page.screenshot({ path: path.join(frames, `${String(i).padStart(6, '0')}.jpg`), type: 'jpeg', quality: 88 });
  if (i % 60 === 0) process.stdout.write('.');
}
await browser.close();
console.log('\nframes done');

// ---- 3. audio track: each scene's wav padded to its duration, then concatenated
let audioArgs = [];
if (wavs.length) {
  const padded = [];
  for (const [i, w] of wavs.entries()) {
    const p = path.join(audioDir, `padded-${i}.wav`);
    sh('ffmpeg', ['-y', '-v', 'error', '-i', w.wav, '-af', `apad=whole_dur=${w.dur.toFixed(3)}`, '-ar', '22050', '-ac', '1', p]);
    padded.push(p);
  }
  const list = path.join(audioDir, 'list.txt');
  fs.writeFileSync(list, padded.map((p) => `file '${p}'`).join('\n'));
  const narration = path.join(out, 'narration.wav');
  sh('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', narration]);
  audioArgs = ['-i', narration, '-c:a', 'aac', '-b:a', '128k', '-shortest'];
}

// ---- 4. stitch
const mp4 = path.join(here, 'minidb-explained.mp4');
sh('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS), '-i', path.join(frames, '%06d.jpg'), ...audioArgs, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
console.log(`wrote ${mp4} (${(fs.statSync(mp4).size / 1048576).toFixed(1)} MB, ${total.toFixed(0)}s)`);
