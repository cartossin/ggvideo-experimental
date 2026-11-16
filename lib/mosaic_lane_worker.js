// One lane of the mosaic compositor (mosaic_worker.js): a worker thread with
// one single-threaded decoder process. The decoder reads this lane's tiles'
// clips through the concat demuxer, chunk after chunk (every tile's span of
// chunk 0, then of chunk 1, ...), cut exactly on the clips' whole-second
// keyframes, and writes raw yuv420p frames to a pipe; this thread copies
// each frame's tile rectangle into the chunk's sheet frames, which are
// shared buffers of the compositor. Lanes copy into disjoint rectangles, so
// they run side by side; that is the point of having them in threads (the
// copying, a few row copies per tile and frame, was what one thread could
// not keep up with).
//
// workerData: { members: [{ clip, clipX, clipY, clipWidth, clipHeight,
//   clipFrames }], laneIndex, listDir, width, height, fps, totalFrames,
//   chunkFrames, frames: [set0, set1] (arrays of SharedArrayBuffer) }
// Messages in: { chunk, set } fill that chunk into that set of frames;
//   { finish: true } read the decoder to its end; { stop: true }.
// Messages out: { done: chunk } | { finished: true } | { error }.

import { parentPort, workerData } from 'worker_threads';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerChild, unregisterChild } from './child_registry.js';

const { members, laneIndex, listDir, width, height, fps, totalFrames, chunkFrames, frames } = workerData;
const chunkCount = Math.ceil(totalFrames / chunkFrames);
const framesInChunk = c => Math.min(chunkFrames, totalFrames - c * chunkFrames);
const targets = frames.map(set => set.map(buffer => Buffer.from(buffer)));
const ySize = width * height;
const cSize = ySize / 4;

// ---------- the plan: which frames of which clip, in which order ----------

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

function concatList() {
  const lines = ['ffconcat version 1.0'];
  for (let c = 0; c < chunkCount; c++) {
    for (const m of members) {
      for (const [from, to] of spans(m.clipFrames, c * chunkFrames, framesInChunk(c))) {
        lines.push(`file 'file:${m.clip.replace(/'/g, "'\\''")}'`, `inpoint ${from / fps}`, `outpoint ${to / fps}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

// ---------- copying ----------

// Copy a tile (w x h at x, y; x, y, w even) out of a decoded lane frame of
// size laneW x laneH (the tile at its top left) into a sheet frame.
function blit(source, laneW, laneH, target, x, y, w, h) {
  for (let row = 0; row < h; row++) {
    source.copy(target, (y + row) * width + x, row * laneW, row * laneW + w);
  }
  const sourceC = laneW * laneH, sourceCw = laneW / 2;
  const cw = w / 2, ch = Math.ceil(h / 2), tx = x / 2, ty = y / 2, tw = width / 2;
  for (const plane of [0, 1]) {
    const s0 = sourceC + plane * (sourceC / 4), t0 = ySize + plane * cSize;
    for (let row = 0; row < ch; row++) {
      source.copy(target, t0 + (ty + row) * tw + tx, s0 + row * sourceCw, s0 + row * sourceCw + cw);
    }
  }
}

// ---------- the decoder and its pipe ----------

// The decoder hands out whole coded frames (multiples of 16, the clip at
// the top left, -apply_cropping none): when consecutive clips differ only
// in their cropping (two sizes in the same 16-pixel step), applying it gave
// the second clip the first one's size. Frames of a smaller coded size are
// padded to the lane's largest (top left); only the clip's own rectangle is
// copied out of each.
const coded = v => Math.ceil(v / 16) * 16;
const laneWidth = Math.max(...members.map(m => coded(m.clipWidth)));
const laneHeight = Math.max(...members.map(m => coded(m.clipHeight)));
const laneFrameBytes = laneWidth * laneHeight * 3 / 2;
const frame = Buffer.alloc(laneFrameBytes);
let filled = 0;

const listPath = path.join(listDir, `lane-${laneIndex}.ffconcat`);
fs.writeFileSync(listPath, concatList());
const decoder = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error',
  '-apply_cropping', 'none', '-threads', '1', '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file', '-i', listPath,
  '-threads', '1', '-filter_threads', '1', '-vf', `pad=${laneWidth}:${laneHeight}:0:0`,
  '-fps_mode', 'passthrough', '-an', '-sn', '-dn',
  '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'], { env: { ...process.env, LC_ALL: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
try { os.setPriority(decoder.pid, 10); } catch {}
registerChild(decoder.pid);
decoder.on('close', () => unregisterChild(decoder.pid));
let stderr = '';
decoder.stderr.on('data', d => { if (stderr.length < 8192) stderr += d; });
const decoderDone = new Promise((resolve, reject) => {
  decoder.on('error', e => reject(new Error('ffmpeg could not be started: ' + e.message)));
  decoder.on('close', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`a mosaic decoder ${signal ? 'was killed (' + signal + ')' : 'failed (code=' + code + ')'}: ${stderr.trim() || '(silent)'}`));
  });
});
decoderDone.catch(() => {});

const stream = decoder.stdout;
stream.pause();
let queue = null;       // [[member, frameIndex], ...] of the chunk being filled
let next = 0;
let set = 0;
let leftover = null;    // bytes of the next chunk, read before it was asked for
let draining = false;
let extraBytes = 0;
let chunkDone = null;

stream.on('data', take);
stream.on('end', () => {
  if (queue && next < queue.length) {
    decoderDone.then(() => fail(new Error(`a mosaic decoder ended after ${next} of ${queue.length} frames`)), fail);
  }
});

function take(data) {
  if (draining) { extraBytes += data.length; return; }
  let offset = 0;
  while (offset < data.length) {
    if (!queue || next >= queue.length) {
      leftover = leftover ? Buffer.concat([leftover, data.subarray(offset)]) : Buffer.from(data.subarray(offset));
      stream.pause();
      return;
    }
    const n = Math.min(laneFrameBytes - filled, data.length - offset);
    data.copy(frame, filled, offset, offset + n);
    filled += n;
    offset += n;
    if (filled === laneFrameBytes) {
      const [m, j] = queue[next++];
      blit(frame, laneWidth, laneHeight, targets[set][j], m.clipX, m.clipY, m.clipWidth, m.clipHeight);
      filled = 0;
      if (next === queue.length) {
        stream.pause();
        if (offset < data.length) leftover = Buffer.from(data.subarray(offset));
        const done = chunkDone;
        chunkDone = null;
        done();
        return;
      }
    }
  }
}

function fail(error) {
  parentPort.postMessage({ error: error.message });
}

parentPort.on('message', async message => {
  if (message.stop) {
    decoder.kill('SIGKILL');
    process.exit(0);
  }
  if (message.finish) {
    // Every planned frame was used: anything more is a fault. Reading to
    // the end lets the decoder close.
    if (leftover) return fail(new Error('a mosaic decoder sent more frames than planned'));
    draining = true;
    stream.resume();
    try { await decoderDone; } catch (e) { return fail(e); }
    if (extraBytes) return fail(new Error('a mosaic decoder sent more frames than planned'));
    parentPort.postMessage({ finished: true });
    return;
  }
  set = message.set;
  queue = [];
  for (const m of members) for (let j = 0; j < framesInChunk(message.chunk); j++) queue.push([m, j]);
  next = 0;
  chunkDone = () => parentPort.postMessage({ done: message.chunk });
  if (leftover) { const data = leftover; leftover = null; take(data); }
  if (chunkDone) stream.resume();
});
