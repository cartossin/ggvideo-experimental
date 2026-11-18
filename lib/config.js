// Runtime configuration: settings from the environment, on-disk layout
// constants, LoD tiers. Imports only lib/env_file.js (for its path in a
// message); everything else imports from here.
//
// Every setting is read and checked here, once, as this module loads. A bad
// value stops the process with a message that names the variable and the
// form it accepts, instead of surfacing later as a stack trace or a gallery
// that never finishes building.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { envFilePath } from './env_file.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Single-threaded vips per subprocess. We do our own parallelism via the
// BuildQueue worker pool — letting libvips spin internal threads on top
// only causes lock contention and thread-setup overhead (esp. on tiny h5/h10
// LoDs that finish in milliseconds).
process.env.VIPS_CONCURRENCY = process.env.VIPS_CONCURRENCY || "1";  // checked below, with the other settings

// ---------- reading settings ----------

const settingProblems = [];

// The variable's value, or null when it is unset or blank (a blank line in
// an environment file means "use the default", as it does for systemd).
function settingText(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return null;
  return value.trim();
}
function reportBadSetting(name, value, acceptedForm) {
  settingProblems.push(`${name}=${JSON.stringify(value)} is not valid: expected ${acceptedForm}.`);
}

function integerSetting(name, defaultValue, min, max) {
  const text = settingText(name);
  if (text === null) return defaultValue;
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!(value >= min && value <= max)) {
    reportBadSetting(name, text, `a whole number from ${min} to ${max}`);
    return defaultValue;
  }
  return value;
}

function decimalSetting(name, defaultValue, min, max) {
  const text = settingText(name);
  if (text === null) return defaultValue;
  const value = /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
  if (!(value >= min && value <= max)) {
    reportBadSetting(name, text, `a number from ${min} to ${max}, such as ${defaultValue}`);
    return defaultValue;
  }
  return value;
}

// A size in bytes: plain bytes ("16777216") or a whole number with a binary
// unit ("16MiB", "16 MiB"). "MB" is refused rather than guessed at: it means
// 1000*1000 to some people and 1024*1024 to others.
const BYTE_UNITS = { '': 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
function formatBytes(bytes) {
  for (const unit of ['TiB', 'GiB', 'MiB', 'KiB']) {
    const size = BYTE_UNITS[unit.toLowerCase()];
    if (bytes >= size && bytes % size === 0) return (bytes / size) + ' ' + unit;
  }
  return bytes + ' bytes';
}
function byteSizeSetting(name, defaultValue, min, max) {
  const text = settingText(name);
  if (text === null) return defaultValue;
  const match = /^(\d+)\s*(KiB|MiB|GiB|TiB)?$/i.exec(text);
  const value = match ? Number(match[1]) * BYTE_UNITS[(match[2] || '').toLowerCase()] : NaN;
  if (!(value >= min && value <= max)) {
    reportBadSetting(name, text, `a size from ${formatBytes(min)} to ${formatBytes(max)}, in bytes or with KiB, MiB, GiB or TiB (such as "${formatBytes(defaultValue).replace(' ', '')}")`);
    return defaultValue;
  }
  return value;
}

function directorySetting(name, defaultValue) {
  return path.resolve(settingText(name) || defaultValue);
}

// ---------- the settings (README "Configuration" lists each one) ----------

export const PORT             = integerSetting('PORT', 3000, 1, 65535);
export const HOST             = settingText('HOST') || '0.0.0.0';
export const GALLERIES_ROOT   = directorySetting('GALLERIES_ROOT', '/var/lib/ggvideo/galleries');
export const STATE_DIR        = directorySetting('STATE_DIR', '/var/lib/ggvideo');
export const SITE_TITLE       = settingText('SITE_TITLE') || 'ggvideo';
export const PUBLIC_DIR       = path.join(APP_ROOT, 'public');
// The release this code is. package.json is the one place it is written.
export const VERSION          = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
// 0 means one build process per CPU (vips is single-threaded per process).
export const BUILD_CONCURRENCY = integerSetting('BUILD_CONCURRENCY', 0, 0, 1024) || os.cpus().length;
// Upload chunks are held in memory while they arrive.
export const CHUNK_SIZE       = byteSizeSetting('CHUNK_SIZE', 16 * 1024 ** 2, 64 * 1024, 1024 ** 3);
// Per-file ceiling. The chunk table is sized from the declared size, so an
// unbounded size could make create allocate without end.
export const MAX_UPLOAD_BYTES = byteSizeSetting('MAX_UPLOAD_BYTES', 64 * 1024 ** 3, 1024, 1024 ** 5);
// libheif enforces a per-axis cap on AVIF saves (16384 on Debian's build; the
// HEIF spec ceiling). Renditions are bounded to this width; see vips.js.
export const AVIF_MAX_DIM     = integerSetting('AVIF_MAX_DIM', 16384, 1600, 65535);
// Widest atlas cell, in pixels.
export const SPRITE_CELL_W_MAX = integerSetting('SPRITE_CELL_W_MAX', 600, 100, 16384);
// Atlas images encoded at once while a folder bakes.
export const SPRITE_ENCODE_PARALLEL = integerSetting('SPRITE_ENCODE_PARALLEL', 4, 1, 64);

// Threads inside each vips process (libvips reads this variable itself).
integerSetting('VIPS_CONCURRENCY', 1, 1, 256);
// Photos above this many megapixels get the placeholder instead of
// renditions, and no vips call may run longer than the timeout; see vips.js.
export const MAX_SOURCE_MEGAPIXELS = decimalSetting('MAX_SOURCE_MEGAPIXELS', 300, 1, 100000);
export const VIPS_TIMEOUT_SECONDS  = decimalSetting('VIPS_TIMEOUT_SECONDS', 600, 0.1, 86400);

// ---------- video (README "Video") ----------

// The moving preview of a video is its first VIDEO_PREVIEW_SECONDS (a
// shorter video loops to fill them), at a constant VIDEO_PREVIEW_FPS. Every
// mosaic of a folder has exactly this length, so they all loop together.
// Mosaics are decoded in hardware, which every browser can do up to 4K at
// 30 fps; hence the cap.
export const VIDEO_PREVIEW_SECONDS = integerSetting('VIDEO_PREVIEW_SECONDS', 60, 2, 600);
export const VIDEO_PREVIEW_FPS     = integerSetting('VIDEO_PREVIEW_FPS', 24, 1, 30);
// Tile heights of the video atlas, in pixels. Each tier is one set of
// mosaics; the viewer picks the smallest tier at least as tall as the
// tiles on screen and scales it down, never up. h25 is for the zoomed-out
// view of folders of thousands of videos (a 4K mosaic holds about 4,600 of
// its tiles), h400 for the largest grid (about 25 tiles of 16:9 video);
// above it the viewer plays each video's web copy. A video has no tile in
// a tier taller than itself (video_atlas.js videoTierHeights).
export const VIDEO_TIERS           = videoTiersSetting('VIDEO_TIERS', [25, 50, 100, 200, 400]);
// The browser-playable copy is at most this many lines (the short side of a
// vertical video), never upscaled.
export const VIDEO_WEB_MAX_HEIGHT  = integerSetting('VIDEO_WEB_MAX_HEIGHT', 1080, 144, 2160);
// No ffmpeg run may last longer. The slowest one is a web copy of a long
// video: a two-hour 4K film takes well over an hour on a small machine.
export const FFMPEG_TIMEOUT_SECONDS = decimalSetting('FFMPEG_TIMEOUT_SECONDS', 14400, 1, 7 * 86400);
// Working threads for all building at once, photos and videos together
// (cpu_budget.js): no more than there are CPUs. 0 means the CPU count.
export const CPU_BUDGET = integerSetting('CPU_BUDGET', 0, 0, 1024) || os.cpus().length;
// A clip or web copy that failed for a passing reason (videos.js) is tried
// again after this long, then at doubling intervals; a folder whose atlas
// could not be made, after twice this.
export const VIDEO_RETRY_SECONDS   = integerSetting('VIDEO_RETRY_SECONDS', 300, 1, 86400);
// Memory for the frames of one mosaic being composed (mosaic_worker.js):
// a full 4K sheet's frame is 12 MiB, so 512 MiB holds a one-second chunk
// of it (and longer chunks of smaller sheets). One per sheet being made.
export const VIDEO_MOSAIC_MEMORY   = byteSizeSetting('VIDEO_MOSAIC_MEMORY', 512 * 1024 ** 2, 64 * 1024 ** 2, 64 * 1024 ** 3);

// "25,50,100,200": distinct heights from 16 to 1080, at most six.
function videoTiersSetting(name, defaultValue) {
  const text = settingText(name);
  if (text === null) return defaultValue;
  const heights = text.split(',').map(part => part.trim());
  const valid = heights.length <= 6 && heights.every(part => /^\d+$/.test(part)) &&
    heights.map(Number).every(h => h >= 16 && h <= 1080) &&
    new Set(heights.map(Number)).size === heights.length;
  if (!valid) {
    reportBadSetting(name, text, 'up to six distinct heights from 16 to 1080, separated by commas, such as "25,50,100,200"');
    return defaultValue;
  }
  return heights.map(Number).sort((a, b) => a - b);
}

export const PASSKEY_FILE     = path.join(STATE_DIR, 'passkey.json');
// Small tiers are lossless `.v` (raw, fast to decode for atlas packing);
// large tiers are AVIF Q=80.
export const LOD_TIERS = [
  { h: 5,   format: 'v',    quality: null },
  { h: 10,  format: 'v',    quality: null },
  { h: 50,  format: 'v',    quality: null },
  { h: 100, format: 'v',    quality: null },
  { h: 200, format: 'avif', quality: 80 },
  { h: 400, format: 'avif', quality: 80 },
  { h: 800,  format: 'avif', quality: 80 },
  { h: 1600, format: 'avif', quality: 80 },
];
export function lodPath(thumbDir, filename, height, format) {
  return path.join(thumbDir, filename + '.h' + height + '.' + format);
}
// Renditions are named after their photo, and the longest name made from a
// photo's is its largest rendition while it is written:
// "<name>.h1600.avif.__tmp.avif", 22 bytes more. Filesystems allow 255 bytes
// per name, so a photo name may have at most 233. The files made from a
// video stay within the same 22 bytes ("<name>.v1080.mp4.__vtmp.mp4" is the
// longest, 21; see videos.js).
export const MAX_PHOTO_NAME_BYTES = 255 - '.h1600.avif.__tmp.avif'.length;
export function photoNameFits(name) {
  return Buffer.byteLength(name) <= MAX_PHOTO_NAME_BYTES;
}

// Sprite size is capped by target file bytes. Translate bytes → pixel budget via
// an empirical bytes/pixel constant; tune BYTES_PER_PIXEL lower for flat-color
// content, higher for extreme detail.
const MAX_SPRITE_BYTES  = byteSizeSetting('MAX_SPRITE_BYTES', 4 * 1024 ** 2, 64 * 1024, 64 * 1024 ** 2);
const BYTES_PER_PIXEL   = decimalSetting('BYTES_PER_PIXEL', 0.30, 0.01, 10);
export const MAX_SPRITE_PIXELS = Math.max(1, Math.floor(MAX_SPRITE_BYTES / BYTES_PER_PIXEL));
// Recorded in each atlas's _sprite.json; bumped whenever the packing rule
// changes (cell shape, tier set). It is not part of the atlas hash: an
// atlas packed under an older rule still serves, and is re-packed under the
// current rule when its folder next changes.
export const SPRITE_LAYOUT_VERSION = 6;

export const LOGIN_LINK_TTL   = 10 * 60 * 1000;
export const RP_NAME          = SITE_TITLE;

// Each gallery folder owns a child dir named GG_DIR holding all derived state
// (manifest, per-image LoDs, atlases). RESERVED names are excluded from listings.
export const GG_DIR = 'gg';
export const RESERVED = new Set([GG_DIR]);

// Is this a name the filesystem could resolve to a reserved directory?
// Case-insensitive filesystems (Windows, default macOS) open gg/ for "GG".
// Windows also ignores trailing dots and spaces ("gg." is gg) and reads
// "gg:stream" as a stream of gg. Every such spelling is refused, so the data
// directory can only be addressed by its exact name, and only by the routes
// that serve built files from it.
export function isReservedName(name) {
  const base = withoutTrailingDotsAndSpaces(name.split(':')[0]).toLowerCase();
  return RESERVED.has(base);
}
// A loop, not /[. ]+$/: that regex retries from every dot in a long run that
// is not at the end, which is quadratic, and this runs on every URL segment.
function withoutTrailingDotsAndSpaces(s) {
  let end = s.length;
  while (end > 0 && (s[end - 1] === '.' || s[end - 1] === ' ')) end--;
  return s.slice(0, end);
}
const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);

export function isImage(name) {
  return SUPPORTED_EXT.has(path.extname(name).toLowerCase());
}

// Video files are recognised by extension, like photos; ffprobe then decides
// whether there is a video stream ffmpeg can decode (videos.js). The list is
// the containers people actually have lying around: phone and camera files
// (mp4, mov, m4v, 3gp, mts/m2ts), downloads (mkv, webm, avi, flv, wmv, asf,
// ogv), disc and broadcast rips (mpg, mpeg, ts, vob) and old DivX files.
const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.mpg', '.mpeg',
  '.ts', '.m2ts', '.mts', '.3gp', '.ogv', '.asf', '.divx', '.vob',
]);

export function isVideo(name) {
  return VIDEO_EXT.has(path.extname(name).toLowerCase());
}

// A file the gallery shows: a photo or a video. Listing, upload, trash and
// the original-file route all go by this; only the build tells them apart.
export function isMedia(name) {
  return isImage(name) || isVideo(name);
}

// Pre-rendered red-X tiles substituted for images vips cannot read.
export const BROKEN_SVG = path.join(PUBLIC_DIR, 'broken.svg');
export const BROKEN_DIR = path.join(STATE_DIR, '_broken');

if (settingProblems.length) {
  for (const problem of settingProblems) console.error('[fatal] ' + problem);
  console.error(`[fatal] Settings are environment variables; the systemd service reads them from ${envFilePath()}. See "Configuration" in the README.`);
  process.exit(1);
}

// ---------- data directories ----------

// The server calls this before it loads the modules that use the data
// directories. A missing directory is created (as it always was); one that
// cannot be created or written, or a state dir inside the galleries root,
// stops startup. The state dir must stay out of the galleries tree: every
// folder there is published, so its uploads/ and _broken/ would be listed
// as galleries. The default layout has it the other way round (galleries
// inside the state dir), which is fine: only the galleries root is served.
export function prepareDataDirectories() {
  const problems = [];
  const galleriesRoot = usableDirectory('GALLERIES_ROOT', GALLERIES_ROOT, problems);
  const stateDir = usableDirectory('STATE_DIR', STATE_DIR, problems);
  if (galleriesRoot && stateDir && isSameOrInside(stateDir, galleriesRoot)) {
    problems.push(`STATE_DIR=${STATE_DIR} is ${stateDir === galleriesRoot ? 'the same directory as' : 'inside'} GALLERIES_ROOT=${GALLERIES_ROOT}. ` +
      'Everything under the galleries root is published, so the state dir must be somewhere else.');
  }
  if (problems.length) {
    for (const problem of problems) console.error('[fatal] ' + problem);
    process.exit(1);
  }
}

// The directory's real path (symlinks resolved), creating it if missing;
// null after recording a problem.
function usableDirectory(name, dir, problems) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.statSync(dir).isDirectory()) {
      problems.push(`${name}=${dir} is not a directory.`);
      return null;
    }
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    return fs.realpathSync(dir);
  } catch (error) {
    const reason = error.code === 'EACCES' || error.code === 'EPERM' ? 'permission denied' : error.message;
    problems.push(`${name}=${dir} cannot be used (${reason}). It must be a directory that ${currentUserName()}, the user the server runs as, can write.`);
    return null;
  }
}
function currentUserName() {
  try { return os.userInfo().username; }
  catch { return 'uid ' + process.getuid(); }  // a uid with no passwd entry, as in some containers
}
function isSameOrInside(dir, parent) {
  const relative = path.relative(parent, dir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// The addresses to tell a person to open, for the startup line and the
// login-link command. A wildcard listen address (0.0.0.0, ::) is not one
// a browser can open; loopback is spelled "localhost", the one plain-HTTP
// name browsers allow passkeys on.
export function addressesToOpen() {
  const port = PORT;
  if (HOST === '0.0.0.0' || HOST === '::') {
    return { fromElsewhere: `http://${os.hostname()}:${port}/`, onThisMachine: `http://localhost:${port}/` };
  }
  if (HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost') {
    return { fromElsewhere: null, onThisMachine: `http://localhost:${port}/` };
  }
  const hostInUrl = HOST.includes(':') ? `[${HOST}]` : HOST;
  return { fromElsewhere: `http://${hostInUrl}:${port}/`, onThisMachine: null };
}
