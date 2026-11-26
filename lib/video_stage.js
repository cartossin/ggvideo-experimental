// The moving half of a folder's videos, made after the folder is committed.
//
// A folder becomes browsable as soon as its stills are built: a video's
// poster is a still (videos.js, build.js), so the grid shows it at once.
// Then, for each folder with videos, this stage makes, in this order:
//   1. each video's preview clips (one ffmpeg per video, all tiers at once)
//   2. the video atlas (video_atlas.js), committed as manifest.videoAtlasDir
//   3. each video's web copy, committed as manifest.videos[name].web
//   4. from each web copy, the video's storyboard (storyboard.js) and its
//      first-frame still (first_frame.js)
// All ffmpeg work of all folders shares one queue, drawing on the CPU
// budget that photo builds also use (cpu_budget.js). Clips and mosaics go
// first; a web copy (the slowest by far) takes at most half the budget, so
// a new folder's previews do not wait for hours of web copies elsewhere.
//
// The stage runs once per folder at a time, and again after it ends if it
// was asked for meanwhile. Web copies are queued by it but not waited for,
// so a folder that changes while its web copies encode gets its new
// previews without waiting for them. Each result is committed only if its
// video is still in the folder as it was when the work started; a video
// replaced meanwhile is done again.

import fsp from 'fs/promises';
import path from 'path';
import { buildQueue } from './build_queue.js';
import { CPU_BUDGET, GG_DIR, VIDEO_RETRY_SECONDS, VIDEO_TIERS } from './config.js';
import { giveBackCpu, onCpuFree, sheetsAtOnce, tryTakeCpu, videoShares } from './cpu_budget.js';
import { publish, testPause } from './durable.js';
import { stopFfmpegOf } from './ffmpeg.js';
import { logText } from './http.js';
import { loadManifest, updateManifest } from './manifest.js';
import { currentSignatures } from './sources.js';
import {
  ATLAS_RULE,
  SHEET_MAX_WIDTH,
  videoTierHeights,
  bakeVideoAtlas,
  finishedAtlasMatching,
  previousLayoutIn,
  stopMosaicWorkers,
  readAtlasInputs,
  sweepStaleVideoAtlases,
} from './video_atlas.js';
import {
  TILE_SKIRT,
  WEB_RULE,
  changeVideoRecord,
  clearFailure,
  clipPath,
  clipsAreCurrent,
  missingClipTiers,
  recordClipTiers,
  encodePreviewClips,
  encodeWebCopy,
  failureRetryAt,
  isVideoItem,
  readVideoRecord,
  recordFailure,
  sweepOrphanVideoFiles,
  sweepRecordTemp,
  sweepVideoTemps,
  tileSize,
  videoTempPath,
  webCopyIsCurrent,
  webCopyName,
  webCopyVersion,
} from './videos.js';
import { makeStoryboard, manifestStoryboard, storyboardIsCurrent, storyboardMadeFor, wantsStoryboard } from './storyboard.js';
import {
  firstFrameIsCurrent,
  firstFrameMadeFor,
  firstFrameName,
  makeFirstFrame,
  manifestFirstFrame,
  sameManifestFirstFrame,
} from './first_frame.js';

// ---------- the queue ----------

const PRIORITY_PREVIEW = 0;  // clips and mosaics
const PRIORITY_WEB = 1;      // web copies
const PRIORITY_STORYBOARD = 2;
const PRIORITY_FIRST_FRAME = 2;
const SHARES = videoShares();
const UNITS = { clips: SHARES.clip.units, sheet: SHARES.sheet.units, web: SHARES.web.units, storyboard: SHARES.storyboard.units,
  firstFrame: SHARES.firstFrame.units };
const SHEETS_AT_ONCE = sheetsAtOnce();
// One web copy and one sheet fit in the budget side by side (any budget of
// 4 or more): then a web copy never waits for previews.
const WEB_BESIDE_SHEET = UNITS.web + UNITS.sheet <= CPU_BUDGET;

// Video jobs start when their share of the CPU budget is free
// (cpu_budget.js), nothing while photos are waiting to be built (photos
// come first; the queues take turns). Clips and mosaics go before web
// copies, except that one web copy at a time does not wait for them: with
// thousands of videos the sheets alone would keep the budget busy for
// hours, and a folder whose atlas is ready would show no playable video.
class VideoQueue {
  constructor() {
    this.waiting = [];   // { priority, owner, kind, run, resolve, reject }
    this.running = [];   // the same, while running
    onCpuFree(() => this.kick());
  }
  // Run fn when its share of the budget is free. kind ('clips', 'sheet',
  // 'web') sets the share and the status counts. Rejects with
  // { cancelled: true } if dropped by cancel().
  add(priority, owner, kind, fn) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ priority, owner, kind, run: fn, resolve, reject });
      this.kick();
    });
  }
  kick() {
    while (this.waiting.length && !buildQueue.queue.length) {
      // If the next job's share is not free, nothing behind it starts (it
      // would never get it).
      const job = this.next();
      if (!job) return;
      const units = UNITS[job.kind];
      if (!tryTakeCpu(units)) return;
      this.waiting.splice(this.waiting.indexOf(job), 1);
      this.running.push(job);
      Promise.resolve().then(() => job.run(units)).then(job.resolve, job.reject).finally(() => {
        this.running.splice(this.running.indexOf(job), 1);
        giveBackCpu(units);
      });
    }
  }
  // The job that goes next: a web copy when none runs (WEB_BESIDE_SHEET),
  // else a first-frame still when none runs (a second's work that the
  // photo view shows before its video plays), else a storyboard when none
  // runs (it is a minute's work that makes the seek bar good, so it does
  // not wait hours for a big folder's previews; their web copy is made, or
  // they would not be queued), else the first clips or sheet job (a sheet
  // only while fewer than SHEETS_AT_ONCE run, for memory), else the first
  // web copy, first-frame still or storyboard.
  next() {
    const running = kind => this.running.filter(job => job.kind === kind).length;
    const web = this.waiting.find(job => job.kind === 'web');
    if (web && WEB_BESIDE_SHEET && !running('web')) return web;
    const firstFrame = this.waiting.find(job => job.kind === 'firstFrame');
    if (firstFrame && WEB_BESIDE_SHEET && !running('firstFrame')) return firstFrame;
    const storyboard = this.waiting.find(job => job.kind === 'storyboard');
    if (storyboard && WEB_BESIDE_SHEET && !running('storyboard')) return storyboard;
    const sheetsAllowed = running('sheet') < SHEETS_AT_ONCE;
    const preview = this.waiting.find(job => job.priority === PRIORITY_PREVIEW && (job.kind !== 'sheet' || sheetsAllowed));
    return preview || web || firstFrame || storyboard || null;
  }
  cancel(owner) {
    const dropped = this.waiting.filter(job => job.owner === owner);
    this.waiting = this.waiting.filter(job => job.owner !== owner);
    for (const job of dropped) job.reject(Object.assign(new Error('cancelled'), { cancelled: true }));
  }
  count(owner, kind) {
    const matches = job => job.owner === owner && job.kind === kind;
    return this.waiting.filter(matches).length + this.running.filter(matches).length;
  }
  // Jobs queued or running in all folders, by kind.
  totals() {
    const totals = { clips: 0, sheets: 0, web: 0, storyboards: 0, firstFrames: 0 };
    const key = { clips: 'clips', sheet: 'sheets', web: 'web', storyboard: 'storyboards', firstFrame: 'firstFrames' };
    for (const job of [...this.waiting, ...this.running]) totals[key[job.kind]]++;
    return totals;
  }
}

const queue = new VideoQueue();

// Temp files and building directories being written now; the sweeps spare them.
const tempsInUse = new Set();
function trackTemp(file, active) { if (active) tempsInUse.add(file); else tempsInUse.delete(file); }

// ---------- one folder ----------

const stages = new Map();        // galleryAbs -> promise of the running stage
const stageAgain = new Set();    // galleryAbs asked for again while running
const webJobs = new Map();       // galleryAbs + '\0' + name -> promise
const storyboardJobs = new Map(); // the same, for storyboards
const firstFrameJobs = new Map(); // the same, for first-frame stills
const stopped = new Set();       // galleryAbs whose work is being stopped
const lastProblems = new Map();  // galleryAbs -> the last thing that went wrong, for the admin

// Make what the folder's videos still need. Cheap when nothing is missing:
// a manifest and record read and a few stats. Called after every rebuild
// check of a folder (rebuild.js), so startup and every change come here.
export function scheduleVideoStage(galleryAbs) {
  if (stopped.has(galleryAbs)) return;
  if (stages.has(galleryAbs)) { stageAgain.add(galleryAbs); return; }
  const run = runStage(galleryAbs)
    .catch(e => {
      if (e && e.cancelled) return;
      lastProblems.set(galleryAbs, e.message);
      console.warn('[video]', logText(galleryAbs), e.message);
      // The atlas (or the folder's record) could not be made: try again in
      // a while rather than only at the next change or start, as most
      // causes (a busy machine, a full disk) pass.
      retryStageLater(galleryAbs, STAGE_RETRY_MS);
    })
    .finally(() => {
      stages.delete(galleryAbs);
      if (stageAgain.delete(galleryAbs)) scheduleVideoStage(galleryAbs);
    });
  stages.set(galleryAbs, run);
}

async function runStage(galleryAbs) {
  const thumbDir = path.join(galleryAbs, GG_DIR);
  const manifest = await loadManifest(galleryAbs);
  if (!manifest) return;
  const record = (await readVideoRecord(galleryAbs)) || {};
  // Videos, and the GIFs whose probe found them animated (videos.js).
  const videoNames = manifest.images.filter(name => isVideoItem(name, record[name]));
  const hadVideoWork = videoNames.length > 0 || Object.keys(record).length > 0 || manifest.videoAtlasDir;
  if (!hadVideoWork) return;
  await sweepVideoTemps(thumbDir, tempsInUse);
  await sweepRecordTemp(galleryAbs);
  await sweepOrphanVideoFiles(thumbDir, videoNames,
    name => record[name] && record[name].info ? videoTierHeights(record[name].info) : VIDEO_TIERS);
  const playable = videoNames.filter(name => record[name] && record[name].info);

  // 1. web copies (and the storyboards and first-frame stills of those
  // there are), queued and not waited for. First, as they need nothing of
  // the previews: a web copy runs beside the preview work
  // (VideoQueue.next), so opening a video plays and seeks well long before
  // a big folder's mosaics are made, and this folder's do not wait behind
  // another folder's thousands of clips. A folder made before first-frame
  // stills existed gets them here, from the web copies it has, and nothing
  // else is made again.
  for (const name of playable) {
    const entry = record[name];
    if (!entry || !entry.info || !retryDueNow(galleryAbs, entry, 'web')) continue;
    if (webCopyIsCurrent(entry) && !(await allExist([path.join(thumbDir, webCopyName(name))]))) await forgetLostWebCopy(galleryAbs, name);
    else if (webCopyIsCurrent(entry)) {
      queueStoryboardIfDue(galleryAbs, name, entry);
      if (firstFrameIsCurrent(entry) && !(await allExist([path.join(thumbDir, firstFrameName(name))]))) {
        await forgetLostFirstFrame(galleryAbs, name);
      }
      queueFirstFrameIfDue(galleryAbs, name, entry);
      continue;
    }
    queueWebCopy(galleryAbs, name, entry);
  }
  // Stills recorded but not yet in the manifest (the server stopped before
  // committing them) are committed now.
  await commitFirstFrames(galleryAbs);

  // 2. preview clips (also those the record has but gg/ lost)
  // Only the tiers that are missing are made (a tier added to VIDEO_TIERS
  // costs one more pass over each video, not all tiers again).
  const needClips = [];
  for (const name of playable) {
    if (!retryDueNow(galleryAbs, record[name], 'clips')) continue;
    // Only the tiers the video has a tile in: none taller than itself.
    const tiers = videoTierHeights(record[name].info);
    const missing = new Set(missingClipTiers(record[name], tiers));
    for (const h of tiers) if (!(await allExist([clipPath(thumbDir, name, h)]))) missing.add(h);
    if (missing.size) needClips.push({ name, tiers: tiers.filter(h => missing.has(h)) });
  }
  if (needClips.length) {
    const started = Date.now();
    await Promise.all(needClips.map(({ name, tiers }) =>
      queue.add(PRIORITY_PREVIEW, galleryAbs, 'clips', () => makeClips(galleryAbs, name, record[name], tiers))));
    console.log(`[video] ${logText(galleryAbs)}: preview clips of ${needClips.length} videos in ${seconds(started)} s`);
  }

  // 3. the atlas
  await updateAtlas(galleryAbs, thumbDir, videoNames);
}

async function allExist(files) {
  for (const file of files) {
    try { await fsp.access(file); } catch { return false; }
  }
  return true;
}

// A web copy the record has but gg/ lost (deleted by hand): the manifest
// stops naming it at once, and it is made again.
async function forgetLostWebCopy(galleryAbs, name) {
  await changeVideoRecord(galleryAbs, record => { if (record[name]) delete record[name].web; });
  await updateManifest(galleryAbs, manifest => {
    const video = manifest.videos && manifest.videos[name];
    if (!video || (video.web === null && !video.storyboard && !video.firstFrame)) return null;
    return { ...manifest, videos: { ...manifest.videos, [name]: { ...video, web: null, webVersion: null, storyboard: null, firstFrame: null } } };
  });
}

// A first-frame still the record has but gg/ lost: made again (the
// manifest stops naming it at the next commit of stills).
async function forgetLostFirstFrame(galleryAbs, name) {
  await changeVideoRecord(galleryAbs, record => { if (record[name]) delete record[name].firstFrame; });
}

function seconds(since) { return ((Date.now() - since) / 1000).toFixed(1); }

const retryTimers = new Map();  // galleryAbs -> { at, timer }: the next try of failed work
const STAGE_RETRY_MS = 2 * VIDEO_RETRY_SECONDS * 1000;
function retryStageLater(galleryAbs, delayMs) {
  const at = Date.now() + delayMs;
  const pending = retryTimers.get(galleryAbs);
  if (pending && pending.at <= at) return;
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => { retryTimers.delete(galleryAbs); scheduleVideoStage(galleryAbs); }, delayMs);
  timer.unref();
  retryTimers.set(galleryAbs, { at, timer });
}

// May failed work be tried now? A transient failure (videos.js) not due yet
// sets a timer that runs the stage again when it is, so nothing waits for
// a page view or a rescan to be retried.
function retryDueNow(galleryAbs, entry, field) {
  const at = failureRetryAt(entry, field);
  if (at <= Date.now()) return true;
  if (at !== Infinity) retryStageLater(galleryAbs, at - Date.now() + 1000);
  return false;
}

// The video is still the file the work started from?
async function sourceUnchanged(galleryAbs, name, signature) {
  const now = await currentSignatures(galleryAbs, [name]);
  return now[name] === signature;
}

async function makeClips(galleryAbs, name, entry, tiers) {
  const thumbDir = path.join(galleryAbs, GG_DIR);
  const outputs = tiers.map(tierHeight => {
    const size = tileSize(entry.info, tierHeight, SHEET_MAX_WIDTH - 2 * TILE_SKIRT);
    const finalPath = clipPath(thumbDir, name, tierHeight);
    return { tierHeight, width: size.width, height: size.height, finalPath, path: videoTempPath(finalPath) };
  });
  for (const output of outputs) trackTemp(output.path, true);
  try {
    await encodePreviewClips(path.join(galleryAbs, name), entry.info, outputs, galleryAbs);
    if (!(await sourceUnchanged(galleryAbs, name, entry.signature))) return;
    // Each clip appears complete or not at all (durable.js), and only then
    // does the record say it is made.
    for (const output of outputs) await publish(output.path, output.finalPath);
    await changeVideoRecord(galleryAbs, record => {
      const current = record[name];
      if (current && current.signature === entry.signature) {
        recordClipTiers(current, tiers);
        clearFailure(current, 'clips');
      }
    });
  } catch (e) {
    if (e.kind === 'stopped') throw Object.assign(e, { cancelled: true });
    console.warn('[video:clips]', logText(name), 'in', logText(galleryAbs), e.message.split('\n')[0]);
    await changeVideoRecord(galleryAbs, record => {
      if (record[name] && record[name].signature === entry.signature) recordFailure(record[name], 'clips', e);
    });
  } finally {
    for (const output of outputs) {
      trackTemp(output.path, false);
      await fsp.unlink(output.path).catch(() => {});
    }
  }
}

// Build a new atlas when the set of videos with clips differs from what the
// committed atlas was made from, then commit it and sweep the old ones.
async function updateAtlas(galleryAbs, thumbDir, videoNames) {
  const record = (await readVideoRecord(galleryAbs)) || {};
  const names = videoNames.filter(name => record[name] && record[name].info && clipsAreCurrent(record[name], videoTierHeights(record[name].info)));
  const manifest = await loadManifest(galleryAbs);
  if (!manifest) return;
  const committed = manifest.videoAtlasDir || null;
  const committedInputs = committed ? await readAtlasInputs(thumbDir, committed) : null;
  // The atlas is made again when the videos in it changed, or when it was
  // made under other settings or rules (ATLAS_RULE: tiers, length, frame
  // rate, sheet limits, encoding); its clips and sheets are reused where
  // they still apply, the web copies and posters are not touched.
  if (committedInputs && committedInputs.rule === ATLAS_RULE && atlasShows(committedInputs, names, record)) {
    await sweepStaleVideoAtlases(thumbDir, [committed, ...(await keptPreviousAtlas(thumbDir, committed, record))], tempsInUse);
    return;
  }
  // No clips yet (an upgrade remaking them all, or every one failing for a
  // while): the committed atlas, if any, stays; it is replaced once there
  // is something to replace it with.
  if (names.length === 0 && committed && videoNames.some(name => record[name] && record[name].info)) return;
  // Videos left out only until their clips are tried again make this atlas
  // incomplete (see bakeVideoAtlas).
  const complete = videoNames.every(name => names.includes(name) || !record[name] || !record[name].info ||
    failureRetryAt(record[name], 'clips') === Infinity);
  // A finished atlas of exactly these videos may already be there: the
  // server died between finishing it and committing it.
  let dir = names.length > 0
    ? await finishedAtlasMatching(thumbDir, committed, inputs => atlasShows(inputs, names, record) && !inputs.incomplete === complete)
    : null;
  if (dir) console.log(`[video] ${logText(galleryAbs)}: video atlas ${dir}, finished before a restart, committed`);
  if (names.length > 0 && !dir) {
    const started = Date.now();
    const sheets = { encoded: 0, reused: 0 };
    dir = await bakeVideoAtlas({
      galleryAbs,
      names,
      infos: names.map(name => record[name].info),
      sourceSignatures: names.map(name => record[name].signature),
      previousLayout: await previousLayoutIn(thumbDir, committed),
      complete,
      runSheetJob: (fn) => queue.add(PRIORITY_PREVIEW, galleryAbs, 'sheet', fn),
      trackTemp,
      owner: galleryAbs,
      sheets,
    });
    console.log(`[video] ${logText(galleryAbs)}: video atlas of ${names.length} videos in ${seconds(started)} s ` +
      `(${sheets.encoded} sheets encoded, ${sheets.reused} reused)`);
  }
  if (dir) await testPause('published');
  const committedNow = await commitAtlas(galleryAbs, dir, names, record);
  if (!committedNow) {
    // The folder changed while the atlas was built; the stage runs again.
    if (dir) await fsp.rm(path.join(thumbDir, dir), { recursive: true, force: true }).catch(() => {});
    return;
  }
  lastProblems.delete(galleryAbs);
  const previous = committed && previousAtlasMayStay(committedInputs, record) ? [committed] : [];
  await sweepStaleVideoAtlases(thumbDir, [dir, ...previous].filter(Boolean), tempsInUse);
}

// Does an atlas made from these inputs show exactly these videos, as they are?
function atlasShows(inputs, names, record) {
  const shown = Object.keys(inputs.sources);
  return shown.length === names.length &&
    names.every(name => inputs.sources[name] === record[name].signature);
}

// The atlas before the committed one stays while a page opened before the
// commit may still play it, unless it shows a video that is gone or was
// replaced: atlases are public, and would keep that video public.
function previousAtlasMayStay(inputs, record) {
  if (!inputs) return false;
  return Object.entries(inputs.sources).every(([name, signature]) => record[name] && record[name].signature === signature);
}
async function keptPreviousAtlas(thumbDir, committed, record) {
  let entries;
  try { entries = await fsp.readdir(thumbDir); } catch { return []; }
  const kept = [];
  for (const name of entries) {
    if (name === committed || !/^video_[a-f0-9]+$/.test(name)) continue;
    if (previousAtlasMayStay(await readAtlasInputs(thumbDir, name), record)) kept.push(name);
  }
  // Only one previous atlas is kept: the newest by time.
  if (kept.length <= 1) return kept;
  const times = await Promise.all(kept.map(name => fsp.stat(path.join(thumbDir, name)).then(s => s.mtimeMs, () => 0)));
  return [kept[times.indexOf(Math.max(...times))]];
}

// Point the manifest at the new atlas, if the folder's videos are still the
// ones it was made from (same names, same files).
async function commitAtlas(galleryAbs, dir, names, recordAtStart) {
  return updateManifest(galleryAbs, async manifest => {
    const record = (await readVideoRecord(galleryAbs)) || {};
    const stillShown = names.every(name => manifest.images.includes(name) && record[name] &&
      record[name].signature === recordAtStart[name].signature && clipsAreCurrent(record[name], videoTierHeights(record[name].info)));
    if (!stillShown) return null;
    if ((manifest.videoAtlasDir || null) === dir) return manifest;
    return { ...manifest, videoAtlasDir: dir };
  });
}

function queueWebCopy(galleryAbs, name, entry) {
  const key = galleryAbs + '\0' + name;
  if (webJobs.has(key)) return;
  const job = queue.add(PRIORITY_WEB, galleryAbs, 'web', () => makeWebCopy(galleryAbs, name, entry))
    .catch(e => { if (!e.cancelled) console.warn('[video:web]', logText(name), e.message); })
    .finally(() => webJobs.delete(key));
  webJobs.set(key, job);
}

// 4. storyboards (storyboard.js), from the web copy, after every web copy.
function queueStoryboardIfDue(galleryAbs, name, entry) {
  if (!wantsStoryboard(entry.info) || storyboardIsCurrent(entry) || !retryDueNow(galleryAbs, entry, 'storyboard')) return;
  const key = galleryAbs + '\0' + name;
  if (storyboardJobs.has(key)) return;
  const job = queue.add(PRIORITY_STORYBOARD, galleryAbs, 'storyboard', () => makeStoryboardOf(galleryAbs, name, entry))
    .catch(e => { if (!e.cancelled) console.warn('[video:storyboard]', logText(name), e.message); })
    .finally(() => storyboardJobs.delete(key));
  storyboardJobs.set(key, job);
}

async function makeStoryboardOf(galleryAbs, name, entry) {
  const thumbDir = path.join(galleryAbs, GG_DIR);
  const now = (await readVideoRecord(galleryAbs)) || {};
  const current = now[name];
  if (!current || current.signature !== entry.signature || !webCopyIsCurrent(current) || storyboardIsCurrent(current)) return;
  const started = Date.now();
  try {
    const plan = await makeStoryboard(thumbDir, name, current.info, galleryAbs, trackTemp);
    if (!(await sourceUnchanged(galleryAbs, name, entry.signature))) return;
    console.log(`[video:storyboard] ${logText(name)}: ${plan.count} frames every ${plan.interval} s in ${plan.sheets} sheets, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    await changeVideoRecord(galleryAbs, record => {
      const latest = record[name];
      // Only if the web copy is still the one the frames came from.
      if (latest && latest.signature === entry.signature && storyboardMadeFor(latest) === storyboardMadeFor(current)) {
        latest.storyboard = { made: storyboardMadeFor(current), madeAt: Date.now(), ...plan };
        clearFailure(latest, 'storyboard');
      }
    });
    await updateManifest(galleryAbs, async manifest => {
      const video = manifest.videos && manifest.videos[name];
      if (!video) return null;
      const record = (await readVideoRecord(galleryAbs)) || {};
      const storyboard = manifestStoryboard(name, record[name]);
      if (!storyboard) return null;
      return { ...manifest, videos: { ...manifest.videos, [name]: { ...video, storyboard } } };
    });
  } catch (e) {
    if (e.kind === 'stopped') throw Object.assign(e, { cancelled: true });
    console.warn('[video:storyboard]', logText(name), 'in', logText(galleryAbs), e.message.split('\n')[0]);
    await changeVideoRecord(galleryAbs, record => {
      if (record[name] && record[name].signature === entry.signature) recordFailure(record[name], 'storyboard', e);
    });
  }
}

// 5. first-frame stills (first_frame.js), from the web copy.
function queueFirstFrameIfDue(galleryAbs, name, entry) {
  if (firstFrameIsCurrent(entry) || !retryDueNow(galleryAbs, entry, 'firstFrame')) return;
  const key = galleryAbs + '\0' + name;
  if (firstFrameJobs.has(key)) return;
  const job = queue.add(PRIORITY_FIRST_FRAME, galleryAbs, 'firstFrame', () => makeFirstFrameOf(galleryAbs, name, entry))
    .catch(e => { if (!e.cancelled) console.warn('[video:first-frame]', logText(name), e.message); })
    .finally(() => firstFrameJobs.delete(key));
  firstFrameJobs.set(key, job);
}

async function makeFirstFrameOf(galleryAbs, name, entry) {
  const thumbDir = path.join(galleryAbs, GG_DIR);
  const now = (await readVideoRecord(galleryAbs)) || {};
  const current = now[name];
  if (!current || current.signature !== entry.signature || !webCopyIsCurrent(current) || firstFrameIsCurrent(current)) return;
  const madeFor = firstFrameMadeFor(current);
  try {
    await makeFirstFrame(thumbDir, name, galleryAbs, trackTemp);
    if (!(await sourceUnchanged(galleryAbs, name, entry.signature))) return;
    await changeVideoRecord(galleryAbs, record => {
      const latest = record[name];
      // Only if the web copy is still the one the picture came from.
      if (latest && latest.signature === entry.signature && firstFrameMadeFor(latest) === madeFor) {
        latest.firstFrame = { made: madeFor, madeAt: Date.now() };
        clearFailure(latest, 'firstFrame');
      }
    });
    commitFirstFramesSoon(galleryAbs);
  } catch (e) {
    if (e.kind === 'stopped') throw Object.assign(e, { cancelled: true });
    console.warn('[video:first-frame]', logText(name), 'in', logText(galleryAbs), e.message.split('\n')[0]);
    await changeVideoRecord(galleryAbs, record => {
      if (record[name] && record[name].signature === entry.signature) recordFailure(record[name], 'firstFrame', e);
    });
  }
}

// Stills are committed to the manifest together, at most every
// FIRST_FRAME_COMMIT_MS: a folder of 10,000 videos getting its stills
// makes several a second, and writing its manifest (megabytes) after each
// would take the server's time from page views.
const FIRST_FRAME_COMMIT_MS = 2000;
const firstFrameCommits = new Map();  // galleryAbs -> timer of the next commit
function commitFirstFramesSoon(galleryAbs) {
  if (firstFrameCommits.has(galleryAbs)) return;
  const timer = setTimeout(() => {
    commitFirstFrames(galleryAbs)
      .catch(e => console.warn('[video:first-frame]', logText(galleryAbs), 'not committed:', e.message))
      .finally(() => firstFrameCommits.delete(galleryAbs));
  }, FIRST_FRAME_COMMIT_MS);
  firstFrameCommits.set(galleryAbs, timer);
}

// Make the manifest name the stills the record has, and no others.
async function commitFirstFrames(galleryAbs) {
  let committed = 0;
  await updateManifest(galleryAbs, async manifest => {
    const record = (await readVideoRecord(galleryAbs)) || {};
    const videos = { ...(manifest.videos || {}) };
    committed = 0;
    for (const [name, video] of Object.entries(videos)) {
      const firstFrame = manifestFirstFrame(name, record[name]);
      if (sameManifestFirstFrame(video.firstFrame, firstFrame)) continue;
      videos[name] = { ...video, firstFrame };
      committed++;
    }
    return committed ? { ...manifest, videos } : null;
  });
  if (committed) console.log(`[video:first-frame] ${logText(galleryAbs)}: ${committed} first-frame stills committed`);
}

async function makeWebCopy(galleryAbs, name, entry) {
  const thumbDir = path.join(galleryAbs, GG_DIR);
  const finalPath = path.join(thumbDir, webCopyName(name));
  const temp = videoTempPath(finalPath);
  // The record may have moved on since this job was queued.
  const now = (await readVideoRecord(galleryAbs)) || {};
  if (!now[name] || now[name].signature !== entry.signature || webCopyIsCurrent(now[name])) return;
  trackTemp(temp, true);
  const started = Date.now();
  try {
    const how = await encodeWebCopy(path.join(galleryAbs, name), entry.info, temp, galleryAbs);
    if (!(await sourceUnchanged(galleryAbs, name, entry.signature))) return;
    await publish(temp, finalPath);
    console.log(`[video:web] ${logText(name)} ${how} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    await changeVideoRecord(galleryAbs, record => {
      const current = record[name];
      if (current && current.signature === entry.signature) {
        current.web = entry.signature + '|' + WEB_RULE;
        // Which copy this is, for its storyboard (storyboard.js).
        current.webMadeAt = Date.now();
        clearFailure(current, 'web');
      }
    });
    queueStoryboardIfDue(galleryAbs, name, { ...entry, web: entry.signature + '|' + WEB_RULE });
    queueFirstFrameIfDue(galleryAbs, name, { ...entry, web: entry.signature + '|' + WEB_RULE });
    await updateManifest(galleryAbs, async manifest => {
      const video = manifest.videos && manifest.videos[name];
      if (!video) return null;
      const record = (await readVideoRecord(galleryAbs)) || {};
      if (!webCopyIsCurrent(record[name])) return null;
      // A copy made again has the same name and a new version. The
      // storyboard and the first-frame still of the copy before are out of
      // date until made again.
      return { ...manifest, videos: { ...manifest.videos, [name]: { ...video, web: webCopyName(name),
        webVersion: webCopyVersion(record[name]), storyboard: manifestStoryboard(name, record[name]),
        firstFrame: manifestFirstFrame(name, record[name]) } } };
    });
  } catch (e) {
    if (e.kind === 'stopped') throw Object.assign(e, { cancelled: true });
    console.warn('[video:web]', logText(name), 'in', logText(galleryAbs), e.message.split('\n')[0]);
    await changeVideoRecord(galleryAbs, record => {
      if (record[name] && record[name].signature === entry.signature) recordFailure(record[name], 'web', e);
    });
  } finally {
    trackTemp(temp, false);
    await fsp.unlink(temp).catch(() => {});
  }
}

// ---------- stopping, status ----------

// Stop all video work of a folder and wait for it to end (a rebuild from
// scratch is about to delete gg/). Queued work is dropped, running ffmpeg
// processes are killed. New work is refused until resumeVideoWork.
export async function stopVideoWork(galleryAbs) {
  stopped.add(galleryAbs);
  stageAgain.delete(galleryAbs);
  queue.cancel(galleryAbs);
  stopFfmpegOf(galleryAbs);
  await stopMosaicWorkers(galleryAbs);
  const prefix = galleryAbs + '\0';
  const pending = [stages.get(galleryAbs), ...[...webJobs, ...storyboardJobs, ...firstFrameJobs]
    .filter(([key]) => key.startsWith(prefix)).map(([, job]) => job)];
  await Promise.all(pending.filter(Boolean).map(p => p.catch(() => {})));
}
export function resumeVideoWork(galleryAbs) {
  stopped.delete(galleryAbs);
}

// For ?build-status and the admin panel: the folder's video work.
//   building          the stage is running or video work of the folder is queued
//   clipsRemaining    videos whose preview clips are queued or being made
//   sheetsRemaining   mosaics queued or being encoded
//   webRemaining      web copies queued or being encoded
//   storyboardsRemaining  storyboards queued or being made
//   firstFramesRemaining  first-frame stills queued or being made (building
//                     stays true until the made ones are committed)
//   atlasReady        the committed manifest names a video atlas
//   webReady/videos   web copies committed / videos ffmpeg can read
export async function videoStatusFor(galleryAbs) {
  const manifest = await loadManifest(galleryAbs);
  const videos = (manifest && manifest.videos) || {};
  const names = Object.keys(videos);
  const clipsRemaining = queue.count(galleryAbs, 'clips');
  const sheetsRemaining = queue.count(galleryAbs, 'sheet');
  const webRemaining = queue.count(galleryAbs, 'web');
  const storyboardsRemaining = queue.count(galleryAbs, 'storyboard');
  const firstFramesRemaining = queue.count(galleryAbs, 'firstFrame');
  return {
    building: stages.has(galleryAbs) || firstFrameCommits.has(galleryAbs) ||
      clipsRemaining + sheetsRemaining + webRemaining + storyboardsRemaining + firstFramesRemaining > 0,
    clipsRemaining,
    sheetsRemaining,
    webRemaining,
    storyboardsRemaining,
    firstFramesRemaining,
    atlasReady: !!(manifest && manifest.videoAtlasDir),
    videos: names.length,
    webReady: names.filter(name => videos[name].web).length,
    problem: lastProblems.get(galleryAbs) || null,
  };
}

// Video work of all folders that is queued or running, for the admin
// panel's status bar (GET /api/admin/queue, field video): { clips,
// sheets, web, storyboards, firstFrames } (videos waiting for preview
// clips, mosaic sheets, web copies, storyboards, first-frame stills).
export function videoQueueTotals() { return queue.totals(); }
