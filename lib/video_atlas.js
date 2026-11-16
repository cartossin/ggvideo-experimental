// The video atlas: the still atlas's trick applied to moving pictures.
//
// A page cannot play hundreds of <video> elements at once, but it can play
// one mosaic video per tier: decoded once (in hardware), uploaded to a
// WebGL texture each frame, and cut into tiles by texture coordinates. So
// for each folder that has videos, the preview clips of all its videos
// (videos.js) are laid out side by side in mosaics, one set per tier.
//
// ============================== THE CONTRACT ==============================
// What the viewer (public/gallery.js) codes against. Change it only together
// with the viewer, and bump VIDEO_ATLAS_VERSION when its meaning changes.
//
// Files, in the folder's gg/ directory:
//   gg/video_<id>/_video.json              the description below
//   gg/video_<id>/mosaic-h<H>-<N>.mp4      sheet N of the tier of height H
// <id> is random hex, new for every atlas that is built (the files are
// served as immutable). The folder's manifest names the atlas in use as
// manifest.videoAtlasDir ("video_<id>"), or null while there is none (the
// folder has no videos, or its atlas is not built yet). The previous atlas
// is kept until the one after it is committed, unless it shows a video that
// was removed or replaced.
//
// _video.json:
//   {
//     "version": 1,
//     "loopSeconds": 60,          every mosaic lasts exactly this long and
//                                 loops seamlessly (VIDEO_PREVIEW_SECONDS)
//     "fps": 24,                  constant frame rate of every mosaic
//                                 (VIDEO_PREVIEW_FPS); frame f of a mosaic
//                                 is frame f of each preview in it
//     "names": ["a.mp4", ...],    the videos in this atlas, in gallery order.
//                                 A video of the folder that is not listed
//                                 (added since, or ffmpeg could not make its
//                                 preview) has no moving tile: show its poster.
//     "tiers": {
//       "h25":  { "sheets": [...], "tiles": [...] },
//       "h50": { ... }, "h100": { ... }, "h200": { ... }
//                                 one key per VIDEO_TIERS height
//     }
//   }
//   sheets[s] = { "file": "mosaic-h100-0.mp4", "width": W, "height": H }
//     file is relative to the atlas directory; W and H are the pixel size
//     of the mosaic (even, at most 3840x2160).
//   tiles[i] = [sheetIndex, x, y, width, height]
//     (tiles are not in gallery order on the sheets: a video added since the
//     folder was first built sits after the others, see layoutTier)
//     the pixel rectangle of names[i]'s picture in that tier: sheet
//     sheets[sheetIndex], left/top x, y from the sheet's top-left corner,
//     gutter excluded. Every rectangle lies inside its sheet, no two
//     overlap, and width/height is the video's displayed aspect ratio (to
//     even-pixel rounding of the width). The picture is height pixels
//     tall, the tier's height (which may be odd: h25), except for videos
//     wider than 4:1, which are shrunk to 4:1 wide. x, y and width are
//     even; height may be odd. Around every rectangle are TILE_SKIRT (4)
//     pixels (5 below an odd-height one) repeating the
//     tile's own edge pixels, then the neighbour's skirt or black, so
//     sampling at the rectangle's edge never picks up a neighbour.
//
// The mosaics: H.264 High profile, yuv420p, constant frame rate, a keyframe
// every 2 seconds, no audio, MP4 with the index at the front (faststart).
// =========================================================================

import crypto from 'crypto';
import { sheetThreads } from './cpu_budget.js';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Worker } from 'worker_threads';
import {
  FFMPEG_TIMEOUT_SECONDS, GG_DIR, VIDEO_MOSAIC_MEMORY, VIDEO_PREVIEW_FPS, VIDEO_PREVIEW_SECONDS, VIDEO_TIERS,
} from './config.js';
import { publish, testPause, writeFileDurably } from './durable.js';
import { CLIP_RULE, TILE_SKIRT, clipFrameTotal, clipPath, clipSize, tileSize, videoTempPath } from './videos.js';

export const VIDEO_ATLAS_VERSION = 1;
// Hardware video decoders handle 4K (3840x2160) at 30 fps on every desktop
// and phone that has one; larger is not safe to assume.
export const SHEET_MAX_WIDTH = 3840;
export const SHEET_MAX_HEIGHT = 2160;
export const tierKey = tierHeight => 'h' + tierHeight;
export function sheetFileName(tierHeight, sheetIndex) { return `mosaic-${tierKey(tierHeight)}-${sheetIndex}.mp4`; }

const ATLAS_DIR_NAME = /^video_[a-f0-9]+$/;
const BUILDING_DIR_NAME = /^video_[a-f0-9]+_building$/;
export const isVideoAtlasDirName = name => ATLAS_DIR_NAME.test(name);
export function newVideoAtlasDirName() { return 'video_' + crypto.randomBytes(8).toString('hex'); }

// ---------- layout ----------

// Shelf packing: rows of the tier's height plus the skirts, filled left to
// right, as many rows as fit in a 3840x2160 sheet (about 4,600 h25 tiles,
// 1,480 h50, 400 h100, 104 h200 of 16:9 video). Each sheet is only as large
// as its tiles need. A tile shorter than its row (a video wider than 4:1)
// sits in the middle of it.
class ShelfPacker {
  constructor(tierHeight) {
    this.rowHeight = clipSize({ width: 0, height: tierHeight }).height;
    this.rowsPerSheet = Math.max(1, Math.floor(SHEET_MAX_HEIGHT / this.rowHeight));
    this.sheets = [];    // [{ members: [...] }]
    this.sheet = null;
    this.row = 0;
    this.x = 0;
  }
  startSheet() {
    this.sheet = { members: [] };
    this.sheets.push(this.sheet);
    this.row = 0;
    this.x = 0;
  }
  // Go on after the last tile of an existing sheet.
  continueAfter(sheet) {
    this.sheet = sheet;
    let last = null;
    for (const m of sheet.members) {
      if (!last || m.clipY > last.clipY || (m.clipY === last.clipY && m.clipX > last.clipX)) last = m;
    }
    this.row = last ? Math.floor(last.clipY / this.rowHeight) : 0;
    this.x = last ? last.clipX + clipSize(last).width : 0;
  }
  place(index, size) {
    const cell = clipSize(size);
    if (!this.sheet) this.startSheet();
    if (this.x + cell.width > SHEET_MAX_WIDTH) {
      this.row++;
      this.x = 0;
      if (this.row >= this.rowsPerSheet) this.startSheet();
    }
    const member = { index, clipX: this.x, clipY: this.row * this.rowHeight + 2 * Math.floor((this.rowHeight - cell.height) / 4),
      width: size.width, height: size.height };
    this.sheet.members.push(member);
    this.x += cell.width;
  }
}

function tileSizeIn(info, tierHeight) {
  return tileSize(info, tierHeight, SHEET_MAX_WIDTH - 2 * TILE_SKIRT);
}

// The finished layout: each sheet as wide as its tiles and as tall as its
// rows (even, as clips and rows are), tiles indexed like the items.
function finishLayout(packer, count) {
  const tiles = new Array(count);
  const finished = packer.sheets.filter(sheet => sheet.members.length).map((sheet, s) => {
    let width = 0, height = 0;
    for (const m of sheet.members) {
      width = Math.max(width, m.clipX + clipSize(m).width);
      height = Math.max(height, (Math.floor(m.clipY / packer.rowHeight) + 1) * packer.rowHeight);
      tiles[m.index] = [s, m.clipX + TILE_SKIRT, m.clipY + TILE_SKIRT, m.width, m.height];
    }
    return { width, height, members: sheet.members };
  });
  return { sheets: finished, tiles };
}

// Lay out one tier. items: [{ name, info }] in gallery order. previous: the
// committed atlas's tier ({ names, tiles } as in _video.json), when it was
// made under the same rules, or null.
//
// With a previous layout, every video that is still there at the same
// size keeps its place, and new ones are added after the last tile of the
// last sheet. So adding a video changes one sheet per tier (the last), and
// removing one changes only the sheet it was on (its place stays empty):
// every other sheet is the same video and is reused, not encoded again
// (sheetKey). When the holes add up to a whole sheet, packing afresh in
// gallery order needs fewer sheets, and that is done instead.
export function layoutTier(items, tierHeight, previous = null) {
  const fresh = new ShelfPacker(tierHeight);
  items.forEach((item, index) => fresh.place(index, tileSizeIn(item.info, tierHeight)));
  const packed = finishLayout(fresh, items.length);
  if (!previous) return packed;

  const before = new Map(previous.names.map((name, i) => [name, previous.tiles[i]]));
  const stable = new ShelfPacker(tierHeight);
  const kept = new Map();   // previous sheet index -> sheet
  const added = [];
  items.forEach((item, index) => {
    const size = tileSizeIn(item.info, tierHeight);
    const tile = before.get(item.name);
    if (tile && tile[3] === size.width && tile[4] === size.height) {
      if (!kept.has(tile[0])) kept.set(tile[0], { members: [] });
      kept.get(tile[0]).members.push({ index, clipX: tile[1] - TILE_SKIRT, clipY: tile[2] - TILE_SKIRT, width: size.width, height: size.height });
    } else {
      added.push({ index, size });
    }
  });
  stable.sheets = [...kept.keys()].sort((a, b) => a - b).map(s => kept.get(s));
  if (stable.sheets.length) stable.continueAfter(stable.sheets[stable.sheets.length - 1]);
  for (const { index, size } of added) stable.place(index, size);
  const result = finishLayout(stable, items.length);
  return result.sheets.length <= packed.sheets.length ? result : packed;
}

// ---------- encoding one sheet ----------

// Tiles are small and the mosaic loops for ever once loaded, so it is
// encoded once with care for size: CRF 26 with a bitrate ceiling for a full
// 4K sheet, scaled down with the sheet's area. Small tiles hold more detail
// per pixel (a whole picture in 44x25), so the ceiling grows as the tier
// shrinks: 8 Mbit/s at h200, (200/H)^(1/3) times that below (h100 10,
// h50 12.7, h25 16 Mbit/s). Measured on full sheets of real 480p clips:
// h50 uncapped came to 22 Mbit/s, capped at 12 visibly softer only when
// enlarged; h25 at 16 Mbit/s is 121 MB for 4,599 tiles. Keyframes every
// 2 s at exactly the same frames in every mosaic, no scene-cut keyframes.
// 4K at 24 fps needs H.264 level 5.1, which x264 picks from the size, frame
// rate and ceiling (High@5.1 allows up to 300 Mbit/s).
export const MOSAIC_RULE = 'm3:crf26:8000k@h200^(1/3):faster:la10';
const FULL_SHEET_KBPS_AT_H200 = 8000;

// Everything an atlas's layout and encoding depend on besides its videos.
// Recorded in _inputs.json; an atlas made under another rule (older code,
// other VIDEO_TIERS, preview length or frame rate) is made again, reusing
// every sheet whose content key still matches.
export const ATLAS_RULE = JSON.stringify(['a2', VIDEO_TIERS, VIDEO_PREVIEW_SECONDS, VIDEO_PREVIEW_FPS, TILE_SKIRT,
  SHEET_MAX_WIDTH, SHEET_MAX_HEIGHT, MOSAIC_RULE, CLIP_RULE]);

function sheetBitrateKbps(tierHeight, width, height) {
  const fullSheet = FULL_SHEET_KBPS_AT_H200 * Math.cbrt(200 / tierHeight);
  return Math.max(500, Math.round(fullSheet * (width * height) / (SHEET_MAX_WIDTH * SHEET_MAX_HEIGHT)));
}

// Decoder lanes (a compositing thread and a single-threaded decoder each,
// mosaic_lane_worker.js) and x264's threads come from the units of the CPU
// budget the sheet was given and its tile count (cpu_budget.js
// sheetThreads): with 8 units a full h25 sheet gets 5 lanes and 2 encoder
// threads, an h100 sheet 2 lanes and 5.

// Sheets being composed now: worker -> owner (a gallery folder).
const mosaicWorkers = new Map();

// Compose a sheet from its clips in a worker thread (mosaic_worker.js): our
// own code copies tile pixels into sheet frames, one ffmpeg encodes them.
// Two chunks of frames (one being filled, one being encoded) are the only
// large buffers, so a chunk is as many whole seconds as let both fit in
// VIDEO_MOSAIC_MEMORY, and at least one (a full 4K sheet: 2 x 24 frames,
// 600 MB, above the default 512 MiB).
// The sheet is encoded to a temp name and published (durable.js), and a
// sidecar <sheet>.key records its content key: if the server dies before
// the atlas is finished, the next attempt finds the finished sheets in the
// abandoned building directory by their keys and reuses them.
async function encodeSheet(tierHeight, sheet, clips, outPath, key, owner, units) {
  const temp = videoTempPath(outPath);
  await composeSheet(tierHeight, sheet, clips, temp, owner, sheetThreads(units, clips.length));
  await publish(temp, outPath);
  await writeFileDurably(outPath + '.key', key);
}

function composeSheet(tierHeight, sheet, clips, outPath, owner, threads) {
  const fps = VIDEO_PREVIEW_FPS;
  const frameBytes = sheet.width * sheet.height * 3 / 2;
  const totalFrames = VIDEO_PREVIEW_SECONDS * fps;
  const chunkFrames = Math.min(totalFrames, Math.max(fps, Math.floor(VIDEO_MOSAIC_MEMORY / (2 * frameBytes) / fps) * fps));
  const kbps = sheetBitrateKbps(tierHeight, sheet.width, sheet.height);
  const listDir = outPath + '.lanes';
  const encoderArgs = [
    // x264 holds many 4K frames: 8 threads and a 10-frame lookahead measured
    // 1.5 GB (1.75 GB with the preset's 20), at the same speed.
    '-an', '-sn', '-dn', '-c:v', 'libx264', '-threads', String(threads.encoderThreads), '-x264-params', 'rc-lookahead=10',
    '-preset', 'faster', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-crf', '26', '-maxrate', kbps + 'k', '-bufsize', (2 * kbps) + 'k',
    '-g', String(2 * fps), '-keyint_min', String(2 * fps), '-sc_threshold', '0',
    '-map_metadata', '-1', '-movflags', '+faststart', '-f', 'mp4', '-y', 'file:' + outPath,
  ];
  const members = sheet.members.map((member, i) => ({
    clip: clips[i].path, clipX: member.clipX, clipY: member.clipY,
    clipWidth: clipSize(member).width, clipHeight: clipSize(member).height, clipFrames: clips[i].frames,
  }));
  return new Promise((resolve, reject) => {
    fs.mkdirSync(listDir, { recursive: true });
    const worker = new Worker(new URL('./mosaic_worker.js', import.meta.url), { workerData: {
      width: sheet.width, height: sheet.height, fps, seconds: VIDEO_PREVIEW_SECONDS, chunkFrames,
      lanes: threads.lanes, members, listDir, encoderArgs, timeoutMs: FFMPEG_TIMEOUT_SECONDS * 1000,
    } });
    mosaicWorkers.set(worker, owner);
    let settled = false;
    const finish = (error, stats) => {
      if (settled) return;
      settled = true;
      fs.rmSync(listDir, { recursive: true, force: true });
      if (error) reject(error); else resolve(stats);
    };
    worker.on('message', message => finish(message.ok ? null : new Error(message.error), message.stats));
    worker.on('error', error => finish(error));
    worker.on('exit', code => {
      mosaicWorkers.delete(worker);
      if (worker.stoppedByOwner) finish(Object.assign(new Error('stopped'), { kind: 'stopped', cancelled: true }));
      else finish(code === 0 ? null : new Error('mosaic worker exited with code ' + code));
    });
  });
}

// Stop the sheets being composed for one folder (owner), or all of them
// (server shutdown): each worker kills its ffmpeg processes and ends.
export function stopMosaicWorkers(owner = null) {
  const ending = [];
  for (const [worker, workerOwner] of mosaicWorkers) {
    if (owner !== null && workerOwner !== owner) continue;
    worker.stoppedByOwner = true;
    ending.push(new Promise(resolve => worker.once('exit', resolve)));
    worker.postMessage('stop');
  }
  return Promise.all(ending);
}

// ---------- building an atlas ----------

// What a sheet shows, as a key: the rules it was made by, its size, and
// each clip (by its file's size and time) at its position. A sheet of an
// earlier atlas with the same key is the same video, and is reused (hard
// linked) instead of encoded again, so adding a video at the end of a
// folder re-encodes only the last sheet of each tier.
// The tiles are taken in the order of their places on the sheet, not of
// the list they come in: a sheet whose tiles kept their places is the same
// sheet even when other videos were added or removed before them in the
// gallery's order.
function sheetKey(tierHeight, sheet, clipSignatures) {
  const tiles = sheet.members.map(m => [clipSignatures[m.index], m.clipX, m.clipY])
    .sort((a, b) => a[2] - b[2] || a[1] - b[1]);
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify([CLIP_RULE, MOSAIC_RULE, VIDEO_PREVIEW_SECONDS, VIDEO_PREVIEW_FPS, tierHeight,
    sheet.width, sheet.height, tiles]));
  return hash.digest('hex');
}

async function fileSignature(file) {
  const stat = await fsp.stat(file);
  return Math.floor(stat.mtimeMs) + ':' + stat.size;
}

// Build a new atlas for these videos (names in gallery order, infos their
// probe results, sourceSignatures what they were when their clips were
// made), in gg/video_<id>_building/, renamed to gg/video_<id>/ once every
// file is in place. runSheetJob(fn) runs one sheet's encode through the
// video queue. trackTemp(path, active) marks files being written, so the
// temp sweep spares them. previousLayout: the layout of the last atlas made
// under the same ATLAS_RULE (previousLayoutIn), whose tiles keep their
// places (layoutTier). complete: false when videos whose clips are to be
// retried are left out. sheets, if given, gets the counts of sheets encoded
// and reused. Resolves with the directory name.
export async function bakeVideoAtlas({ galleryAbs, names, infos, sourceSignatures, previousLayout = null, complete = true, runSheetJob, trackTemp, owner, sheets: counts = {} }) {
  const thumbDir = path.join(galleryAbs, GG_DIR);
  const dirName = newVideoAtlasDirName();
  const buildingAbs = path.join(thumbDir, dirName + '_building');
  await fsp.mkdir(buildingAbs, { recursive: true });
  trackTemp(buildingAbs, true);
  try {
    const reusable = await reusableSheets(thumbDir);
    const meta = { version: VIDEO_ATLAS_VERSION, loopSeconds: VIDEO_PREVIEW_SECONDS, fps: VIDEO_PREVIEW_FPS, names, tiers: {} };
    // _inputs.json (not served): what the atlas was made from, each sheet's
    // key and videos, and the layout, which the next atlas keeps its tiles'
    // places from (even after this atlas is withdrawn for showing a video
    // that is gone, see sweepVideoAtlasesShowingGoneVideos).
    // incomplete: made while some videos' clips were still to be retried; the
    // atlas after it is packed afresh, so a build that had failures ends in
    // the same layout as one that had none.
    const inputs = { rule: ATLAS_RULE, builtAt: Date.now(), incomplete: !complete, sources: {}, sheets: {}, sheetVideos: {}, layout: { names, tiers: {} } };
    names.forEach((name, i) => { inputs.sources[name] = sourceSignatures[i]; });
    const jobs = [];
    for (const tierHeight of VIDEO_TIERS) {
      const clipPaths = names.map(name => clipPath(thumbDir, name, tierHeight));
      const clipSignatures = await Promise.all(clipPaths.map(fileSignature));
      const previousTiles = previousLayout && previousLayout.tiers[tierKey(tierHeight)];
      const layout = layoutTier(names.map((name, i) => ({ name, info: infos[i] })), tierHeight,
        previousTiles ? { names: previousLayout.names, tiles: previousTiles } : null);
      inputs.layout.tiers[tierKey(tierHeight)] = layout.tiles;
      meta.tiers[tierKey(tierHeight)] = {
        sheets: layout.sheets.map((sheet, s) => ({ file: sheetFileName(tierHeight, s), width: sheet.width, height: sheet.height })),
        tiles: layout.tiles,
      };
      for (const [s, sheet] of layout.sheets.entries()) {
        const file = sheetFileName(tierHeight, s);
        const key = sheetKey(tierHeight, sheet, clipSignatures);
        inputs.sheets[file] = key;
        inputs.sheetVideos[file] = sheet.members.map(m => names[m.index]);
        const outPath = path.join(buildingAbs, file);
        if (reusable.has(key) && await linkOrCopy(reusable.get(key), outPath)) {
          await writeFileDurably(outPath + '.key', key);
          counts.reused = (counts.reused || 0) + 1;
          continue;
        }
        counts.encoded = (counts.encoded || 0) + 1;
        const clips = sheet.members.map(m => ({ path: clipPaths[m.index], frames: clipFrameTotal(infos[m.index]) }));
        jobs.push(runSheetJob(units => encodeSheet(tierHeight, sheet, clips, outPath, key, owner, units), file));
      }
    }
    if (counts.reused) await testPause('linked');
    // Every sheet is waited for, even after one fails.
    const outcomes = await Promise.allSettled(jobs);
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
    await writeJson(path.join(buildingAbs, '_inputs.json'), inputs);
    await writeJson(path.join(buildingAbs, '_video.json'), meta);
    // Only now, with every file complete and on disk, does the atlas get
    // its final name; the manifest is pointed at it after that.
    await publish(buildingAbs, path.join(thumbDir, dirName));
    return dirName;
  } finally {
    // A failed or interrupted building directory stays, so the next
    // attempt reuses its finished sheets; it is swept once an atlas is
    // committed (sweepStaleVideoAtlases).
    trackTemp(buildingAbs, false);
  }
}

function writeJson(file, value) {
  return writeFileDurably(file, JSON.stringify(value));
}

// Sheets in gg/ by their keys: key -> absolute path. From finished atlases
// (their _inputs.json) and from building directories a failed or killed
// attempt left (each finished sheet there has its .key sidecar).
async function reusableSheets(thumbDir) {
  const found = new Map();
  let entries;
  try { entries = await fsp.readdir(thumbDir); } catch { return found; }
  for (const dirName of entries.filter(isVideoAtlasDirName)) {
    const inputs = await readAtlasInputs(thumbDir, dirName);
    if (!inputs) continue;
    for (const [file, key] of Object.entries(inputs.sheets || {})) {
      if (SHEET_FILE_NAME.test(file)) found.set(key, path.join(thumbDir, dirName, file));
    }
  }
  for (const dirName of entries.filter(name => BUILDING_DIR_NAME.test(name))) {
    let files;
    try { files = await fsp.readdir(path.join(thumbDir, dirName)); } catch { continue; }
    for (const file of files.filter(f => SHEET_FILE_NAME.test(f) && files.includes(f + '.key'))) {
      try { found.set((await fsp.readFile(path.join(thumbDir, dirName, file + '.key'), 'utf8')).trim(), path.join(thumbDir, dirName, file)); }
      catch {}
    }
  }
  return found;
}
const SHEET_FILE_NAME = /^mosaic-h\d+-\d+\.mp4$/;

async function linkOrCopy(from, to) {
  try { await fsp.link(from, to); return true; } catch {}
  try {
    const temp = videoTempPath(to);
    await fsp.copyFile(from, temp);
    await publish(temp, to);
    return true;
  } catch { return false; }
}

// What an atlas was made from: { sources: { name: signature }, sheets:
// { file: key } }. Not served (the routes serve _video.json and mosaics).
export async function readAtlasInputs(thumbDir, dirName) {
  try {
    const inputs = JSON.parse(await fsp.readFile(path.join(thumbDir, dirName, '_inputs.json'), 'utf8'));
    return inputs && typeof inputs === 'object' && inputs.sources && typeof inputs.sources === 'object' ? inputs : null;
  } catch { return null; }
}

// ---------- reading, for the page ----------

// _video.json of the atlas the manifest names, cached like the still
// atlas's meta (atlas.js): keyed by directory, so a new commit is read anew.
const videoMetaCache = new Map();  // galleryAbs -> { dir, meta }
export async function readVideoAtlasMeta(galleryAbs, dir) {
  if (!dir || !isVideoAtlasDirName(dir)) return null;
  const file = path.join(galleryAbs, GG_DIR, dir, '_video.json');
  const cached = videoMetaCache.get(galleryAbs);
  if (cached && cached.dir === dir && fs.existsSync(file)) return cached.meta;
  let meta = null;
  try { meta = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
  videoMetaCache.set(galleryAbs, { dir, meta });
  return meta;
}
export function forgetVideoAtlasMeta(galleryAbs) { videoMetaCache.delete(galleryAbs); }

// ---------- sweeping ----------

// Withdraw every finished atlas that shows a video not in images any more,
// or one since replaced (its signature in record differs): atlases are
// public, and would keep that video public. Its _video.json and the sheets
// that show such a video are deleted at once; its other sheets, which show
// only videos still there, stay until the next atlas is committed, so that
// one can reuse them (hard links) instead of encoding them again.
export async function sweepVideoAtlasesShowingGoneVideos(thumbDir, record, images) {
  let entries;
  try { entries = await fsp.readdir(thumbDir); } catch { return; }
  const current = new Set(images);
  for (const name of entries.filter(isVideoAtlasDirName)) {
    const dir = path.join(thumbDir, name);
    const inputs = await readAtlasInputs(thumbDir, name);
    const isGone = video => !current.has(video) || !record || !record[video] ||
      record[video].signature !== inputs.sources[video];
    if (!inputs || !inputs.sheetVideos) {
      // No record of which sheet shows what (or none at all): all of it.
      if (!inputs || Object.keys(inputs.sources).some(isGone)) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    if (!Object.keys(inputs.sources).some(isGone)) continue;
    await fsp.unlink(path.join(dir, '_video.json')).catch(() => {});
    for (const [file, videos] of Object.entries(inputs.sheetVideos)) {
      if (videos.some(isGone)) await fsp.unlink(path.join(dir, file)).catch(() => {});
    }
  }
}

// The layout to keep tiles' places from: the committed atlas's, or else
// (it was withdrawn, or none is committed) the newest atlas's in gg/, if
// made under the current ATLAS_RULE. null: pack afresh.
export async function previousLayoutIn(thumbDir, committed) {
  let entries;
  try { entries = (await fsp.readdir(thumbDir)).filter(isVideoAtlasDirName); } catch { return null; }
  // Newest by when it was built (recorded in it): a directory's own time
  // changes when a withdrawn atlas loses some of its files.
  const candidates = [];
  for (const name of entries) {
    const inputs = await readAtlasInputs(thumbDir, name);
    if (inputs && inputs.rule === ATLAS_RULE && inputs.layout) candidates.push({ name, inputs });
  }
  candidates.sort((a, b) => (a.name === committed ? -1 : b.name === committed ? 1 : (b.inputs.builtAt || 0) - (a.inputs.builtAt || 0)));
  if (!candidates.length) return null;
  return candidates[0].inputs.incomplete ? null : candidates[0].inputs.layout;
}

// A finished atlas in gg/ other than the committed one that wanted(inputs)
// accepts, with all its files: the server died after finishing it and
// before pointing the manifest at it, so it is committed as it is.
export async function finishedAtlasMatching(thumbDir, committed, wanted) {
  let entries;
  try { entries = (await fsp.readdir(thumbDir)).filter(name => isVideoAtlasDirName(name) && name !== committed); } catch { return null; }
  for (const name of entries) {
    const inputs = await readAtlasInputs(thumbDir, name);
    if (!inputs || inputs.rule !== ATLAS_RULE || !wanted(inputs)) continue;
    const files = ['_video.json', ...Object.keys(inputs.sheets || {})];
    if (files.every(file => fs.existsSync(path.join(thumbDir, name, file)))) return name;
  }
  return null;
}

// Remove atlases other than keepDirs, and unfinished ones not in inUse.
export async function sweepStaleVideoAtlases(thumbDir, keepDirs, inUse) {
  let entries;
  try { entries = await fsp.readdir(thumbDir); } catch { return; }
  for (const name of entries) {
    const abs = path.join(thumbDir, name);
    const stale = (isVideoAtlasDirName(name) && !keepDirs.includes(name)) ||
      (BUILDING_DIR_NAME.test(name) && !inUse.has(abs));
    if (stale) await fsp.rm(abs, { recursive: true, force: true }).catch(() => {});
  }
}
