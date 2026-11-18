// One budget of working threads for everything the server builds at the
// same moment: CPU_BUDGET, the number of CPUs unless set. A photo build
// (one vips process, single-threaded) takes one unit; a video job takes as
// many units as the threads it is started with that do work (decoders,
// filters, encoders, our compositing threads; ffmpeg's own demuxing,
// muxing and scheduling threads mostly wait and are not counted). Every job
// is started with thread options derived from its share (videoShares), so
// the sum of working threads never exceeds the budget, instead of each
// job multiplying its own threads by the machine's CPU count.
//
// Photos come first: while any photo build is waiting, no video job starts
// (the queues take turns; a running video job finishes its work).

import os from 'os';

import { CPU_BUDGET } from './config.js';

let used = 0;
const listeners = new Set();

// Take units if they are free now; true when taken.
export function tryTakeCpu(units) {
  const want = Math.min(units, CPU_BUDGET);
  if (used + want > CPU_BUDGET) return false;
  used += want;
  return true;
}

export function giveBackCpu(units) {
  used = Math.max(0, used - Math.min(units, CPU_BUDGET));
  for (const listener of listeners) listener();
}

// Called whenever units are given back (the queues try to start work).
export function onCpuFree(listener) { listeners.add(listener); }

export function cpuInUse() { return { used, total: CPU_BUDGET }; }

// The threads of a sheet of tileCount tiles given these units: one for
// the compositor's own thread, and the rest split between decoder lanes (a
// single-threaded decoder and a compositing thread each, about one core)
// and x264, in proportion to their work. CPU seconds for one 60-second 4K
// sheet, measured on 16 CPUs (the same whatever the split):
//   h100,   400 tiles: lanes 180,   x264 390, compositor  90
//   h25,  4,599 tiles: lanes 1,000, x264 330, compositor 280
// Decoding grows with the tile count (every clip is opened and its frames
// started again for each chunk), so a sheet of thousands of small tiles
// needs several lanes and one of a hundred large ones a single lane; with
// too few lanes x264 waits for frames: an h100 sheet with 1 lane and 13
// x264 threads used 4.7 cores and took 141 s, with 2 lanes and 6 threads
// 7.4 cores and 90 s; an h25 sheet with 3 lanes and 5 threads 5.4 cores
// and 303 s, with 6 lanes and 3 threads 8.7 cores and 190 s.
export function sheetThreads(units, tileCount) {
  const laneWork = 120 + 0.19 * tileCount;
  const encoderWork = 400;
  const shared = Math.max(2, units - 1);
  const lanes = Math.max(1, Math.min(shared - 1, Math.round(shared * laneWork / (laneWork + encoderWork))));
  return { encoderThreads: Math.max(1, shared - lanes), lanes };
}

// The thread options of each kind of video job, from the budget B:
//   clip    3 units: its decoder thread, its filter thread, and the tier
//           encoders, which work on tiny pictures: measured on a real
//           480p clip, decoder 0.61 cores, filters 0.83, the four encoders
//           0.60 + 0.20 + 0.09 + 0.05 (one core together); on 1080p HEVC
//           the decoder 0.95 and the encoders 0.15 together
//   web     at most half the budget and 8: 1 decoder, 1 filter, the rest x264
//   sheet   what is left beside one web copy, at most 8 (sheetThreads):
//           more than 8 does not make one sheet faster, it leaves x264 or
//           the lanes waiting, so a larger budget runs several sheets side
//           by side instead (video_stage.js), as many as memory allows
//           (sheetsAtOnce)
export function videoShares() {
  const B = CPU_BUDGET;
  const web = Math.min(B, 8, Math.max(2, Math.floor(B / 2)));
  const sheet = Math.min(B, Math.max(2, Math.min(8, B - web)));
  return {
    clip: { units: Math.min(B, 3) },
    sheet: { units: sheet },
    web: { units: web, decoderThreads: 1, filterThreads: 1, encoderThreads: Math.max(1, web - 2) },
    // A storyboard: one decoder thread and one filter thread, then vips.
    storyboard: { units: Math.min(B, 2) },
  };
}

// How many sheets may be composed at the same moment for memory: a full 4K
// sheet peaked at 2.4 to 2.8 GB measured (its two chunks of frames, x264's
// frames and lookahead, the lanes' decoders), so 3 GiB each, within half
// of the machine's memory (the rest is for web copies, photos, the page
// cache), and always at least one.
const SHEET_MEMORY = 3 * 1024 ** 3;
export function sheetsAtOnce() {
  return Math.max(1, Math.floor(os.totalmem() / 2 / SHEET_MEMORY));
}
