// ffmpeg and ffprobe subprocess helpers: the one place they are started.
//
// Mirrors runVips (vips.js): every child runs at nice 10 under C.UTF-8, has
// a timeout, is killed on server shutdown, and a call cut short by the
// shutdown neither resolves nor rejects (a rejection would be recorded as a
// failed video). Calls can also be tagged with an owner (a gallery folder),
// so a rebuild from scratch can stop the work of that one folder.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { registerChild, unregisterChild } from './child_registry.js';
import { FFMPEG_TIMEOUT_SECONDS } from './config.js';

const FFMPEG_ENV = { ...process.env, LC_ALL: 'C.UTF-8' };

// Originals come from anywhere (uploads, rsync), and ffmpeg picks a demuxer
// by sniffing the bytes, not by the extension. Some demuxers open other
// files or URLs named inside the file (HLS and DASH playlists, the concat
// and image-sequence demuxers, tee), which would let an uploaded "video"
// read local files into its own web copy or make the server fetch URLs.
// So every original is opened with the local-file protocol only and with
// the demuxers of real video containers only.
const ALLOWED_DEMUXERS = [
  'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2',   // one demuxer, all its names
  'matroska', 'webm', 'avi', 'asf', 'flv', 'mpeg', 'mpegts', 'mpegvideo',
  'ogg', 'h264', 'hevc', 'm4v', 'dv', 'vc1', 'mxf',
].join(',');
export const UNTRUSTED_INPUT_OPTIONS = ['-protocol_whitelist', 'file', '-format_whitelist', ALLOWED_DEMUXERS];
// A GIF (videos.js, animated GIFs) is opened with the GIF demuxer and no
// other: a file named .gif that holds something else (an MP4, a playlist)
// is not read as a video.
export const GIF_INPUT_OPTIONS = ['-protocol_whitelist', 'file', '-format_whitelist', 'gif', '-f', 'gif'];

export class FfmpegError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;  // 'not-started' | 'killed' | 'timed-out' | 'exit' | 'stopped'
  }
}

const running = new Map();  // child process -> owner (or null)
let stopping = false;

// Server shutdown: kill every ffmpeg and start no more. The temp files they
// leave are swept by the next build of their folder (videos.js).
export function stopFfmpegProcesses() {
  stopping = true;
  for (const proc of running.keys()) proc.kill('SIGKILL');
}

// Kill the running ffmpeg processes of one owner. Their calls reject with
// kind 'stopped', so the caller can tell this from a failure of the video.
export function stopFfmpegOf(owner) {
  for (const [proc, procOwner] of running) {
    if (procOwner === owner) { proc.stoppedByOwner = true; proc.kill('SIGKILL'); }
  }
}

function lowerPriority(proc) {
  try { os.setPriority(proc.pid, 10); } catch {}
}

// Run ffmpeg or ffprobe. Resolves with stdout (captureStdout) or ''.
// timeoutSeconds defaults to FFMPEG_TIMEOUT_SECONDS; probes pass less.
// cwd: the directory relative names are in (default: the server's).
export function runFfmpeg(cmd, args, { owner = null, captureStdout = false, timeoutSeconds = FFMPEG_TIMEOUT_SECONDS, cwd = undefined } = {}) {
  return new Promise((resolve, reject) => {
    if (stopping) return;
    const fullArgs = cmd === 'ffmpeg' ? ['-nostdin', '-hide_banner', '-v', 'error', ...args] : ['-v', 'error', ...args];
    const proc = spawn(cmd, fullArgs, { env: FFMPEG_ENV, cwd, stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'] });
    running.set(proc, owner);
    registerChild(proc.pid);
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    // Before anything can throw: a failed spawn has no streams, and an
    // unhandled 'error' event would end the server.
    proc.on('error', e => { running.delete(proc); unregisterChild(proc.pid); settle(reject, new FfmpegError(`${cmd} could not be started: ${e.message}`, 'not-started')); });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      settle(reject, new FfmpegError(`${cmd} timed out after ${timeoutSeconds} s`, 'timed-out'));
    }, timeoutSeconds * 1000);
    lowerPriority(proc);
    let out = '', err = '';
    proc.stdout?.on('data', d => { out += d; });
    // ffmpeg can print a line per broken frame for hours; keep the start,
    // which says what went wrong first.
    proc.stderr?.on('data', d => { if (err.length < 16384) err += d; });
    proc.on('close', (code, signal) => {
      running.delete(proc);
      unregisterChild(proc.pid);
      if (stopping) { clearTimeout(timer); return; }
      if (proc.stoppedByOwner) return settle(reject, new FfmpegError(`${cmd} was stopped`, 'stopped'));
      if (signal) return settle(reject, new FfmpegError(`${cmd} was killed (${signal})`, 'killed'));
      if (code !== 0) return settle(reject, new FfmpegError(`${cmd} failed (code=${code}): ${err.trim() || '(silent)'}`, 'exit'));
      settle(resolve, out);
    });
  });
}

// ---------- startup check ----------

// Every video step shells out to ffmpeg, and the web copies and mosaics are
// H.264 + AAC, so a build without libx264 (some minimal builds leave it out
// for licence reasons) or without the AAC encoder could make nothing.
// Refuse to start, naming what is missing, as preflightVips does.
export function preflightFfmpeg() {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const probe = spawnSync(tool, ['-version'], { env: FFMPEG_ENV });
    if (probe.error || probe.status !== 0) {
      console.error(`[fatal] '${tool}' is missing or not runnable. Install ffmpeg (Debian: apt install ffmpeg).`);
      process.exit(1);
    }
  }
  const encoders = String(spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { env: FFMPEG_ENV }).stdout);
  for (const [encoder, purpose] of [['libx264', 'H.264 (web copies and mosaics)'], ['aac', 'AAC (web copy audio)']]) {
    if (!new RegExp('^\\s*A?V?[A-Z.]{5,6}\\s+' + encoder + '\\s', 'm').test(encoders)) {
      console.error(`[fatal] ffmpeg has no ${encoder} encoder, needed for ${purpose}. Install an ffmpeg built with it (Debian's ffmpeg package is).`);
      process.exit(1);
    }
  }
  const filters = String(spawnSync('ffmpeg', ['-hide_banner', '-filters'], { env: FFMPEG_ENV }).stdout);
  for (const filter of ['thumbnail', 'fillborders', 'scale', 'pad', 'setpts']) {
    if (!new RegExp('\\s' + filter + '\\s').test(filters)) {
      console.error(`[fatal] ffmpeg has no ${filter} filter, which the video atlas needs. Install a full ffmpeg build.`);
      process.exit(1);
    }
  }
  const encodeProblem = tinyEncodeProblem();
  if (encodeProblem) {
    console.error(`[fatal] ffmpeg cannot encode H.264 + AAC MP4: ${encodeProblem}`);
    process.exit(1);
  }
}

// Encode a tenth of a second of test video with sound, the way web copies
// are made. Returns null on success, else what ffmpeg said.
function tinyEncodeProblem() {
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggvideo-ffmpeg-probe-')); }
  catch (error) { return `cannot use the temp directory ${os.tmpdir()} (${error.code || error.message})`; }
  try {
    const output = path.join(dir, 'probe.mp4');
    const probe = spawnSync('ffmpeg', [
      '-nostdin', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=0.1',
      '-f', 'lavfi', '-i', 'sine=duration=0.1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output,
    ], { env: FFMPEG_ENV, timeout: 60000 });
    if (probe.error) return probe.error.message;
    if (probe.status === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) return null;
    return String(probe.stderr).trim() || `ffmpeg exited with status ${probe.status} and wrote no file`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
