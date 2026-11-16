// Mosaic compositor: builds one sheet of the video atlas the way the still
// atlas is built (sprite_worker.js): tile pixels are copied into frames of
// the sheet's size, and ONE ffmpeg encoder receives the finished frames as
// raw yuv420p on its stdin. No ffmpeg ever reads more than one file at a
// time, so a sheet of 4,600 tiles costs a handful of processes and threads,
// not thousands.
//
// Where the tile frames come from: each tile's preview clip (videos.js) has
// a keyframe at every whole second and no B-frames, so any whole-second
// span of it can be cut out exactly. The sheet is made in chunks of
// chunkFrames frames (whole seconds). A few "lanes" share the tiles: each is
// a worker thread (mosaic_lane_worker.js) with one single-threaded decoder
// process, and copies its tiles' decoded frames into the chunk's sheet
// frames. A clip shorter than the mosaic wraps around.
//
// The sheet frames are two sets of chunkFrames shared buffers: while the
// lanes fill one chunk, this thread hands the previous one to the encoder.
// They are the only large buffers: 2 x chunkFrames x width x height x 1.5
// bytes (the caller sizes chunkFrames from VIDEO_MOSAIC_MEMORY).
//
// workerData: { width, height, fps, seconds, chunkFrames, lanes, members:
//   [{ clip, clipX, clipY, clipWidth, clipHeight, clipFrames }], listDir,
//   encoderArgs (output options, ending with the output path), timeoutMs }
// Posts { ok: true, stats } or { ok: false, error }. On 'stop' it stops its
// lanes and encoder and exits.

import { Worker, parentPort, workerData } from 'worker_threads';
import { spawn } from 'child_process';
import os from 'os';
import { registerChild, unregisterChild } from './child_registry.js';

const { width, height, fps, seconds, chunkFrames, lanes: laneCount, members, listDir, encoderArgs, timeoutMs } = workerData;
const FFMPEG_ENV = { ...process.env, LC_ALL: 'C.UTF-8' };
const totalFrames = seconds * fps;
const chunkCount = Math.ceil(totalFrames / chunkFrames);
const framesInChunk = c => Math.min(chunkFrames, totalFrames - c * chunkFrames);
const frameBytes = width * height * 3 / 2;

let encoder = null;
let laneWorkers = [];
let stopping = false;

function stopEverything() {
  if (encoder) encoder.kill('SIGKILL');
  for (const lane of laneWorkers) lane.postMessage({ stop: true });
}

parentPort.on('message', message => {
  if (message !== 'stop') return;
  stopping = true;
  stopEverything();
  const ended = laneWorkers.map(lane => new Promise(resolve => lane.once('exit', resolve)));
  Promise.race([Promise.all(ended), new Promise(resolve => setTimeout(resolve, 2000))]).then(() => process.exit(1));
});
parentPort.unref();

function startEncoder() {
  const proc = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0', ...encoderArgs],
  { env: FFMPEG_ENV, stdio: ['pipe', 'ignore', 'pipe'] });
  try { os.setPriority(proc.pid, 10); } catch {}
  registerChild(proc.pid);
  proc.on('close', () => unregisterChild(proc.pid));
  let stderr = '';
  proc.stderr.on('data', d => { if (stderr.length < 8192) stderr += d; });
  proc.stdin.on('error', () => {});  // a failed encoder is reported by proc.done
  proc.done = new Promise((resolve, reject) => {
    proc.on('error', e => reject(new Error('ffmpeg could not be started: ' + e.message)));
    proc.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`the mosaic encoder ${signal ? 'was killed (' + signal + ')' : 'failed (code=' + code + ')'}: ${stderr.trim() || '(silent)'}`));
    });
  });
  proc.done.catch(() => {});
  return proc;
}

// Lanes: members sorted by size (tiles of one size need no padding in the
// decoder), cut into runs of about equal pixel count.
function laneMembers() {
  const sorted = members.map((m, index) => ({ ...m, index }))
    .sort((a, b) => a.clipWidth - b.clipWidth || a.clipHeight - b.clipHeight || a.index - b.index);
  const total = sorted.reduce((sum, m) => sum + m.clipWidth * m.clipHeight, 0);
  const count = Math.max(1, Math.min(laneCount, sorted.length));
  const out = Array.from({ length: count }, () => []);
  let lane = 0, filled = 0;
  for (const m of sorted) {
    if (filled >= total * (lane + 1) / count && lane < count - 1) lane++;
    out[lane].push(m);
    filled += m.clipWidth * m.clipHeight;
  }
  return out.filter(l => l.length);
}

function blackFrame() {
  const buffer = new SharedArrayBuffer(frameBytes);
  const frame = Buffer.from(buffer);
  frame.fill(128);
  frame.fill(16, 0, width * height);
  return buffer;
}

// Resolves once the frame has left this process (the write callback), so
// its buffer can be filled again.
function write(stream, buffer) {
  return new Promise((resolve, reject) => stream.write(buffer, error => (error ? reject(error) : resolve())));
}

// A lane worker's answers, in order: one promise per message sent.
function laneChannel(worker) {
  const waiting = [];
  let failure = null;
  const failAll = error => { failure = failure || error; for (const w of waiting.splice(0)) w.reject(failure); };
  worker.on('message', message => {
    if (message.error) return failAll(new Error(message.error));
    const w = waiting.shift();
    if (w) w.resolve(message);
  });
  worker.on('error', failAll);
  worker.on('exit', code => { if (waiting.length) failAll(new Error('a mosaic lane ended (code ' + code + ')')); });
  return message => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    waiting.push({ resolve, reject });
    worker.postMessage(message);
  });
}

async function main() {
  const started = Date.now();
  const timer = setTimeout(() => {
    stopEverything();
    parentPort.postMessage({ ok: false, error: `mosaic timed out after ${timeoutMs / 1000} s` });
    setTimeout(() => process.exit(1), 2000);
  }, timeoutMs);
  const sets = [0, 1].map(() => Array.from({ length: framesInChunk(0) }, blackFrame));
  const views = sets.map(set => set.map(buffer => Buffer.from(buffer)));
  encoder = startEncoder();
  laneWorkers = laneMembers().map((laneMembersList, laneIndex) => new Worker(new URL('./mosaic_lane_worker.js', import.meta.url), {
    workerData: { members: laneMembersList, laneIndex, listDir, width, height, fps, totalFrames, chunkFrames, frames: sets },
  }));
  const send = laneWorkers.map(laneChannel);
  const fill = c => Promise.all(send.map(ask => ask({ chunk: c, set: c % 2 })));
  const encoderEndedEarly = encoder.done.then(() => { throw new Error('the mosaic encoder ended before its last frame'); });
  encoderEndedEarly.catch(() => {});
  try {
    let filling = fill(0);
    for (let c = 0; c < chunkCount; c++) {
      await Promise.race([filling, encoderEndedEarly]);
      if (c + 1 < chunkCount) filling = fill(c + 1);
      // A write fails when the encoder has ended: say why it did.
      for (let j = 0; j < framesInChunk(c); j++) await write(encoder.stdin, views[c % 2][j]).catch(() => encoder.done);
    }
    encoder.stdin.end();
    await encoder.done;
    await Promise.all(send.map(ask => ask({ finish: true })));
    clearTimeout(timer);
    parentPort.postMessage({ ok: true, stats: { seconds: (Date.now() - started) / 1000, lanes: laneWorkers.length, chunkFrames,
      frameBufferMb: Math.round(2 * framesInChunk(0) * frameBytes / 1e6) } });
  } finally {
    clearTimeout(timer);
    if (encoder.exitCode === null) encoder.kill('SIGKILL');
    for (const lane of laneWorkers) lane.postMessage({ stop: true });
  }
}

main().catch(e => { if (!stopping) parentPort.postMessage({ ok: false, error: e.message }); });
