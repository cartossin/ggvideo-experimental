// Storyboards: frames sampled across a whole video, packed in sprite
// sheets, so the player can show the picture under the cursor while the
// seek bar is hovered or dragged, before (and without) seeking.
//
// ============================== THE CONTRACT ==============================
// What the viewer (public/gallery.js) codes against.
//
// manifest.videos[name].storyboard is null (none yet, or none for this
// video: see below) or
//   {
//     "interval": I,       seconds between frames (a whole number, >= 1)
//     "count": N,          frames, about I apart (see times)
//     "width": W,          pixel size of every frame (the video's displayed
//     "height": H,         aspect, W even; H is STORYBOARD_HEIGHT, or the
//                          web copy's height if that is smaller)
//     "columns": C,        frames per row of a sheet
//     "rows": R,           rows per sheet (the last sheet may have fewer)
//     "version": V,        changes when the storyboard is made again; the
//                          viewer asks for sheets as <file>?v=V, which the
//                          server lets browsers and a CDN keep for good
//     "sheets": ["<name>.sb0.avif", ...]
//                          AVIF images in the folder's gg/, served like the
//                          web copy (URL: the folder's URL + "gg/" + file)
//     "times": "<name>.sb.json"
//                          in gg/ too, served the same way: { "times":
//                          [t0, t1, ... t(N-1)] }, the time in seconds (to
//                          the microsecond) of each frame's picture in the
//                          web copy, as the browser's currentTime counts
//                          and requestVideoFrameCallback reports it
//   }
// Frame i (0 <= i < N) is in sheets[floor(i / (C * R))], at column
// i % C and row floor(i / C) % R, so its rectangle is x = column * W,
// y = row * H, W x H. A sheet is C * W by at most R * H pixels; frames
// after the last are absent (the sheet is shorter), never stretched.
//
// Frame i is the web copy's picture at times[i], exactly. Frame 0 is the
// first picture; frame i + 1 is the first after frame i at or after the
// next multiple of I: k * I with k = floor(times[i] / I) + 1. So the times
// increase, about I apart, and a stretch with no candidate (keyframes
// farther apart than I) is skipped, not filled with copies. For a video
// over SHORT_VIDEO_SECONDS the candidates are the keyframes only: every
// web copy of such a video has one each second (copied ones every two;
// videos.js WEB_KEYFRAME_SECONDS), so a seek to times[i] decodes that
// one frame. Shorter ones use every frame (their web copy may be copied
// with keyframes far apart). The viewer lets the seek bar rest only on
// these times. The times are in a file of their own, not the manifest: a
// folder of 10,000 long videos would add up to 10 million numbers to the
// manifest every visitor loads; the file is fetched when a player opens.
//
// Videos shorter than STORYBOARD_MIN_SECONDS have none (null): their seek
// bar is a few centimetres a second, and their web copy is small enough
// that a seek is quick anyway; that leaves out the thousands of 20 s clips
// of the scale test folders. A storyboard is made after the video's web
// copy (from it), in the video queue after every web copy.
// =========================================================================
//
// Why these numbers (measured, see the commit):
//   frames  one per second up to STORYBOARD_MAX_FRAMES (1,000), then the
//           interval grows to keep 1,000 at most: a seek bar is rarely
//           more than 1,000 to 2,000 device pixels wide, so more frames
//           than that show nothing new. A 2 h film: a frame every 8 s,
//           987 frames, 10 sheets.
//   height  STORYBOARD_HEIGHT 160 (284x160 for 16:9): a scene is
//           recognisable in a hover bubble or over the player while
//           dragging, and stays sharp at 80 CSS pixels on a 2x screen.
//           Measured on the 2 h film (987 frames, AVIF Q50): 3.2 MB at
//           h160 (3.2 KB a frame), 1.5 MB at h90; one size, as a second,
//           larger one would mostly be seen for the moment of a drag.
//   sheets  10 x 10 frames: the viewer fetches the sheet under the cursor
//           (one request per 100 frames), not the whole storyboard.
//   making  the web copy decoded at its keyframes only (-skip_frame nokey):
//           for a video longer than a minute every web copy has a keyframe
//           at least every second (or two, copied), so every frame is a
//           keyframe, and the other frames are never decoded. Measured on the 2 h film's 8 GB copy: keyframes
//           only 56 s (reading the file is most of it), every frame
//           decoded about 28 min, one seek per sample 0.54 s each, 9 min;
//           a 12 min 720p film 6 s. With the sheets (AVIF, one vips
//           thread): the film 80 s and 2.9 MB, the 720p film 29 s and
//           4.0 MB. Shorter videos (from
//           STORYBOARD_MIN_SECONDS to a minute) are decoded whole, which is
//           cheap (a 20 s 480p clip: 0.8 s), as their web copy may have
//           keyframes 10 s apart.

import fsp from 'fs/promises';
import path from 'path';
import { runFfmpeg, UNTRUSTED_INPUT_OPTIONS } from './ffmpeg.js';
import { publish } from './durable.js';
import { runStep } from './vips.js';
import { SHORT_VIDEO_SECONDS, VIDEO_TEMP_MARK, webCopyName, webCopySize } from './videos.js';

export const STORYBOARD_MIN_SECONDS = 30;
export const STORYBOARD_MAX_FRAMES = 1000;
export const STORYBOARD_HEIGHT = 160;
const COLUMNS = 10, ROWS = 10;
// AVIF Q50 at effort 2: on a 3840x1600 sheet of 100 frames effort 2 was
// the smallest (409 KB against 430 KB at 0 and 429 KB at 4) and took 0.6 s
// (effort 4: 1.9 s; vips with all threads).
const AVIF_QUALITY = 50, AVIF_EFFORT = 2;
// Every file name here is at most 21 bytes longer than the video's
// (videos.js): "<name>.sb.__vtmp.d" (the frame directory),
// "<name>.sb9.avif" and "<name>.sb.json". At most 1,000 frames of 100 a
// sheet keeps the sheet index one digit.
// s2: frames at recorded times, the first at or after each multiple of
// the interval (s1: the last at or before, at times not recorded).
export const STORYBOARD_RULE = `s2:${STORYBOARD_HEIGHT}:${STORYBOARD_MAX_FRAMES}:${COLUMNS}x${ROWS}:q${AVIF_QUALITY}e${AVIF_EFFORT}`;
export const STORYBOARD_FILE = /^(.+)\.sb(\d)\.avif$/;
export const STORYBOARD_TIMES_FILE = /^(.+)\.sb\.json$/;
export function storyboardSheetName(name, index) { return `${name}.sb${index}.avif`; }
export function storyboardTimesName(name) { return `${name}.sb.json`; }
// Every file of a video's storyboard that can exist.
export function storyboardFileNames(name) {
  return [...Array.from({ length: 10 }, (_, k) => storyboardSheetName(name, k)), storyboardTimesName(name)];
}

export function wantsStoryboard(info) {
  return !!info && typeof info.duration === 'number' && info.duration >= STORYBOARD_MIN_SECONDS;
}

// The plan for a video: interval, count, frame size.
export function storyboardPlan(info) {
  const interval = Math.max(1, Math.ceil(info.duration / STORYBOARD_MAX_FRAMES));
  // Frames at 0, I, 2I, ... strictly before the end.
  const count = Math.max(1, Math.ceil(info.duration / interval - 1e-6));
  const web = webCopySize(info);
  const height = Math.min(STORYBOARD_HEIGHT, web.height - (web.height % 2));
  const width = Math.max(2, 2 * Math.round((height * web.width / web.height) / 2));
  return { interval, count, width, height, columns: COLUMNS, rows: ROWS, sheets: Math.ceil(count / (COLUMNS * ROWS)) };
}

// What a storyboard made now from the entry's web copy records: the
// video's signature, the storyboard rule, and which web copy it was made
// from (the web rule it was made under and when it was made), since the
// frames are that copy's keyframes. A web copy made again, under a new
// rule or because it was lost, makes the storyboard out of date.
export function storyboardMadeFor(entry) {
  return `${entry.signature}|${STORYBOARD_RULE}|${entry.web || ''}@${entry.webMadeAt || 0}`;
}

// The record's storyboard is current: made from the video's present web copy?
export function storyboardIsCurrent(entry) {
  return !!entry && !!entry.web && !!entry.storyboard && entry.storyboard.made === storyboardMadeFor(entry);
}

// What the manifest says (the contract above), or null.
export function manifestStoryboard(name, entry) {
  if (!storyboardIsCurrent(entry)) return null;
  const { interval, count, width, height, columns, rows, sheets, madeAt } = entry.storyboard;
  return { interval, count, width, height, columns, rows, version: (madeAt || 0).toString(36),
    sheets: Array.from({ length: sheets }, (_, k) => storyboardSheetName(name, k)), times: storyboardTimesName(name) };
}

// Make the storyboard of a video from its web copy in thumbDir. Frames go
// to a temp directory (swept if the server dies), each sheet and the times
// file to a temp name there and are published (durable.js) only when
// complete, the times last; the caller records the storyboard after all
// are. Resolves with the plan.
//
// ffmpeg and vips run in the frame directory and are given only names we
// chose there (f0000.png ..., times.txt, sheet.avif), never the folder's
// or the video's: vips arrayjoin splits its list of inputs at spaces and
// reads options from [...] after a file name, and ffmpeg's image2 output
// reads % in its path as a pattern. Only the web copy is named by its
// path, as ffmpeg input (file:, which takes any name). Each file is then
// moved to its real name by our own code.
export async function makeStoryboard(thumbDir, name, info, owner, trackTemp) {
  const plan = storyboardPlan(info);
  const web = path.join(thumbDir, webCopyName(name));
  const frameDir = path.join(thumbDir, name + '.sb' + VIDEO_TEMP_MARK + 'd');
  trackTemp(frameDir, true);
  try {
    await fsp.rm(frameDir, { recursive: true, force: true });
    await fsp.mkdir(frameDir);
    await extractFrames(web, plan, info.duration > SHORT_VIDEO_SECONDS, owner, frameDir);
    const frames = (await fsp.readdir(frameDir)).filter(f => /^f\d{4}\.png$/.test(f)).sort();
    const times = frameTimes(await fsp.readFile(path.join(frameDir, 'times.txt'), 'utf8'));
    if (frames.length === 0) throw new Error('no frames came out of the web copy');
    if (times.length !== frames.length) throw new Error(`${frames.length} frames but ${times.length} times came out of the web copy`);
    // A video's duration in its header can be a little longer than its
    // frames, and a stretch without keyframes has no frame: the storyboard
    // has the frames there are.
    plan.count = frames.length;
    plan.sheets = Math.ceil(plan.count / (COLUMNS * ROWS));
    for (let k = 0; k < plan.sheets; k++) {
      const members = frames.slice(k * COLUMNS * ROWS, (k + 1) * COLUMNS * ROWS);
      const sheet = path.join(frameDir, 'sheet.avif');
      await runStep('vips', ['arrayjoin', members.join(' '), `sheet.avif[Q=${AVIF_QUALITY},compression=av1,effort=${AVIF_EFFORT}]`,
        '--across', String(COLUMNS)], sheet, { cwd: frameDir });
      await publish(sheet, path.join(thumbDir, storyboardSheetName(name, k)));
    }
    const timesFile = path.join(frameDir, 'times.json');
    await fsp.writeFile(timesFile, JSON.stringify({ times }));
    await publish(timesFile, path.join(thumbDir, storyboardTimesName(name)));
    // Sheets of an earlier storyboard of more sheets are left over.
    for (let k = plan.sheets; k < 10; k++) await fsp.unlink(path.join(thumbDir, storyboardSheetName(name, k))).catch(() => {});
    return plan;
  } finally {
    trackTemp(frameDir, false);
    await fsp.rm(frameDir, { recursive: true, force: true }).catch(() => {});
  }
}

// The storyboard's frames, f0000.png ..., and their times, times.txt, in
// frameDir. select keeps a frame when it is the first (prev_selected_t is
// NAN) or at or after the multiple of the interval that follows the last
// kept one (see the contract); with -skip_frame nokey only keyframes are
// decoded and can be kept. The kept frames go two ways: scaled to PNG
// files, and to a framecrc listing, which gives each one's timestamp as a
// whole number in a time base it names (#tb), exact; -enc_time_base filter
// keeps the decoder's timestamps instead of rounding them to a frame rate,
// and -fps_mode passthrough writes each kept frame once, none added.
// -frames:v keeps at most count (a header's duration can be short).
async function extractFrames(web, plan, keyframesOnly, owner, frameDir) {
  const I = plan.interval;
  const select = `select='isnan(prev_selected_t)+gte(t\\,${I}*(floor(prev_selected_t/${I})+1))'`;
  const each = ['-fps_mode', 'passthrough', '-frames:v', String(plan.count)];
  await runFfmpeg('ffmpeg', [...UNTRUSTED_INPUT_OPTIONS, '-threads', '1', ...(keyframesOnly ? ['-skip_frame', 'nokey'] : []),
    '-i', 'file:' + web, '-an', '-sn', '-dn', '-filter_complex_threads', '1',
    '-filter_complex', `[0:v:0]${select},scale=${plan.width}:${plan.height}:flags=bicubic,setsar=1,split=2[pictures][times]`,
    '-map', '[pictures]', ...each, '-start_number', '0', '-f', 'image2', 'f%04d.png',
    '-map', '[times]', ...each, '-enc_time_base', 'filter', '-c:v', 'rawvideo', '-f', 'framecrc', 'times.txt'], { owner, cwd: frameDir });
}

// The times in seconds, to the microsecond, of the frames of a framecrc
// listing: "#tb 0: <num>/<den>", then one "0, <pts>, <dts>, ..." line per
// frame.
export function frameTimes(listing) {
  const base = /^#tb 0: (\d+)\/(\d+)$/m.exec(listing);
  if (!base) throw new Error('the frame listing names no time base');
  const [num, den] = [Number(base[1]), Number(base[2])];
  const times = [];
  for (const line of listing.split('\n')) {
    const match = /^0,\s*(-?\d+),/.exec(line);
    if (match) times.push(Math.round(Number(match[1]) * num * 1e6 / den) / 1e6);
  }
  return times;
}
