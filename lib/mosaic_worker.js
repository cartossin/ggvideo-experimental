// Mosaic compositor: builds one sheet of the video atlas the way the still
// atlas is built (sprite_worker.js): tile pixels are copied into a frame of
// the sheet's size, and ONE ffmpeg encoder receives the finished frames as
// raw yuv420p on its stdin. ffmpeg never sees more than one input file per
// process, so a sheet of 4,600 tiles costs a handful of processes and
// threads, not thousands.
//
// Where the tile frames come from: each tile's preview clip (videos.js) has
// a keyframe at every whole second and no B-frames, so any whole-second
// span of it can be cut out exactly. The sheet is made in chunks of
// chunkFrames frames (a whole number of seconds, sized by the caller from a
// memory budget: the chunk's sheet frames are the only big buffers here).
// A few decoder processes ("lanes", each single-threaded) read, through the
// concat demuxer, every tile's span for chunk 0, then for chunk 1, and so
// on, and write raw frames to a pipe; this thread copies each frame's
// rectangle into the chunk's sheet frames, hands the chunk to the encoder,
// and goes on. A clip shorter than the mosaic wraps around: its spans start
// again at its first frame. Tiles of a lane that differ in size are padded
// to the lane's largest (top left), and only the tile's own rectangle is
// copied; lanes hold tiles sorted by size, so this is rare.
//
// workerData: { width, height, fps, seconds, chunkFrames, lanes, members:
//   [{ clip, clipX, clipY, clipWidth, clipHeight, clipFrames }], listDir,
//   encoderArgs (output options, ending with the output path), timeoutMs }
// Posts { ok: true, stats } or { ok: false, error }. On 'stop' it kills its
// processes and exits.

import { parentPort, workerData } from 'worker_threads';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { width, height, fps, seconds, chunkFrames, lanes: laneCount, members, listDir, encoderArgs, timeoutMs } = workerData;
const FFMPEG_ENV = { ...process.env, LC_ALL: 'C.UTF-8' };
const running = new Set();
let stopping = false;

parentPort.on('message', message => {
  if (message !== 'stop') return;
  stopping = true;
  for (const proc of running) proc.kill('SIGKILL');
  process.exit(1);
});
parentPort.unref();

function start(args, stdio) {
  const proc = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', ...args], { env: FFMPEG_ENV, stdio });
  running.add(proc);
  try { os.setPriority(proc.pid, 10); } catch {}
  let stderr = '';
  proc.stderr.on('data', d => { if (stderr.length < 8192) stderr += d; });
  proc.done = new Promise((resolve, reject) => {
    proc.on('error', e => { running.delete(proc); reject(new Error('ffmpeg could not be started: ' + e.message)); });
    proc.on('close', (code, signal) => {
      running.delete(proc);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${signal ? 'was killed (' + signal + ')' : 'failed (code=' + code + ')'}: ${stderr.trim() || '(silent)'}`));
    });
  });
  proc.done.catch(() => {});
  return proc;
}

// ---------- the plan: which frames of which clip, in which order ----------

const totalFrames = seconds * fps;
const chunkCount = Math.ceil(totalFrames / chunkFrames);
const framesInChunk = c => Math.min(chunkFrames, totalFrames - c * chunkFrames);

// The spans [from, to) of a clip of clipFrames frames that make up frames
// [start, start + count) of the mosaic: wrapping at the clip's end.
function spans(clipFrames, start, count) {
  const out = [];
  let position = start % clipFrames;
  while (count > 0) {
    const take = Math.min(count, clipFrames - position);
    out.push([position, position + take]);
    count -= take;
    position = 0;
  }
  return out;
}

// Lanes: members sorted by size, cut into runs of about equal pixel count.
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

function concatList(lane) {
  const lines = ['ffconcat version 1.0'];
  for (let c = 0; c < chunkCount; c++) {
    for (const m of lane) {
      for (const [from, to] of spans(m.clipFrames, c * chunkFrames, framesInChunk(c))) {
        lines.push(`file 'file:${m.clip.replace(/'/g, "'\\''")}'`, `inpoint ${from / fps}`, `outpoint ${to / fps}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

// ---------- copying ----------

const ySize = width * height;
const cSize = ySize / 4;
const frameBytes = ySize + 2 * cSize;

function blackFrame() {
  const frame = Buffer.alloc(frameBytes, 128);
  frame.fill(16, 0, ySize);
  return frame;
}

// Copy a tile (w x h at x, y; all even) out of a decoded lane frame of
// size laneW x laneH (the tile at its top left) into a sheet frame.
function blit(source, laneW, laneH, target, x, y, w, h) {
  for (let row = 0; row < h; row++) {
    source.copy(target, (y + row) * width + x, row * laneW, row * laneW + w);
  }
  const sourceC = laneW * laneH, sourceCw = laneW / 2;
  const cw = w / 2, ch = h / 2, tx = x / 2, ty = y / 2, tw = width / 2;
  for (const plane of [0, 1]) {
    const s0 = sourceC + plane * (sourceC / 4), t0 = ySize + plane * cSize;
    for (let row = 0; row < ch; row++) {
      source.copy(target, t0 + (ty + row) * tw + tx, s0 + row * sourceCw, s0 + row * sourceCw + cw);
    }
  }
}

// ---------- one lane: reads its pipe, frame by frame ----------

class Lane {
  constructor(members, index) {
    this.members = members;
    this.width = Math.max(...members.map(m => m.clipWidth));
    this.height = Math.max(...members.map(m => m.clipHeight));
    this.frameBytes = this.width * this.height * 3 / 2;
    this.frame = Buffer.alloc(this.frameBytes);
    this.filled = 0;
    this.listPath = path.join(listDir, `lane-${index}.ffconcat`);
    fs.writeFileSync(this.listPath, concatList(members));
    const pad = members.some(m => m.clipWidth !== this.width || m.clipHeight !== this.height)
      ? ['-vf', `pad=${this.width}:${this.height}:0:0`] : [];
    this.proc = start(['-threads', '1', '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file', '-i', this.listPath,
      '-threads', '1', '-filter_threads', '1', ...pad, '-fps_mode', 'passthrough', '-an', '-sn', '-dn',
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'], ['ignore', 'pipe', 'pipe']);
    this.stream = this.proc.stdout;
    this.stream.pause();
    this.stream.on('data', data => this.take(data));
    this.stream.on('end', () => { this.ended = true; this.settle(); });
  }
  // Fill chunk c's frames with this lane's tiles; resolves when done.
  readChunk(c, targets) {
    this.targets = targets;
    this.queue = [];
    for (const m of this.members) for (let j = 0; j < targets.length; j++) this.queue.push([m, j]);
    this.next = 0;
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      if (this.leftover) { const data = this.leftover; this.leftover = null; this.take(data); }
      if (this.next < this.queue.length) this.stream.resume();
    });
  }
  take(data) {
    if (this.draining) { this.extraBytes = (this.extraBytes || 0) + data.length; return; }
    let offset = 0;
    while (offset < data.length) {
      if (!this.queue || this.next >= this.queue.length) {
        // Bytes of the next chunk: keep them, stop reading.
        this.leftover = this.leftover ? Buffer.concat([this.leftover, data.subarray(offset)]) : Buffer.from(data.subarray(offset));
        this.stream.pause();
        return;
      }
      const n = Math.min(this.frameBytes - this.filled, data.length - offset);
      data.copy(this.frame, this.filled, offset, offset + n);
      this.filled += n;
      offset += n;
      if (this.filled === this.frameBytes) {
        const [m, j] = this.queue[this.next++];
        blit(this.frame, this.width, this.height, this.targets[j], m.clipX, m.clipY, m.clipWidth, m.clipHeight);
        this.filled = 0;
        if (this.next === this.queue.length) {
          this.stream.pause();
          const resolve = this.resolve;
          this.resolve = null;
          if (offset < data.length) this.leftover = Buffer.from(data.subarray(offset));
          resolve();
          return;
        }
      }
    }
  }
  settle() {
    if (this.resolve && this.next < this.queue.length) {
      this.proc.done.then(() => this.reject(new Error(`a decoder lane ended after ${this.next} of ${this.queue.length} frames`)),
        this.reject);
    }
  }
}

// Resolves once the frame has left this process (the write callback), so
// its buffer can be filled again for the next chunk.
function write(stream, buffer) {
  return new Promise((resolve, reject) => stream.write(buffer, error => (error ? reject(error) : resolve())));
}

async function main() {
  const started = Date.now();
  const timer = setTimeout(() => {
    for (const proc of running) proc.kill('SIGKILL');
    parentPort.postMessage({ ok: false, error: `mosaic timed out after ${timeoutMs / 1000} s` });
  }, timeoutMs);
  const encoder = start(['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0',
    ...encoderArgs], ['pipe', 'ignore', 'pipe']);
  encoder.stdin.on('error', () => {});  // a failed encoder is reported by encoder.done
  const lanes = laneMembers().map((m, i) => new Lane(m, i));
  const frames = Array.from({ length: framesInChunk(0) }, blackFrame);
  try {
    for (let c = 0; c < chunkCount; c++) {
      const targets = frames.slice(0, framesInChunk(c));
      await Promise.race([Promise.all(lanes.map(lane => lane.readChunk(c, targets))), encoder.done]);
      // A write fails when the encoder has ended: say why it did.
      for (const frame of targets) await write(encoder.stdin, frame).catch(() => encoder.done);
    }
    encoder.stdin.end();
    await encoder.done;
    // Every frame was used: anything more a lane sends is a fault. Reading
    // to the end also lets the lane's process close.
    for (const lane of lanes) {
      if (lane.leftover) throw new Error('a decoder lane sent more frames than planned');
      lane.draining = true;
      lane.stream.resume();
    }
    await Promise.all(lanes.map(lane => lane.proc.done));
    if (lanes.some(lane => lane.extraBytes)) throw new Error('a decoder lane sent more frames than planned');
    clearTimeout(timer);
    parentPort.postMessage({ ok: true, stats: { seconds: (Date.now() - started) / 1000, lanes: lanes.length,
      chunkFrames, frameBufferMb: Math.round(frames.length * frameBytes / 1e6) } });
  } finally {
    clearTimeout(timer);
    for (const proc of running) proc.kill('SIGKILL');
  }
}

main().catch(e => { if (!stopping) parentPort.postMessage({ ok: false, error: e.message }); });
