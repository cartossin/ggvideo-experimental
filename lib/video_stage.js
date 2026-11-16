// The moving half of a folder's videos, made after the folder is committed.
//
// A folder becomes browsable as soon as its stills are built: a video's
// poster is a still (videos.js, build.js), so the grid shows it at once.
// Then, for each folder with videos, this stage makes, in this order:
//   1. each video's preview clips (one ffmpeg per video, all tiers at once)
//   2. the video atlas (video_atlas.js), committed as manifest.videoAtlasDir
//   3. each video's web copy, committed as manifest.videos[name].web
// All ffmpeg work of all folders shares one queue of VIDEO_BUILD_CONCURRENCY
// lanes. Clips and mosaics go first; web copies (the slowest by far) never
// take the last free lane, so a new folder's previews do not wait for hours
// of web copies elsewhere.
//
// The stage runs once per folder at a time, and again after it ends if it
// was asked for meanwhile. Web copies are queued by it but not waited for,
// so a folder that changes while its web copies encode gets its new
// previews without waiting for them. Each result is committed only if its
// video is still in the folder as it was when the work started; a video
// replaced meanwhile is done again.

import fsp from 'fs/promises';
import path from 'path';
import { GG_DIR, VIDEO_BUILD_CONCURRENCY, VIDEO_TIERS, isVideo } from './config.js';
import { stopFfmpegOf } from './ffmpeg.js';
import { logText } from './http.js';
import { loadManifest, updateManifest } from './manifest.js';
import { currentSignatures } from './sources.js';
import {
  ATLAS_RULE,
  SHEET_MAX_WIDTH,
  bakeVideoAtlas,
  stopMosaicWorkers,
  readAtlasInputs,
  sweepStaleVideoAtlases,
} from './video_atlas.js';
import {
  TILE_SKIRT,
  WEB_RULE,
  changeVideoRecord,
  clipPath,
  clipsAreCurrent,
  missingClipTiers,
  recordClipTiers,
  encodePreviewClips,
  encodeWebCopy,
  readVideoRecord,
  sweepOrphanVideoFiles,
  sweepVideoTemps,
  tileSize,
  videoTempPath,
  webCopyIsCurrent,
  webCopyName,
} from './videos.js';

// ---------- the queue ----------

const PRIORITY_PREVIEW = 0;  // clips and mosaics
const PRIORITY_WEB = 1;      // web copies

class VideoQueue {
  constructor(lanes) {
    this.lanes = lanes;
    this.waiting = [];   // { priority, owner, kind, run, resolve, reject }
    this.running = [];   // the same, while running
  }
  // Run fn when a lane is free. kind ('clips', 'sheet', 'web') is for the
  // status counts. Rejects with { cancelled: true } if dropped by cancel().
  add(priority, owner, kind, fn) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ priority, owner, kind, run: fn, resolve, reject });
      this.kick();
    });
  }
  // Web copies may use every lane but one when there is more than one.
  lanesFor(priority) {
    return priority === PRIORITY_WEB && this.lanes > 1 ? this.lanes - 1 : this.lanes;
  }
  kick() {
    while (this.running.length < this.lanes) {
      const job = this.nextRunnable();
      if (!job) return;
      this.waiting.splice(this.waiting.indexOf(job), 1);
      this.running.push(job);
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        this.running.splice(this.running.indexOf(job), 1);
        this.kick();
      });
    }
  }
  nextRunnable() {
    const webRunning = this.running.filter(job => job.priority === PRIORITY_WEB).length;
    for (const priority of [PRIORITY_PREVIEW, PRIORITY_WEB]) {
      if (priority === PRIORITY_WEB && webRunning >= this.lanesFor(PRIORITY_WEB)) continue;
      const job = this.waiting.find(candidate => candidate.priority === priority);
      if (job) return job;
    }
    return null;
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
  totalRemaining() { return this.waiting.length + this.running.length; }
}

const queue = new VideoQueue(VIDEO_BUILD_CONCURRENCY);

// Temp files and building directories being written now; the sweeps spare them.
const tempsInUse = new Set();
function trackTemp(file, active) { if (active) tempsInUse.add(file); else tempsInUse.delete(file); }

// ---------- one folder ----------

const stages = new Map();        // galleryAbs -> promise of the running stage
const stageAgain = new Set();    // galleryAbs asked for again while running
const webJobs = new Map();       // galleryAbs + '\0' + name -> promise
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
  const videoNames = manifest.images.filter(isVideo);
  const hadVideoWork = videoNames.length > 0 || Object.keys(record).length > 0 || manifest.videoAtlasDir;
  if (!hadVideoWork) return;
  await sweepVideoTemps(thumbDir, tempsInUse);
  await sweepOrphanVideoFiles(thumbDir, videoNames);
  const playable = videoNames.filter(name => record[name] && record[name].info);

  // 1. preview clips (also those the record has but gg/ lost)
  // Only the tiers that are missing are made (a tier added to VIDEO_TIERS
  // costs one more pass over each video, not all tiers again).
  const needClips = [];
  for (const name of playable) {
    if (record[name].clipsError) continue;
    const missing = new Set(missingClipTiers(record[name]));
    for (const h of VIDEO_TIERS) if (!(await allExist([clipPath(thumbDir, name, h)]))) missing.add(h);
    if (missing.size) needClips.push({ name, tiers: VIDEO_TIERS.filter(h => missing.has(h)) });
  }
  if (needClips.length) {
    const started = Date.now();
    await Promise.all(needClips.map(({ name, tiers }) =>
      queue.add(PRIORITY_PREVIEW, galleryAbs, 'clips', () => makeClips(galleryAbs, name, record[name], tiers))));
    console.log(`[video] ${logText(galleryAbs)}: preview clips of ${needClips.length} videos in ${seconds(started)} s`);
  }

  // 2. the atlas
  await updateAtlas(galleryAbs, thumbDir, videoNames);

  // 3. web copies, queued and not waited for
  const latest = (await readVideoRecord(galleryAbs)) || {};
  for (const name of playable) {
    const entry = latest[name];
    if (!entry || !entry.info || entry.webError) continue;
    if (webCopyIsCurrent(entry) && !(await allExist([path.join(thumbDir, webCopyName(name))]))) await forgetLostWebCopy(galleryAbs, name);
    else if (webCopyIsCurrent(entry)) continue;
    queueWebCopy(galleryAbs, name, entry);
  }
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
    if (!video || video.web === null) return null;
    return { ...manifest, videos: { ...manifest.videos, [name]: { ...video, web: null } } };
  });
}

function seconds(since) { return ((Date.now() - since) / 1000).toFixed(1); }

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
    for (const output of outputs) await fsp.rename(output.path, output.finalPath);
    await changeVideoRecord(galleryAbs, record => {
      const current = record[name];
      if (current && current.signature === entry.signature) {
        recordClipTiers(current, tiers);
        delete current.clipsError;
      }
    });
  } catch (e) {
    if (e.kind === 'stopped') throw Object.assign(e, { cancelled: true });
    console.warn('[video:clips]', logText(name), 'in', logText(galleryAbs), e.message.split('\n')[0]);
    await changeVideoRecord(galleryAbs, record => {
      if (record[name] && record[name].signature === entry.signature) record[name].clipsError = e.message.split('\n')[0];
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
  const names = videoNames.filter(name => record[name] && record[name].info && clipsAreCurrent(record[name]));
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
  let dir = null;
  if (names.length > 0) {
    const started = Date.now();
    const sheets = { encoded: 0, reused: 0 };
    dir = await bakeVideoAtlas({
      galleryAbs,
      names,
      infos: names.map(name => record[name].info),
      sourceSignatures: names.map(name => record[name].signature),
      runSheetJob: (fn) => queue.add(PRIORITY_PREVIEW, galleryAbs, 'sheet', fn),
      trackTemp,
      owner: galleryAbs,
      sheets,
    });
    console.log(`[video] ${logText(galleryAbs)}: video atlas of ${names.length} videos in ${seconds(started)} s ` +
      `(${sheets.encoded} sheets encoded, ${sheets.reused} reused)`);
  }
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
      record[name].signature === recordAtStart[name].signature && clipsAreCurrent(record[name]));
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
    await fsp.rename(temp, finalPath);
    console.log(`[video:web] ${logText(name)} ${how} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    await changeVideoRecord(galleryAbs, record => {
      const current = record[name];
      if (current && current.signature === entry.signature) {
        current.web = entry.signature + '|' + WEB_RULE;
        delete current.webError;
      }
    });
    await updateManifest(galleryAbs, async manifest => {
      const video = manifest.videos && manifest.videos[name];
      if (!video || video.web === webCopyName(name)) return null;
      const record = (await readVideoRecord(galleryAbs)) || {};
      if (!webCopyIsCurrent(record[name])) return null;
      return { ...manifest, videos: { ...manifest.videos, [name]: { ...video, web: webCopyName(name) } } };
    });
  } catch (e) {
    if (e.kind === 'stopped') throw Object.assign(e, { cancelled: true });
    console.warn('[video:web]', logText(name), 'in', logText(galleryAbs), e.message.split('\n')[0]);
    await changeVideoRecord(galleryAbs, record => {
      if (record[name] && record[name].signature === entry.signature) record[name].webError = e.message.split('\n')[0];
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
  const pending = [stages.get(galleryAbs), ...[...webJobs].filter(([key]) => key.startsWith(prefix)).map(([, job]) => job)];
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
//   atlasReady        the committed manifest names a video atlas
//   webReady/videos   web copies committed / videos ffmpeg can read
export async function videoStatusFor(galleryAbs) {
  const manifest = await loadManifest(galleryAbs);
  const videos = (manifest && manifest.videos) || {};
  const names = Object.keys(videos);
  const clipsRemaining = queue.count(galleryAbs, 'clips');
  const sheetsRemaining = queue.count(galleryAbs, 'sheet');
  const webRemaining = queue.count(galleryAbs, 'web');
  return {
    building: stages.has(galleryAbs) || clipsRemaining + sheetsRemaining + webRemaining > 0,
    clipsRemaining,
    sheetsRemaining,
    webRemaining,
    atlasReady: !!(manifest && manifest.videoAtlasDir),
    videos: names.length,
    webReady: names.filter(name => videos[name].web).length,
    problem: lastProblems.get(galleryAbs) || null,
  };
}

export function videoQueueRemaining() { return queue.totalRemaining(); }
