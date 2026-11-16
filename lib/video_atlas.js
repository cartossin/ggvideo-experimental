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
//       "h50":  { "sheets": [...], "tiles": [...] },
//       "h100": { ... }, "h200": { ... }   one key per VIDEO_TIERS height
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
//     even-pixel rounding). The picture is height pixels tall, the tier's
//     height, except for videos wider than 4:1, which are shrunk to 4:1
//     wide. Around every rectangle are TILE_SKIRT (4) pixels repeating the
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
import { GG_DIR, VIDEO_PREVIEW_FPS, VIDEO_PREVIEW_SECONDS, VIDEO_SHEET_MAX_TILES, VIDEO_TIERS } from './config.js';
import { runFfmpeg } from './ffmpeg.js';
import { CLIP_RULE, TILE_SKIRT, clipPath, tileSize, videoTempPath } from './videos.js';

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
// right in gallery order, as many rows as fit in a sheet; a sheet also ends
// at VIDEO_SHEET_MAX_TILES tiles, which bounds the files one ffmpeg opens.
// Each sheet is only as large as its tiles need. A tile shorter than its row
// (a video wider than 4:1) sits in the middle of it.
// infos: per video { width, height }. Returns { sheets: [{ width, height,
// members: [{ index, clipX, clipY, width, height }] }], tiles: [[s,x,y,w,h]] }.
export function layoutTier(infos, tierHeight) {
  const skirt = TILE_SKIRT;
  const rowHeight = tierHeight + 2 * skirt;
  const rowsPerSheet = Math.max(1, Math.floor(SHEET_MAX_HEIGHT / rowHeight));
  const maxTileWidth = SHEET_MAX_WIDTH - 2 * skirt;
  const sheets = [];
  const tiles = new Array(infos.length);
  let sheet = null, row = 0, x = 0;
  const startSheet = () => { sheet = { width: 0, height: 0, members: [] }; sheets.push(sheet); row = 0; x = 0; };
  for (const [index, info] of infos.entries()) {
    const size = tileSize(info, tierHeight, maxTileWidth);
    const cellWidth = size.width + 2 * skirt;
    if (!sheet || sheet.members.length >= VIDEO_SHEET_MAX_TILES) startSheet();
    if (x + cellWidth > SHEET_MAX_WIDTH) {
      row++;
      x = 0;
      if (row >= rowsPerSheet) startSheet();
    }
    const clipX = x;
    const clipY = row * rowHeight + 2 * Math.floor((tierHeight - size.height) / 4);  // centred, even
    sheet.members.push({ index, clipX, clipY, width: size.width, height: size.height });
    tiles[index] = [sheets.length - 1, clipX + skirt, clipY + skirt, size.width, size.height];
    x += cellWidth;
    sheet.width = Math.max(sheet.width, x);
    sheet.height = Math.max(sheet.height, (row + 1) * rowHeight);
  }
  return { sheets, tiles };
}

// ---------- encoding one sheet ----------

// Tiles are small and the mosaic loops for ever once loaded, so it is
// encoded once with care for size: CRF 26, with a ceiling of 8 Mbit/s for a
// full 4K sheet (scaled down with the sheet's area), which measured about
// 55 MB for a full 3720x2160 sheet of 60 s of Big Buck Bunny tiles, with
// tiles that look clean at their own size. Keyframes every 2 s at exactly
// the same frames in every mosaic, no scene-cut keyframes.
export const MOSAIC_RULE = 'm1:crf26:8000k:faster';
const FULL_SHEET_KBPS = 8000;

function sheetBitrateKbps(width, height) {
  return Math.max(500, Math.round(FULL_SHEET_KBPS * (width * height) / (SHEET_MAX_WIDTH * SHEET_MAX_HEIGHT)));
}

// Assemble a sheet from its clips with xstack (one filter, every input
// decoded once, frame by frame, placed at its position; measured on 400
// inputs: about 45 s for a full 4K sheet on 16 threads). The clips are 4:2:0
// at even positions, so no chroma sample straddles two tiles. One decoder
// thread per clip: hundreds of clips with a thread per core each would
// start tens of thousands of threads. A clip shorter than the mosaic (its
// video is) loops (-stream_loop) until the mosaic's -t ends it.
async function encodeSheet(sheet, clipPaths, outPath, owner) {
  const fps = VIDEO_PREVIEW_FPS;
  const inputs = [];
  for (const clip of clipPaths) inputs.push('-threads', '1', '-protocol_whitelist', 'file', '-stream_loop', '-1', '-i', 'file:' + clip);
  const graph = clipPaths.length === 1
    ? `[0:v]pad=${sheet.width}:${sheet.height}:${sheet.members[0].clipX}:${sheet.members[0].clipY}:black[v]`
    : clipPaths.map((_, i) => `[${i}:v]`).join('') +
      `xstack=inputs=${clipPaths.length}:fill=black:layout=` +
      sheet.members.map(member => member.clipX + '_' + member.clipY).join('|') +
      // xstack sizes its output to the tiles; pad it to the sheet's size.
      `,pad=${sheet.width}:${sheet.height}:0:0:black[v]`;
  const kbps = sheetBitrateKbps(sheet.width, sheet.height);
  await runFfmpeg('ffmpeg', [
    ...inputs, '-filter_complex', graph, '-map', '[v]', '-an', '-sn', '-dn',
    '-t', String(VIDEO_PREVIEW_SECONDS), '-r', String(fps), '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', 'faster', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-crf', '26', '-maxrate', kbps + 'k', '-bufsize', (2 * kbps) + 'k',
    '-g', String(2 * fps), '-keyint_min', String(2 * fps), '-sc_threshold', '0',
    '-map_metadata', '-1', '-movflags', '+faststart', '-f', 'mp4', '-y', 'file:' + outPath,
  ], { owner });
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
    const inputs = { sources: {}, sheets: {} };
    names.forEach((name, i) => { inputs.sources[name] = sourceSignatures[i]; });
    const jobs = [];
    for (const tierHeight of VIDEO_TIERS) {
      const clipPaths = names.map(name => clipPath(thumbDir, name, tierHeight));
      const clipSignatures = await Promise.all(clipPaths.map(fileSignature));
      const layout = layoutTier(infos, tierHeight);
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
        const members = sheet.members.map(m => clipPaths[m.index]);
        jobs.push(runSheetJob(() => encodeSheet(sheet, members, outPath, owner), file));
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
