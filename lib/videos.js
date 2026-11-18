// One video's derived files: what ffprobe says about it, its poster frame,
// its preview clips and its browser-playable web copy.
//
// A video is a photo to the still pipeline: its poster (one representative
// frame) is fed to the same vips steps a photo is (build.js), so it gets the
// same renditions and the same place in the still atlas. Everything that
// moves is made after the folder is committed, by video_stage.js:
//
//   gg/<name>.v<H>.mp4        preview clip for the video atlas tier of
//                             height H: the first VIDEO_PREVIEW_SECONDS at
//                             VIDEO_PREVIEW_FPS, no audio, the picture
//                             scaled to its tile and surrounded by a skirt of
//                             its own edge pixels (TILE_SKIRT). Mosaics are
//                             assembled from these, so adding a video to a
//                             folder decodes that one video, not all of them.
//   gg/<name>.web.mp4         H.264 + AAC, at most VIDEO_WEB_MAX_HEIGHT,
//                             faststart: what the viewer plays.
//   gg/_videos.json           the record below.
//
// Every name here is at most 21 bytes longer than the video's
// ("<name>.v1080.mp4.__vtmp.mp4"), inside the 22 that config.js leaves.
//
// The record, gg/_videos.json: { "<name>": entry }, entry =
//   signature   the video's "<mtimeMs>:<size>" when it was probed (sources.js)
//   info        what probeVideo found, or null when ffmpeg cannot read it
//   error       why not, when info is null
//   clipTiers   { "<tier height>": "<signature>|<CLIP_RULE>" } for each
//               tier whose preview clip is made (clips are tracked per tier,
//               so adding a tier to VIDEO_TIERS makes only that tier's clips)
//   clips       older records, for all tiers at once: such clips are made
//               again (CLIP_RULE c4: a keyframe every second)
//   clipsError  why they could not be made; with clipsFailures (how many
//               times in a row) and clipsFailedAt (when). Tried again on a
//               rescan, and by itself later when the cause was transient
//               (failureRetryAt)
//   storyboard  { made: "<signature>|<STORYBOARD_RULE>|<web>@<webMadeAt>",
//               interval, count, width, height, columns, rows, sheets }
//               once its storyboard is made from the web copy
//               (storyboard.js storyboardMadeFor)
//   webMadeAt   when the web copy was made (ms), so a storyboard knows
//               which copy it came from
//   storyboardError and its failures and retries, as for clips
//   web         "<signature>|<WEB_RULE>" once its web copy is made (an
//               older rule's copy still counts for a short video, see
//               webCopyIsCurrent)
//   webError    why it could not be made; webFailures and webFailedAt, and
//               retries, as for clips
// A video replaced by another file gets a new entry: its old clips and web
// copy are deleted at once and made again (refreshVideoRecord).

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import {
  GG_DIR,
  VIDEO_PREVIEW_FPS,
  VIDEO_PREVIEW_SECONDS,
  VIDEO_RETRY_SECONDS,
  VIDEO_TIERS,
  VIDEO_WEB_MAX_HEIGHT,
  isVideo,
} from './config.js';
import { videoShares } from './cpu_budget.js';
import { writeFileDurably } from './durable.js';
import { FfmpegError, UNTRUSTED_INPUT_OPTIONS, runFfmpeg } from './ffmpeg.js';
import { STORYBOARD_FILE, STORYBOARD_RULE, manifestStoryboard, storyboardSheetName } from './storyboard.js';

// ---------- names of derived files ----------

export const WEB_COPY_SUFFIX = '.web.mp4';
export function webCopyName(name) { return name + WEB_COPY_SUFFIX; }
export function clipPath(thumbDir, name, tierHeight) { return path.join(thumbDir, name + '.v' + tierHeight + '.mp4'); }
const DERIVED_VIDEO_FILE = /^(.+)\.(web|v\d+)\.mp4$/;

// Temp files of video work are marked .__vtmp., not .__tmp.: a folder's
// rebuild sweeps .__tmp. files when it starts (atlas.js sweepFolderTmps),
// and video work runs alongside rebuilds, for hours for a long web copy.
// video_stage.js sweeps these instead, sparing the ones still being written.
export const VIDEO_TEMP_MARK = '.__vtmp.';
export function videoTempPath(finalPath) { return finalPath + VIDEO_TEMP_MARK + 'mp4'; }
export function isVideoTemp(name) { return name.includes(VIDEO_TEMP_MARK); }

// What the clips and web copies are made by. Changing a rule (a setting, or
// the code below) makes every existing clip or web copy count as missing.
// The clip rule is per tier (the tier's height is in the clip's name), so
// changing VIDEO_TIERS leaves the clips of the other tiers alone.
export const TILE_SKIRT = 4;
export const CLIP_RULE = `c4:${VIDEO_PREVIEW_SECONDS}s:${VIDEO_PREVIEW_FPS}fps:${TILE_SKIRT}`;
// w2: a keyframe at least every WEB_KEYFRAME_SECONDS, encoded or copied
// (see encodeWebCopy).
export const WEB_RULE = `w2:${VIDEO_WEB_MAX_HEIGHT}`;
// Web copies made before w2 had x264's default keyframe spacing (up to
// 10 s) or, copied, the source's own. They are kept for videos of at most
// SHORT_VIDEO_SECONDS: such a copy is a few megabytes the browser holds
// whole, so a seek decodes at most a few seconds of small frames, and
// making 14,000 of them again would cost hours for nothing. Longer ones
// are made again.
const WEB_RULE_BEFORE_KEYFRAMES = `w1:${VIDEO_WEB_MAX_HEIGHT}`;
export const SHORT_VIDEO_SECONDS = 60;

// ---------- what a video is ----------

// Probes are cheap (the container header only), so a minute is only ever
// reached by a file that makes ffprobe hang.
const PROBE_TIMEOUT_SECONDS = 60;
const POSTER_TIMEOUT_SECONDS = 300;

// What ffprobe says about a video, or an FfmpegError of kind 'exit' when it
// has no video stream ffmpeg can read.
//   streamIndex, audioIndex   the streams used (audioIndex null: no sound)
//   width, height             the displayed size: rotation applied, sample
//                             aspect ratio folded into the width
//   duration (s, or null), fps (or null), hasAudio, rotation (0/90/180/270),
//   interlaced, hdr, and for the copy-instead-of-encode check: codec,
//   pixelFormat, profile, squarePixels, audioCodec, audioChannels.
export async function probeVideo(src) {
  const out = await runFfmpeg('ffprobe', [
    ...UNTRUSTED_INPUT_OPTIONS, '-show_streams', '-show_format', '-of', 'json', 'file:' + src,
  ], { captureStdout: true, timeoutSeconds: PROBE_TIMEOUT_SECONDS });
  let parsed;
  try { parsed = JSON.parse(out); } catch { throw new FfmpegError('ffprobe printed no readable description', 'exit'); }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  // A cover image (attached_pic) is a "video" stream of one frame; skip it.
  const video = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!video || !(video.width > 0) || !(video.height > 0)) throw new FfmpegError('no video stream', 'exit');
  const audio = streams.find(s => s.codec_type === 'audio');
  const rotation = rotationOf(video);
  const sampleAspect = aspectRatioValue(video.sample_aspect_ratio);
  let width = Math.max(1, Math.round(video.width * sampleAspect));
  let height = video.height;
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  const duration = positiveNumber(video.duration) || positiveNumber(parsed.format && parsed.format.duration);
  return {
    streamIndex: video.index,
    audioIndex: audio ? audio.index : null,
    width,
    height,
    duration: duration ? Math.round(duration * 1000) / 1000 : null,
    fps: frameRate(video.avg_frame_rate) || frameRate(video.r_frame_rate),
    hasAudio: !!audio,
    rotation,
    interlaced: ['tt', 'bb', 'tb', 'bt'].includes(video.field_order),
    hdr: ['smpte2084', 'arib-std-b67'].includes(video.color_transfer),
    codec: video.codec_name || null,
    pixelFormat: video.pix_fmt || null,
    profile: video.profile || null,
    squarePixels: sampleAspect === 1,
    audioCodec: audio ? audio.codec_name || null : null,
    audioChannels: audio ? Number(audio.channels) || null : null,
  };
}

// Phones record upright video sideways and say so in a display matrix
// (newer files) or a "rotate" tag (older ones). ffmpeg turns the frames
// upright when it decodes them; the displayed size has to follow.
function rotationOf(stream) {
  let degrees = 0;
  for (const sideData of stream.side_data_list || []) {
    if (sideData.rotation !== undefined) degrees = Number(sideData.rotation) || 0;
  }
  if (!degrees && stream.tags && stream.tags.rotate) degrees = Number(stream.tags.rotate) || 0;
  const quarterTurns = Math.round(degrees / 90);
  return ((quarterTurns % 4) + 4) % 4 * 90;
}
function aspectRatioValue(text) {
  const match = /^(\d+):(\d+)$/.exec(text || '');
  if (!match || Number(match[1]) === 0 || Number(match[2]) === 0) return 1;
  return Number(match[1]) / Number(match[2]);
}
function frameRate(text) {
  const match = /^(\d+)\/(\d+)$/.exec(text || '');
  if (!match || Number(match[2]) === 0) return null;
  const fps = Number(match[1]) / Number(match[2]);
  return fps > 0 && fps < 1000 ? Math.round(fps * 1000) / 1000 : null;
}
function positiveNumber(text) {
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// ---------- sizes ----------

const even = value => Math.max(2, 2 * Math.round(value / 2));

// A size that fits inside maxWidth x maxHeight, keeping the aspect ratio,
// never larger than the video, with even sides (yuv420p needs them).
function fitInside(width, height, maxWidth, maxHeight) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: even(width * scale), height: even(height * scale) };
}

// A video's picture in the atlas tier of height tierHeight: that tall,
// unless wider than 4:1, which is shrunk to 4:1 wide as the still atlas
// shrinks panoramas (one very wide video must not take a whole row). The
// width is even; the height is the tier's (odd for h25) or, for a shrunk
// one, even. At most maxWidth wide. The video atlas and the clips both use
// this, and clipSize below.
export function tileSize(info, tierHeight, maxWidth) {
  const aspect = info.width / info.height;
  const widest = Math.min(4 * tierHeight, maxWidth);
  const width = tierHeight * aspect;
  if (width <= widest) return { width: Math.min(even(width), maxWidth), height: tierHeight };
  return { width: Math.min(even(widest), maxWidth), height: Math.min(even(widest / aspect), tierHeight) };
}

// A preview clip is its tile with TILE_SKIRT pixels of the tile's own edge
// around it. yuv420p needs even sides, so a tile of odd height (h25) gets
// one more skirt row at the bottom.
export function clipSize(tile) {
  return { width: tile.width + 2 * TILE_SKIRT, height: tile.height + 2 * TILE_SKIRT + (tile.height % 2) };
}

// The web copy's size: at most VIDEO_WEB_MAX_HEIGHT on the short side and
// 16:9 of that on the long side (1080p means 1920x1080 or 1080x1920).
export function webCopySize(info) {
  const shortSide = VIDEO_WEB_MAX_HEIGHT;
  const longSide = Math.round(VIDEO_WEB_MAX_HEIGHT * 16 / 9);
  return info.width >= info.height
    ? fitInside(info.width, info.height, longSide, shortSide)
    : fitInside(info.width, info.height, shortSide, longSide);
}

// ---------- filters every picture goes through ----------

// Frames reach the filters upright (ffmpeg applies the rotation). Then:
// interlaced video (camcorders, DVDs, broadcast) is deinterlaced, and HDR
// video (recent phones) is tone-mapped to SDR, or it would look washed out
// as 8-bit yuv420p.
function pictureFilters(info) {
  const filters = [];
  if (info.interlaced) filters.push('bwdif=mode=send_frame:deint=interlaced');
  if (info.hdr) {
    filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709',
      'tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p');
  }
  return filters;
}

// ---------- the poster ----------

// The poster is made at most this tall: the largest rendition is h1600.
const POSTER_MAX_HEIGHT = 1600;

// Write the video's poster frame to outPng. Looks at the first seconds (from
// one second in, past most fade-ins, when the video is long enough) and lets
// ffmpeg's thumbnail filter choose the frame closest to the average of 18
// candidates, so a black or blurred first frame is not chosen.
async function extractPoster(src, info, outPng) {
  const size = fitInside(info.width, info.height, 16384, POSTER_MAX_HEIGHT);
  const start = info.duration && info.duration > 4 ? 1 : 0;
  const scale = [`scale=${size.width}:${size.height}`, 'setsar=1'];
  const attempt = filters => runFfmpeg('ffmpeg', [
    ...UNTRUSTED_INPUT_OPTIONS, '-threads', '1', '-ss', String(start), '-t', '8', '-i', 'file:' + src,
    '-map', '0:' + info.streamIndex, '-an', '-sn', '-dn',
    '-vf', [...pictureFilters(info), ...filters].join(','), '-filter_threads', '1',
    '-frames:v', '1', '-update', '1', '-y', 'file:' + outPng,
  ], { timeoutSeconds: POSTER_TIMEOUT_SECONDS });
  await attempt(['fps=3', ...scale, 'thumbnail=n=18']);
  // A video of a single frame, or one whose first seconds cannot be
  // decoded at that rate, gives the filter nothing to choose from.
  if (!(await isNonEmptyFile(outPng))) await attempt(scale);
  if (!(await isNonEmptyFile(outPng))) throw new FfmpegError('no frame could be decoded', 'exit');
}

async function isNonEmptyFile(file) {
  try { return (await fsp.stat(file)).size > 0; } catch { return false; }
}

// The still the photo pipeline makes a video's renditions from: its poster,
// in a temp file under gg/ that cleanup removes (the rebuild's sweep removes
// it if the server stops first). refusal says why there is no poster, in
// the placeholder record's terms (placeholders.js): 'unreadable' when ffmpeg
// cannot read the file as video, 'failed' when it was killed or timed out.
export async function posterForRenditions(src, thumbDir, name) {
  const posterPath = path.join(thumbDir, name + '.poster.__tmp.png');
  const cleanup = () => fsp.unlink(posterPath).catch(() => {});
  try {
    const info = await probeVideo(src);
    await extractPoster(src, info, posterPath);
    return { source: posterPath, refusal: null, cleanup };
  } catch (e) {
    await cleanup();
    const reason = e.kind === 'exit' ? 'unreadable' : 'failed';
    return { source: null, refusal: { reason, detail: 'video: ' + firstLine(e.message) }, cleanup };
  }
}

function firstLine(message) {
  return String(message).split('\n').find(line => line.trim()) || 'unknown error';
}

// ---------- preview clips ----------

// Preview clips are an intermediate: encoded once, then read by every
// mosaic that holds the video. A clip is the first VIDEO_PREVIEW_SECONDS
// of the video, or its whole seconds when it is shorter (at least one; a
// video shorter than a second loops to fill it): the mosaic loops a short
// clip to fill its length, so a 5-second video costs 5 seconds of clip,
// not 60. CRF 20 is well above what the mosaic keeps.
//
// The mosaic compositor (mosaic_worker.js) cuts whole seconds out of clips
// without decoding what comes before, so a clip has exactly
// clipFrameCount(info) frames, timestamps n/fps from 0, a keyframe at
// every whole second, no B-frames, and its SPS/PPS repeated at every
// keyframe (clips of different sizes are decoded one after the other by
// one decoder).
//
// One working thread each for the decoder, the filters and each tier's
// encoder (the pictures are tiny, and the encoders together use about one
// core): the job counts as 3 units of the CPU budget (cpu_budget.js).
// outputs: [{ tierHeight, width, height, path }], sizes from tileSize.
export function clipSeconds(info) {
  if (!info.duration) return VIDEO_PREVIEW_SECONDS;
  return Math.max(1, Math.min(VIDEO_PREVIEW_SECONDS, Math.floor(info.duration)));
}
export function clipFrameTotal(info) { return clipSeconds(info) * VIDEO_PREVIEW_FPS; }

export async function encodePreviewClips(src, info, outputs, owner) {
  const fps = VIDEO_PREVIEW_FPS;
  const frames = clipFrameTotal(info);
  const skirt = TILE_SKIRT;
  const splits = outputs.map((_, i) => `[s${i}]`).join('');
  const branches = outputs.map((output, i) => {
    const clip = clipSize(output);
    return `[s${i}]scale=${output.width}:${output.height},setsar=1,` +
      `pad=${clip.width}:${clip.height}:${skirt}:${skirt},` +
      `fillborders=left=${skirt}:right=${clip.width - output.width - skirt}:top=${skirt}:` +
      `bottom=${clip.height - output.height - skirt}:mode=smear[o${i}]`;
  });
  // setpts numbers the frames from 0 whatever the source's own start time.
  const graph = `[0:${info.streamIndex}]` +
    [...pictureFilters(info), `fps=${fps}`, `setpts=N/(${fps}*TB)`, `split=${outputs.length}`].join(',') +
    splits + ';' + branches.join(';');
  // The video is read once; if that gives fewer frames than the clip needs
  // (a video shorter than a whole second, or a stated duration that was
  // wrong), it is read again looping. Not looping by default: some
  // containers (FLV, raw streams) cannot seek back to their start.
  for (const loop of [false, true]) {
    const args = [...UNTRUSTED_INPUT_OPTIONS, '-threads', '1', ...(loop ? ['-stream_loop', '-1'] : []), '-i', 'file:' + src,
      '-filter_complex', graph, '-filter_complex_threads', '1'];
    for (const [i, output] of outputs.entries()) {
      args.push('-map', `[o${i}]`, '-frames:v', String(frames), '-an', '-sn', '-dn',
        '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-g', String(fps), '-keyint_min', String(fps), '-sc_threshold', '0', '-bf', '0', '-x264-params', 'repeat-headers=1',
        '-movflags', '+faststart', '-f', 'mp4', '-y', 'file:' + output.path);
    }
    await runFfmpeg('ffmpeg', args, { owner });
    const counts = await Promise.all(outputs.map(output => clipFrameCount(output.path)));
    if (counts.every(count => count === frames)) return;
    if (loop) throw new FfmpegError(`the preview clip has ${Math.min(...counts)} frames, not ${frames}`, 'exit');
  }
}

async function clipFrameCount(file) {
  const out = await runFfmpeg('ffprobe', ['-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', 'file:' + file],
    { captureStdout: true, timeoutSeconds: PROBE_TIMEOUT_SECONDS });
  return Number(out.trim()) || 0;
}

// ---------- the web copy ----------

// Seeking: a browser seeking to time t fetches and decodes from the
// keyframe before t, so the farther apart keyframes are, the longer a seek
// takes, and the more it varies ("sometimes instant, sometimes not"). The
// owner's 2 h film, copied with its own keyframes (up to 10 s apart, 8.2
// Mbit/s), needed up to 10 MB fetched and 240 frames decoded per seek:
// slow on an ordinary internet connection, and decode time on any link.
// So every web copy has a keyframe at least every WEB_KEYFRAME_SECONDS. Measured at CRF 21 against x264's
// default (keyint 250) on real footage, size and an exact seek (decode from
// the keyframe before) in ffmpeg at 20 random points:
//                       default (keyint 250)  every 2 s        every 1 s
//   1080p30 handheld 87 s  196 MB, 1219 ms      +5%,  512 ms     +11%, 392 ms
//   1920x800 film 120 s     59 MB,  240 ms      +6%,  196 ms     +12%, 184 ms
//   1280x534 film 120 s     26 MB,  240 ms      +13%, 151 ms     +27%, 144 ms
//   1024x576 cartoon 120 s  45 MB,  206 ms      +10%, 155 ms     +19%, 148 ms
// The worst case is what makes seeking feel hit or miss, and over a slow
// link it is the bytes from the keyframe that count: one second costs a
// tenth to a quarter more than x264's default and halves the worst case
// of two seconds again.
//
// Encoded with -preset faster: on the film (120 s from its middle, CRF 21,
// a keyframe a second, 6 threads, decoding the source as the server does)
// medium made 66.3 MB at 1.85x real time, faster 65.0 MB at 2.98x,
// veryfast 60.8 MB at 3.94x, with SSIM against the source 0.9815, 0.9821,
// 0.9813: faster is as good as medium at the same size and 1.6 times as
// fast (the 2 h film: about 45 min instead of 70 at CPU budget 16).
export const WEB_KEYFRAME_SECONDS = 1;
const KEYFRAME_OPTIONS = ['-force_key_frames', `expr:gte(t,n_forced*${WEB_KEYFRAME_SECONDS})`, '-forced-idr', '1'];

// A source is copied only when its own keyframes are at most
// COPY_MAX_KEYFRAME_GAP apart (or the video is short, see
// SHORT_VIDEO_SECONDS). The gaps are measured on a sample, not the whole
// file: the keyframe flags of the packets in a few 30-second windows
// spread over the video, which reads those windows (tens of megabytes of
// a film) and decodes nothing.
const COPY_MAX_KEYFRAME_GAP = 2;
const GAP_WINDOWS = 5, GAP_WINDOW_SECONDS = 30;
export async function sampledKeyframeGap(src, info) {
  const duration = info.duration || 0;
  if (!(duration > 0)) return Infinity;
  const starts = [];
  for (let w = 0; w < GAP_WINDOWS; w++) {
    starts.push(Math.max(0, Math.min(duration - GAP_WINDOW_SECONDS, (duration * w) / GAP_WINDOWS)));
  }
  const intervals = [...new Set(starts.map(s => s.toFixed(3)))].map(s => `${s}%+${GAP_WINDOW_SECONDS}`).join(',');
  const out = await runFfmpeg('ffprobe', [...UNTRUSTED_INPUT_OPTIONS, '-v', 'error', '-select_streams', 'v:0',
    '-read_intervals', intervals, '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', 'file:' + src],
    { captureStdout: true, timeoutSeconds: PROBE_TIMEOUT_SECONDS });
  // Per window, the gaps between its keyframes; a window with fewer than
  // two has a gap at least as long as itself. Packets come in decoding
  // order, a frame or a few (B-frames) apart; a jump of more than a second
  // is the next window.
  const windows = [];
  let last = null, current = [];
  for (const line of out.split('\n')) {
    const [time, flags] = line.split(',');
    const t = Number(time);
    if (!line || !Number.isFinite(t) || flags === undefined) continue;
    if (last !== null && Math.abs(t - last) > 1) { windows.push(current); current = []; }
    last = t;
    if (flags.includes('K')) current.push(t);
  }
  windows.push(current);
  let gap = 0;
  for (const keys of windows) {
    if (keys.length < 2) return GAP_WINDOW_SECONDS;
    keys.sort((a, b) => a - b);
    for (let i = 1; i < keys.length; i++) gap = Math.max(gap, keys[i] - keys[i - 1]);
  }
  return gap;
}

// A video stream that is already what the web copy's would be (H.264 8-bit
// 4:2:0 High or lower, at most the web size, square pixels, upright,
// progressive, at most 60 fps, keyframes close enough) is copied into the
// MP4 instead of encoded again: seconds instead of minutes, and no loss.
// Its sound is copied too when it is already AAC stereo, and made AAC
// stereo otherwise (cheap).
function canCopyVideo(info) {
  const size = webCopySize(info);
  return info.codec === 'h264' && info.pixelFormat === 'yuv420p' &&
    ['Baseline', 'Constrained Baseline', 'Main', 'High'].includes(info.profile) &&
    info.squarePixels && info.rotation === 0 && !info.interlaced && !info.hdr &&
    info.width % 2 === 0 && info.height % 2 === 0 &&
    size.width === info.width && size.height === info.height &&
    info.fps !== null && info.fps <= 60;
}
const STEREO_AAC = ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'];
function audioOptions(info, copyIfPossible) {
  if (!info.hasAudio) return ['-an'];
  if (copyIfPossible && info.audioCodec === 'aac' && info.audioChannels === 2) return ['-c:a', 'copy'];
  return STEREO_AAC;
}

// Resolves with 'copied' (the video stream was copied) or 'encoded'.
export async function encodeWebCopy(src, info, outPath, owner) {
  const maps = ['-map', '0:' + info.streamIndex, ...(info.hasAudio ? ['-map', '0:' + info.audioIndex] : [])];
  const common = ['-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn',
    '-movflags', '+faststart', '-max_muxing_queue_size', '4096', '-f', 'mp4', '-y', 'file:' + outPath];
  if (canCopyVideo(info) && (isShortVideo(info) || await sampledKeyframeGap(src, info) <= COPY_MAX_KEYFRAME_GAP)) {
    try {
      await runFfmpeg('ffmpeg', [...UNTRUSTED_INPUT_OPTIONS, '-i', 'file:' + src, ...maps,
        '-c:v', 'copy', ...audioOptions(info, true), ...common], { owner });
      return 'copied';
    } catch (e) {
      if (e.kind !== 'exit') throw e;  // stopped, killed or timed out: not a reason to encode
      // Some files do not remux cleanly (broken timestamps); encode them.
    }
  }
  const size = webCopySize(info);
  const audio = audioOptions(info, false);
  // Threads from the job's share of the CPU budget (cpu_budget.js).
  const share = videoShares().web;
  await runFfmpeg('ffmpeg', [
    ...UNTRUSTED_INPUT_OPTIONS, '-threads', String(share.decoderThreads), '-i', 'file:' + src, ...maps,
    '-vf', [...pictureFilters(info), `scale=${size.width}:${size.height}`, 'setsar=1'].join(','),
    '-filter_threads', String(share.filterThreads),
    '-c:v', 'libx264', '-threads', String(share.encoderThreads), '-profile:v', 'high', '-preset', 'faster', '-crf', '21', '-pix_fmt', 'yuv420p',
    ...KEYFRAME_OPTIONS,
    '-fpsmax', '60', ...audio, ...common,
  ], { owner });
  return 'encoded';
}

// ---------- the record ----------

function recordPath(galleryAbs) {
  return path.join(galleryAbs, GG_DIR, '_videos.json');
}

// The record is kept in memory per folder and written at most every
// RECORD_FLUSH_MS (and at shutdown): a folder of 10,000 videos has a record
// of megabytes, and writing it after each of 10,000 clips would write tens
// of gigabytes. What may be lost in a crash is only news that files were
// made: the record is changed after a file is published, never before, so
// a lost change makes a clip or web copy be made again, and nothing on disk
// is ever taken for made when it is not.
const RECORD_FLUSH_MS = 2000;
const records = new Map();  // galleryAbs -> { record (object or null), dirty, timer }

async function readRecordFile(galleryAbs) {
  try {
    const record = JSON.parse(await fsp.readFile(recordPath(galleryAbs), 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch { return null; }
}

// The folder's record (the caller must not change it; changeVideoRecord
// does), or null when there is none.
export async function readVideoRecord(galleryAbs) {
  const cached = records.get(galleryAbs);
  // A record deleted on disk (rebuild from scratch, by hand) is read anew.
  if (cached && (cached.dirty || fs.existsSync(recordPath(galleryAbs)))) return cached.record;
  const record = await readRecordFile(galleryAbs);
  records.set(galleryAbs, { record, dirty: false, timer: null });
  return record;
}

export function forgetVideoRecord(galleryAbs) {
  const cached = records.get(galleryAbs);
  if (cached && cached.timer) clearTimeout(cached.timer);
  records.delete(galleryAbs);
}

async function writeVideoRecord(galleryAbs, record) {
  const file = recordPath(galleryAbs);
  if (!record || Object.keys(record).length === 0) { await fsp.unlink(file).catch(() => {}); return; }
  await writeFileDurably(file, JSON.stringify(record));
}

async function flushRecord(galleryAbs) {
  const cached = records.get(galleryAbs);
  if (!cached || !cached.dirty) return;
  if (cached.timer) { clearTimeout(cached.timer); cached.timer = null; }
  cached.dirty = false;
  try { await writeVideoRecord(galleryAbs, cached.record); }
  catch (e) {
    // A full disk, a folder gone: keep the news in memory and try again.
    cached.dirty = true;
    console.warn('[video] the record of', JSON.stringify(galleryAbs), 'could not be written:', e.code || e.message);
    if (!cached.timer) cached.timer = setTimeout(() => turnFor(galleryAbs, () => flushRecord(galleryAbs)), 10 * RECORD_FLUSH_MS);
  }
}

// The record's temp file a crash left. Taken in the record's turn, when no
// write of it can be under way.
export function sweepRecordTemp(galleryAbs) {
  return turnFor(galleryAbs, () => fsp.unlink(recordPath(galleryAbs) + '.tmp').catch(() => {}));
}

// Server shutdown: write every record with unwritten changes.
export function flushVideoRecords() {
  return Promise.all([...records.keys()].map(galleryAbs => turnFor(galleryAbs, () => flushRecord(galleryAbs))));
}

// The rebuild and the video work both change the record; each change is a
// read-modify-write that takes its turn, so neither undoes the other.
const recordTurns = new Map();  // galleryAbs -> tail of its chain of changes
function turnFor(galleryAbs, work) {
  const previous = recordTurns.get(galleryAbs) || Promise.resolve();
  const turn = previous.then(work);
  const tail = turn.catch(() => {});
  recordTurns.set(galleryAbs, tail);
  tail.then(() => { if (recordTurns.get(galleryAbs) === tail) recordTurns.delete(galleryAbs); });
  return turn;
}
export function changeVideoRecord(galleryAbs, change) {
  return turnFor(galleryAbs, async () => {
    const record = (await readVideoRecord(galleryAbs)) || {};
    const result = await change(record);
    const cached = records.get(galleryAbs);
    cached.record = record;
    cached.dirty = true;
    if (!cached.timer) cached.timer = setTimeout(() => turnFor(galleryAbs, () => flushRecord(galleryAbs)), RECORD_FLUSH_MS);
    return result;
  });
}

// Does the record describe exactly these videos as they are now? (A folder
// whose record was lost or is behind is rebuilt, which probes again.)
export function videoRecordCurrent(record, videoNames, signatures) {
  if (videoNames.length === 0) return true;
  if (!record) return false;
  return videoNames.every(name => record[name] && record[name].signature === signatures[name]);
}

// Bring the record up to date with the folder's videos: probe the new and
// changed ones (a few at a time; a probe reads only the header), delete the
// clips and web copy of a changed one, forget the ones that are gone.
// retryFailures (an admin's rescan): also forget why clips or web copies
// could not be made, so they are tried again.
const PROBES_AT_ONCE = 4;
export function refreshVideoRecord(galleryAbs, videoNames, signatures, { retryFailures = false } = {}) {
  return changeVideoRecord(galleryAbs, async record => {
    const thumbDir = path.join(galleryAbs, GG_DIR);
    const current = new Set(videoNames);
    for (const name of Object.keys(record)) if (!current.has(name)) delete record[name];
    const toProbe = [];
    for (const name of videoNames) {
      const entry = record[name];
      if (entry && entry.signature === signatures[name]) {
        if (retryFailures) {
          clearFailure(entry, 'clips');
          clearFailure(entry, 'web');
          clearFailure(entry, 'storyboard');
          // A probe that was killed or timed out may work now.
          if (!entry.info && entry.errorKind !== 'exit') toProbe.push(name);
        }
        continue;
      }
      if (entry) await deleteDerivedVideoFiles(thumbDir, name);
      toProbe.push(name);
    }
    let next = 0;
    async function probeLane() {
      while (next < toProbe.length) {
        const name = toProbe[next++];
        try {
          record[name] = { signature: signatures[name], info: await probeVideo(path.join(galleryAbs, name)) };
        } catch (e) {
          record[name] = { signature: signatures[name], info: null, error: firstLine(e.message), errorKind: e.kind };
        }
      }
    }
    await Promise.all(Array.from({ length: PROBES_AT_ONCE }, probeLane));
    return record;
  });
}

// ---------- failures that go away ----------

// A failure caused by the machine rather than the file: the system out of
// tasks (pthread_create), memory or disk, or ffmpeg killed by a signal or
// not started. Such a video is tried again by itself, later and later
// (VIDEO_RETRY_SECONDS, 5 minutes, doubling, at most 6 hours apart, 8
// times); a failure of the
// file itself waits for a rescan or a change of the file. Records of
// earlier versions have only the message, which is enough to tell.
const TRANSIENT_FAILURE = /resource temporarily unavailable|pthread_create|cannot allocate memory|out of memory|no space left on device|too many open files|was killed|could not be started/i;
const RETRY_FIRST_MS = VIDEO_RETRY_SECONDS * 1000;
const RETRY_LONGEST_MS = 6 * 60 * 60 * 1000;
const RETRY_ATTEMPTS = 8;

export function isTransientFailure(message) {
  return TRANSIENT_FAILURE.test(String(message || ''));
}

// Record a failure of `field` ('clips' or 'web') in an entry.
// The rule the failed work was tried under: a failure under an earlier
// rule says nothing about making it the current way, so such work is
// tried again (once, then judged as usual).
const ruleOf = field => (field === 'clips' ? CLIP_RULE : field === 'web' ? WEB_RULE : STORYBOARD_RULE);

export function recordFailure(entry, field, error) {
  entry[field + 'Error'] = String(error.message || error).split('\n')[0];
  entry[field + 'Failures'] = (entry[field + 'Failures'] || 0) + 1;
  entry[field + 'FailedAt'] = Date.now();
  entry[field + 'FailedRule'] = ruleOf(field);
}
export function clearFailure(entry, field) {
  delete entry[field + 'Error'];
  delete entry[field + 'Failures'];
  delete entry[field + 'FailedAt'];
  delete entry[field + 'FailedRule'];
}

// When the failed work may be tried again: 0 (now), a time, or Infinity
// (only on a rescan or a change of the file).
export function failureRetryAt(entry, field) {
  const message = entry[field + 'Error'];
  if (!message) return 0;
  if (entry[field + 'FailedRule'] !== ruleOf(field)) return 0;
  if (!isTransientFailure(message)) return Infinity;
  const failures = entry[field + 'Failures'] || 1;
  if (failures > RETRY_ATTEMPTS) return Infinity;
  const wait = Math.min(RETRY_LONGEST_MS, RETRY_FIRST_MS * 2 ** (failures - 1));
  return (entry[field + 'FailedAt'] || 0) + wait;
}

// An admin's rescan: forget why preview clips or web copies could not be
// made, so the video work tries them again.
export async function forgetVideoFailures(galleryAbs) {
  const record = await readVideoRecord(galleryAbs);
  if (!record || !Object.values(record).some(entry => entry && (entry.clipsError || entry.webError || entry.storyboardError))) return;
  await changeVideoRecord(galleryAbs, current => {
    for (const entry of Object.values(current)) {
      clearFailure(entry, 'clips');
      clearFailure(entry, 'web');
      clearFailure(entry, 'storyboard');
    }
  });
}

// The manifest's view of the folder's videos: { "<name>": { duration, web,
// hasAudio, width, height, storyboard } } for every video ffmpeg can read.
// web is the web copy's file name in gg/, or null until it is made;
// storyboard is described in storyboard.js (null until made, or none).
export function manifestVideos(record, names) {
  const videos = {};
  for (const name of names) {
    if (!isVideo(name)) continue;
    const entry = record && record[name];
    if (!entry || !entry.info) continue;
    videos[name] = {
      duration: entry.info.duration,
      web: webCopyIsCurrent(entry) ? webCopyName(name) : null,
      hasAudio: entry.info.hasAudio,
      width: entry.info.width,
      height: entry.info.height,
      storyboard: manifestStoryboard(name, entry),
    };
  }
  return videos;
}

// The rule a tier's clip was made by, or null. (Records of earlier
// versions name their clips in one "clips" string; those clips were made
// before every clip had a keyframe each second, and count as missing.)
function clipTierRule(entry, tierHeight) {
  return (entry.clipTiers && entry.clipTiers[tierHeight]) || null;
}
function clipTierIsCurrent(entry, tierHeight) {
  return clipTierRule(entry, tierHeight) === entry.signature + '|' + CLIP_RULE;
}
// The tiers (of the video's tiers, video_atlas.js videoTierHeights) whose
// clip of this video is not made (yet).
export function missingClipTiers(entry, tierHeights) {
  return tierHeights.filter(tierHeight => !entry || !clipTierIsCurrent(entry, tierHeight));
}
export function clipsAreCurrent(entry, tierHeights) {
  return !!entry && missingClipTiers(entry, tierHeights).length === 0;
}
// Record that these tiers' clips are made for the entry's signature (and
// keep the record of its other tiers that are still current).
export function recordClipTiers(entry, tierHeights) {
  const clipTiers = {};
  for (const h of VIDEO_TIERS) if (clipTierIsCurrent(entry, h)) clipTiers[h] = entry.signature + '|' + CLIP_RULE;
  for (const h of tierHeights) clipTiers[h] = entry.signature + '|' + CLIP_RULE;
  entry.clipTiers = clipTiers;
  delete entry.clips;
}
export function webCopyIsCurrent(entry) {
  if (!entry) return false;
  if (entry.web === entry.signature + '|' + WEB_RULE) return true;
  return entry.web === entry.signature + '|' + WEB_RULE_BEFORE_KEYFRAMES && isShortVideo(entry.info);
}
function isShortVideo(info) {
  return !!info && info.duration !== null && info.duration !== undefined && info.duration <= SHORT_VIDEO_SECONDS;
}

// ---------- deleting ----------

export async function deleteDerivedVideoFiles(thumbDir, name) {
  const files = [webCopyName(name), ...VIDEO_TIERS.map(h => path.basename(clipPath(thumbDir, name, h))),
    ...Array.from({ length: 10 }, (_, k) => storyboardSheetName(name, k))];
  for (const file of files) await fsp.unlink(path.join(thumbDir, file)).catch(() => {});
}

// Remove clips and web copies whose video is gone (deleted, trashed, renamed)
// and every clip of a tier no longer in VIDEO_TIERS, or one the video has
// no tile in. tiersOf(name): the video's tier heights.
export async function sweepOrphanVideoFiles(thumbDir, videoNames, tiersOf = () => VIDEO_TIERS) {
  const names = new Set(videoNames);
  let dir;
  try { dir = await fsp.opendir(thumbDir, { bufferSize: 1024 }); } catch { return; }
  for await (const entry of dir) {
    const sheet = STORYBOARD_FILE.exec(entry.name);
    if (sheet) {
      if (!names.has(sheet[1])) await fsp.unlink(path.join(thumbDir, entry.name)).catch(() => {});
      continue;
    }
    const match = DERIVED_VIDEO_FILE.exec(entry.name);
    if (!match) continue;
    const orphan = !names.has(match[1]) || (match[2] !== 'web' && !tiersOf(match[1]).map(h => 'v' + h).includes(match[2]));
    if (orphan) await fsp.unlink(path.join(thumbDir, entry.name)).catch(() => {});
  }
}

// Remove the temp files of video work that is not running (a server stopped
// mid-encode leaves them). inUse: absolute paths still being written.
export async function sweepVideoTemps(thumbDir, inUse) {
  let dir;
  try { dir = await fsp.opendir(thumbDir, { bufferSize: 1024 }); } catch { return 0; }
  let removed = 0;
  for await (const entry of dir) {
    const file = path.join(thumbDir, entry.name);
    if (!isVideoTemp(entry.name)) continue;
    if (inUse.has(file)) continue;
    // A storyboard's frame directory is a temp too (storyboard.js).
    await fsp.rm(file, { recursive: true, force: true }).then(() => removed++, () => {});
  }
  return removed;
}
