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
//     "count": N,          frames, at times 0, I, 2I, ... (N-1)I
//     "width": W,          pixel size of every frame (the video's displayed
//     "height": H,         aspect, W even; H is STORYBOARD_HEIGHT, or the
//                          web copy's height if that is smaller)
//     "columns": C,        frames per row of a sheet
//     "rows": R,           rows per sheet (the last sheet may have fewer)
//     "sheets": ["<name>.sb0.avif", ...]
//                          AVIF images in the folder's gg/, served like the
//                          web copy (URL: the folder's URL + "gg/" + file)
//   }
// Frame i (0 <= i < N) is in sheets[floor(i / (C * R))], at column
// i % C and row floor(i / C) % R, so its rectangle is x = column * W,
// y = row * H, W x H. For time t, frame round(t / I) clamped to N - 1
// is the nearest. Frame i is the web copy's picture at time i * I (to
// within a second: the web copy's keyframe at or before it, and every web
// copy of a video this long has one at least every second, copied ones
// every two; see videos.js WEB_KEYFRAME_SECONDS). A sheet is C * W by at
// most R * H pixels; frames after the last are absent (the sheet is
// shorter), never stretched.
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
//           at least every second (or two, copied), so the frame at or
//           before each sample time is a keyframe, and the other frames are
//           never decoded. Measured on the 2 h film's 8 GB copy: keyframes
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
// (videos.js): "<name>.sb.__vtmp.d" (the frame directory) and
// "<name>.sb9.avif". At most 1,000 frames of 100 a sheet keeps the sheet
// index one digit.
export const STORYBOARD_RULE = `s1:${STORYBOARD_HEIGHT}:${STORYBOARD_MAX_FRAMES}:${COLUMNS}x${ROWS}:q${AVIF_QUALITY}e${AVIF_EFFORT}`;
export const STORYBOARD_FILE = /^(.+)\.sb(\d)\.avif$/;
export function storyboardSheetName(name, index) { return `${name}.sb${index}.avif`; }

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
  const { interval, count, width, height, columns, rows, sheets } = entry.storyboard;
  return { interval, count, width, height, columns, rows, sheets: Array.from({ length: sheets }, (_, k) => storyboardSheetName(name, k)) };
}

// Make the storyboard of a video from its web copy in thumbDir. Frames go
// to a temp directory (swept if the server dies), each sheet to a temp
// name and is published (durable.js) only when complete; the caller
// records it after all are. Resolves with the plan.
//
// ffmpeg and vips run in the frame directory and are given only names we
// chose there (f0000.png ..., sheet.avif), never the folder's or the
// video's: vips arrayjoin splits its list of inputs at spaces and reads
// options from [...] after a file name, and ffmpeg's image2 output reads
// % in its path as a pattern. Only the web copy is named by its path, as
// ffmpeg input (file:, which takes any name). Each sheet is then moved to
// its real name by our own code.
export async function makeStoryboard(thumbDir, name, info, owner, trackTemp) {
  const plan = storyboardPlan(info);
  const web = path.join(thumbDir, webCopyName(name));
  const frameDir = path.join(thumbDir, name + '.sb' + VIDEO_TEMP_MARK + 'd');
  trackTemp(frameDir, true);
  try {
    await fsp.rm(frameDir, { recursive: true, force: true });
    await fsp.mkdir(frameDir);
    const keyframesOnly = info.duration > SHORT_VIDEO_SECONDS;
    // fps=1/I with round=down: frame k is the last decoded frame at or
    // before k * I; -frames:v keeps exactly count of them.
    await runFfmpeg('ffmpeg', [...UNTRUSTED_INPUT_OPTIONS, '-threads', '1', ...(keyframesOnly ? ['-skip_frame', 'nokey'] : []),
      '-i', 'file:' + web, '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', `fps=1/${plan.interval}:round=down,scale=${plan.width}:${plan.height}:flags=bicubic,setsar=1`, '-filter_threads', '1',
      '-frames:v', String(plan.count), '-start_number', '0', '-f', 'image2', 'f%04d.png'], { owner, cwd: frameDir });
    const frames = (await fsp.readdir(frameDir)).filter(f => /^f\d{4}\.png$/.test(f)).sort();
    if (frames.length === 0) throw new Error('no frames came out of the web copy');
    // A video's duration in its header can be a little longer than its
    // frames: the storyboard has the frames there are.
    plan.count = frames.length;
    plan.sheets = Math.ceil(plan.count / (COLUMNS * ROWS));
    for (let k = 0; k < plan.sheets; k++) {
      const members = frames.slice(k * COLUMNS * ROWS, (k + 1) * COLUMNS * ROWS);
      const sheet = path.join(frameDir, 'sheet.avif');
      await runStep('vips', ['arrayjoin', members.join(' '), `sheet.avif[Q=${AVIF_QUALITY},compression=av1,effort=${AVIF_EFFORT}]`,
        '--across', String(COLUMNS)], sheet, { cwd: frameDir });
      await publish(sheet, path.join(thumbDir, storyboardSheetName(name, k)));
    }
    // Sheets of an earlier storyboard of more sheets are left over.
    for (let k = plan.sheets; k < 10; k++) await fsp.unlink(path.join(thumbDir, storyboardSheetName(name, k))).catch(() => {});
    return plan;
  } finally {
    trackTemp(frameDir, false);
    await fsp.rm(frameDir, { recursive: true, force: true }).catch(() => {});
  }
}
