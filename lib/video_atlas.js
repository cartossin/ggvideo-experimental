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
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Worker } from 'worker_threads';
import {
  FFMPEG_TIMEOUT_SECONDS, GG_DIR, VIDEO_MOSAIC_MEMORY, VIDEO_PREVIEW_FPS, VIDEO_PREVIEW_SECONDS, VIDEO_TIERS,
} from './config.js';
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

// Lay out one tier. items: [{ name, info }] in gallery order.
export function layoutTier(items, tierHeight) {
  const packer = new ShelfPacker(tierHeight);
  items.forEach((item, index) => packer.place(index, tileSizeIn(item.info, tierHeight)));
  return finishLayout(packer, items.length);
}

// ---------- encoding one sheet ----------

// Tiles are small and the mosaic loops for ever once loaded, so it is
// encoded once with care for size: CRF 26 with a bitrate ceiling for a full
// 4K sheet (scaled down with the sheet's area). Keyframes every 2 s at
// exactly the same frames in every mosaic, no scene-cut keyframes. 4K at
// 24 fps needs H.264 level 5.1; x264 picks the level from size, frame rate
// and the ceiling, and the sheets stay within 5.1 (see README).
export const MOSAIC_RULE = 'm2:crf26:8000k:faster';
const FULL_SHEET_KBPS = 8000;

// Everything an atlas's layout and encoding depend on besides its videos.
// Recorded in _inputs.json; an atlas made under another rule (older code,
// other VIDEO_TIERS, preview length or frame rate) is made again, reusing
// every sheet whose content key still matches.
export const ATLAS_RULE = JSON.stringify(['a2', VIDEO_TIERS, VIDEO_PREVIEW_SECONDS, VIDEO_PREVIEW_FPS, TILE_SKIRT,
  SHEET_MAX_WIDTH, SHEET_MAX_HEIGHT, MOSAIC_RULE, CLIP_RULE]);

function sheetBitrateKbps(width, height) {
  return Math.max(500, Math.round(FULL_SHEET_KBPS * (width * height) / (SHEET_MAX_WIDTH * SHEET_MAX_HEIGHT)));
}

// Decoder processes per sheet (single-threaded each; see mosaic_worker.js).
const MOSAIC_DECODER_LANES = 4;

// Sheets being composed now: worker -> owner (a gallery folder).
const mosaicWorkers = new Map();

// Compose a sheet from its clips in a worker thread (mosaic_worker.js): our
// own code copies tile pixels into sheet frames, one ffmpeg encodes them.
// The frames of one chunk are the only large buffers, so the chunk is as
// many whole seconds as fit in VIDEO_MOSAIC_MEMORY (at least one).
function encodeSheet(sheet, clips, outPath, owner) {
  const fps = VIDEO_PREVIEW_FPS;
  const frameBytes = sheet.width * sheet.height * 3 / 2;
  const totalFrames = VIDEO_PREVIEW_SECONDS * fps;
  const chunkFrames = Math.min(totalFrames, Math.max(fps, Math.floor(VIDEO_MOSAIC_MEMORY / frameBytes / fps) * fps));
  const kbps = sheetBitrateKbps(sheet.width, sheet.height);
  const listDir = outPath + '.lanes';
  const encoderArgs = [
    '-an', '-sn', '-dn', '-c:v', 'libx264', '-threads', '8', '-preset', 'faster', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
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
      lanes: MOSAIC_DECODER_LANES, members, listDir, encoderArgs, timeoutMs: FFMPEG_TIMEOUT_SECONDS * 1000,
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
function sheetKey(tierHeight, sheet, clipSignatures) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify([CLIP_RULE, MOSAIC_RULE, VIDEO_PREVIEW_SECONDS, VIDEO_PREVIEW_FPS, tierHeight,
    sheet.width, sheet.height, sheet.members.map(m => [clipSignatures[m.index], m.clipX, m.clipY])]));
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
// temp sweep spares them. sheets, if given, gets the counts of sheets
// encoded and reused. Resolves with the directory name.
export async function bakeVideoAtlas({ galleryAbs, names, infos, sourceSignatures, runSheetJob, trackTemp, owner, sheets: counts = {} }) {
  const thumbDir = path.join(galleryAbs, GG_DIR);
  const dirName = newVideoAtlasDirName();
  const buildingAbs = path.join(thumbDir, dirName + '_building');
  await fsp.mkdir(buildingAbs, { recursive: true });
  trackTemp(buildingAbs, true);
  try {
    const reusable = await reusableSheets(thumbDir);
    const meta = { version: VIDEO_ATLAS_VERSION, loopSeconds: VIDEO_PREVIEW_SECONDS, fps: VIDEO_PREVIEW_FPS, names, tiers: {} };
    const inputs = { rule: ATLAS_RULE, sources: {}, sheets: {} };
    names.forEach((name, i) => { inputs.sources[name] = sourceSignatures[i]; });
    const jobs = [];
    for (const tierHeight of VIDEO_TIERS) {
      const clipPaths = names.map(name => clipPath(thumbDir, name, tierHeight));
      const clipSignatures = await Promise.all(clipPaths.map(fileSignature));
      const layout = layoutTier(names.map((name, i) => ({ name, info: infos[i] })), tierHeight);
      meta.tiers[tierKey(tierHeight)] = {
        sheets: layout.sheets.map((sheet, s) => ({ file: sheetFileName(tierHeight, s), width: sheet.width, height: sheet.height })),
        tiles: layout.tiles,
      };
      for (const [s, sheet] of layout.sheets.entries()) {
        const file = sheetFileName(tierHeight, s);
        const key = sheetKey(tierHeight, sheet, clipSignatures);
        inputs.sheets[file] = key;
        const outPath = path.join(buildingAbs, file);
        if (reusable.has(key) && await linkOrCopy(reusable.get(key), outPath)) { counts.reused = (counts.reused || 0) + 1; continue; }
        counts.encoded = (counts.encoded || 0) + 1;
        const clips = sheet.members.map(m => ({ path: clipPaths[m.index], frames: clipFrameTotal(infos[m.index]) }));
        jobs.push(runSheetJob(() => encodeSheet(sheet, clips, outPath, owner), file));
      }
    }
    // Every sheet is waited for, even after one fails, so none is still
    // being written when the building directory is removed below.
    const outcomes = await Promise.allSettled(jobs);
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
    await writeJson(path.join(buildingAbs, '_inputs.json'), inputs);
    await writeJson(path.join(buildingAbs, '_video.json'), meta);
    await fsp.rename(buildingAbs, path.join(thumbDir, dirName));
    return dirName;
  } catch (e) {
    await fsp.rm(buildingAbs, { recursive: true, force: true }).catch(() => {});
    throw e;
  } finally {
    trackTemp(buildingAbs, false);
  }
}

async function writeJson(file, value) {
  await fsp.writeFile(file + '.tmp', JSON.stringify(value));
  await fsp.rename(file + '.tmp', file);
}

// Sheets of the atlases in gg/ by their keys: key -> absolute path.
async function reusableSheets(thumbDir) {
  const found = new Map();
  let entries;
  try { entries = await fsp.readdir(thumbDir); } catch { return found; }
  for (const dirName of entries.filter(isVideoAtlasDirName)) {
    const inputs = await readAtlasInputs(thumbDir, dirName);
    if (!inputs) continue;
    for (const [file, key] of Object.entries(inputs.sheets || {})) {
      if (/^mosaic-h\d+-\d+\.mp4$/.test(file)) found.set(key, path.join(thumbDir, dirName, file));
    }
  }
  return found;
}

async function linkOrCopy(from, to) {
  try { await fsp.link(from, to); return true; } catch {}
  try {
    const temp = videoTempPath(to);
    await fsp.copyFile(from, temp);
    await fsp.rename(temp, to);
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

// Remove every finished atlas that shows a video not in images any more,
// or one since replaced (its signature in record differs): atlases are
// public, and would keep that video public.
export async function sweepVideoAtlasesShowingGoneVideos(thumbDir, record, images) {
  let entries;
  try { entries = await fsp.readdir(thumbDir); } catch { return; }
  const current = new Set(images);
  for (const name of entries.filter(isVideoAtlasDirName)) {
    const inputs = await readAtlasInputs(thumbDir, name);
    const showsGone = !inputs || Object.entries(inputs.sources).some(([video, signature]) =>
      !current.has(video) || !record || !record[video] || record[video].signature !== signature);
    if (showsGone) await fsp.rm(path.join(thumbDir, name), { recursive: true, force: true }).catch(() => {});
  }
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
