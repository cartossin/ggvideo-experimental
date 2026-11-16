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
export function freeCpu() { return CPU_BUDGET - used; }

// The threads of a sheet of tileCount tiles given these units: lanes of
// (one decoder thread + one compositing thread), plus the compositor's
// thread, and the rest for x264. Decoding is what limits a sheet of
// thousands of small tiles, encoding one of a hundred large ones: watched
// on 16 CPUs, an h200 sheet (104 tiles) kept 5 lanes at a third of a core
// each while x264 used all of its 4 threads. So about one lane per 600
// tiles, and x264 never less than a quarter of the units.
export function sheetThreads(units, tileCount) {
  const mostLanes = Math.max(1, Math.floor((units - 1 - Math.ceil(units / 4)) / 2));
  const lanes = Math.max(1, Math.min(mostLanes, Math.round(tileCount / 600)));
  const encoderThreads = Math.max(1, units - 1 - 2 * lanes);
  return { encoderThreads, lanes };
}

// The thread options of each kind of video job, from the budget B:
//   clip    3 units: its decoder thread, its filter thread, and the tier
//           encoders, which work on tiny pictures: measured on a real
//           480p clip, decoder 0.61 cores, filters 0.83, the four encoders
//           0.60 + 0.20 + 0.09 + 0.05 (one core together); on 1080p HEVC
//           the decoder 0.95 and the encoders 0.15 together
//   sheet   at least half the budget, and all of it that is free when it
//           starts (sheetThreads): a whole idle machine, or what a running
//           web copy leaves
//   web     at most half the budget and 8: 1 decoder, 1 filter, the rest x264
export function videoShares() {
  const B = CPU_BUDGET;
  const half = Math.max(2, Math.floor(B / 2));
  const web = Math.min(8, half);
  return {
    clip: { units: Math.min(B, 3) },
    sheet: { units: Math.min(B, half), takesAllFree: true },
    web: { units: Math.min(B, web), decoderThreads: 1, filterThreads: 1, encoderThreads: Math.max(1, web - 2) },
  };
}
