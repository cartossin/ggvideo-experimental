// The first-frame still of a video: the first picture of its web copy, as
// one AVIF image the size of the web copy, so the photo view and the
// player can show exactly what the video element shows at currentTime 0
// until the video has a frame of its own.
//
// The poster (videos.js extractPoster) is not that picture: it is a frame
// chosen to stand for the video in the grid, from its first seconds and
// usually not the first. Shown large and then replaced by the video
// starting from 0, it gave away a moment of the video before it played.
// The grid keeps the poster; only the large views use this still.
//
// ============================== THE CONTRACT ==============================
// manifest.videos[name].firstFrame is null (not made yet: the viewer shows
// the poster, as before there were first-frame stills) or
//   { "file": "<name>.first.avif", "version": V }
// file is in the folder's gg/, served like the web copy (URL: the folder's
// URL + "gg/" + file); with ?v=V in the URL the server lets browsers and a
// CDN keep it for good, and a still made again has another version.
// The still is the web copy's first decoded picture (presentation order),
// at the web copy's size; it is made from the web copy named by the same
// manifest entry, and is null while that copy is not made.
// =========================================================================
//
// Making one is a single ffmpeg: the web copy is decoded up to its first
// picture, and that picture is encoded by libaom as an AVIF still. The
// picture stays in the web copy's own YUV (no round trip through RGB); the
// still is labelled with the colour description the browser shows the
// video by (stillColourLabel), so both come out the same colours. Measured
// on single frames (one thread): 1080p 1.1 to 1.5 s and 53 to 265 KB, 480p
// 0.25 s and 6 to 22 KB; SSIM 0.985 to 0.995 against the web copy's own
// picture, which is at the web copy's own quality (CRF 21).

import fsp from 'fs/promises';
import path from 'path';
import { publish } from './durable.js';
import { UNTRUSTED_INPUT_OPTIONS, runFfmpeg } from './ffmpeg.js';
import { VIDEO_TEMP_MARK, webCopyName } from './videos.js';

// libaom's all-intra mode at CRF 18: a still as good as the video's own
// picture (above), at the speed setting it was measured with.
const STILL_CRF = 18;
const STILL_CPU_USED = 6;
export const FIRST_FRAME_RULE = `f1:crf${STILL_CRF}:cpu${STILL_CPU_USED}:c1`;

// The colours the browser shows the video in. Measured with web copies of
// pure green and of a test pattern, made with one matrix and labelled
// every way, against AVIF stills labelled every way, on screen in Chrome on
// macOS (hardware decoding) and in headless Chromium on Linux (software
// decoding). A video is shown:
//   - labelled in full (matrix, primaries and transfer): by its label, its
//     colours converted from its primaries (a PAL label turned pure green
//     bluish);
//   - labelled with the BT.709 or the SMPTE 170M matrix alone: in that
//     standard, BT.709 or BT.601 (SMPTE 170M matrix, primaries and
//     transfer); headless Chromium alone ignores such a label and goes by
//     the height, as below; Chrome on macOS, the browser that matters
//     here, does not;
//   - labelled with any other matrix alone (BT.470BG), or with nothing: as
//     BT.601 under 720 lines and as BT.709 from 720 on (Chromium's
//     long-standing rule for SD and HD video).
// An AVIF is shown by what it names, with no such rule. So the still is
// labelled in full with what the video is shown by. Labelled so, every
// BT.601 and PAL case matched to the level; BT.709 ones were up to 10
// levels apart in one channel of pure green and 2 to 4 on average over a
// test pattern, which the still's coding accounts for (at CRF 4 the same
// label matched to the level). ("c1" in the rule.)
const STANDARD_OF_MATRIX = { bt709: 'bt709', smpte170m: 'smpte170m' };
const isNamed = value => !!value && value !== 'unknown' && value !== 'reserved';
function labelledInFull(stream) {
  return isNamed(stream.color_space) && isNamed(stream.color_primaries) && isNamed(stream.color_transfer);
}
// The setparams filter that labels the still, or null when the picture's
// own label stays. setparams only relabels; no pixel is changed, and the
// range (limited or full) stays the picture's.
export function stillColourLabel(stream) {
  if (labelledInFull(stream)) return null;
  const standard = STANDARD_OF_MATRIX[stream.color_space] || (stream.height < 720 ? 'smpte170m' : 'bt709');
  return `setparams=colorspace=${standard}:color_primaries=${standard}:color_trc=${standard}`;
}

async function webCopyColour(web) {
  const out = await runFfmpeg('ffprobe', [...UNTRUSTED_INPUT_OPTIONS, '-select_streams', 'v:0',
    '-show_entries', 'stream=height,color_space,color_primaries,color_transfer', '-of', 'json', 'file:' + web],
  { captureStdout: true, timeoutSeconds: 60 });
  const stream = (JSON.parse(out).streams || [])[0];
  if (!stream || !(stream.height > 0)) throw new Error('the web copy has no picture to take');
  return stream;
}

// "<name>.first.avif", and while it is made "<name>.first.__vtmp.avif":
// at most 18 bytes longer than the video's name (videos.js allows 21).
export const FIRST_FRAME_FILE = /^(.+)\.first\.avif$/;
export function firstFrameName(name) { return name + '.first.avif'; }
function firstFrameTempPath(thumbDir, name) { return path.join(thumbDir, name + '.first' + VIDEO_TEMP_MARK + 'avif'); }

// What a still made now from the entry's web copy records: the video's
// signature, the rule, and which web copy it came from (as for a
// storyboard, storyboard.js storyboardMadeFor). A web copy made again makes
// the still out of date until it is made again from the new copy.
export function firstFrameMadeFor(entry) {
  return `${entry.signature}|${FIRST_FRAME_RULE}|${entry.web || ''}@${entry.webMadeAt || 0}`;
}

export function firstFrameIsCurrent(entry) {
  return !!entry && !!entry.web && !!entry.firstFrame && entry.firstFrame.made === firstFrameMadeFor(entry);
}

// What the manifest says (the contract above), or null.
export function manifestFirstFrame(name, entry) {
  if (!firstFrameIsCurrent(entry)) return null;
  return { file: firstFrameName(name), version: (entry.firstFrame.madeAt || 0).toString(36) };
}

export function sameManifestFirstFrame(a, b) {
  if (!a || !b) return !a && !b;
  return a.file === b.file && a.version === b.version;
}

// Make the still of a video from its web copy in thumbDir: written under
// its temp name (swept if the server dies; trackTemp spares it meanwhile),
// then published (durable.js). The caller records it.
// One decoder thread, then one encoder thread: one unit of the CPU budget.
export async function makeFirstFrame(thumbDir, name, owner, trackTemp) {
  const web = path.join(thumbDir, webCopyName(name));
  const temp = firstFrameTempPath(thumbDir, name);
  trackTemp(temp, true);
  try {
    const label = stillColourLabel(await webCopyColour(web));
    await runFfmpeg('ffmpeg', [...UNTRUSTED_INPUT_OPTIONS, '-threads', '1', '-i', 'file:' + web,
      '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', ...(label ? ['-vf', label, '-filter_threads', '1'] : []),
      '-c:v', 'libaom-av1', '-usage', 'allintra', '-still-picture', '1', '-crf', String(STILL_CRF),
      '-cpu-used', String(STILL_CPU_USED), '-threads', '1', '-f', 'avif', '-y', 'file:' + temp], { owner });
    const size = (await fsp.stat(temp)).size;
    if (size === 0) throw new Error('no picture came out of the web copy');
    await publish(temp, path.join(thumbDir, firstFrameName(name)));
    return size;
  } finally {
    trackTemp(temp, false);
    await fsp.unlink(temp).catch(() => {});
  }
}
