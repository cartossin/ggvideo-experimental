// Writing video files so that a crash, a kill -9 or a power cut at any
// moment leaves either the old file or the complete new one under the
// final name, never a part of one.
//
// Everything is written under a temp name first (by us or by ffmpeg), then
// published: the temp file's data is flushed to disk (fsync), it is renamed
// to its final name (atomic on POSIX filesystems), and the directory is
// flushed so the rename itself survives a power cut. A temp file a crash
// leaves behind is swept later (videos.js sweepVideoTemps, atlas building
// directories by video_atlas.js).

import fsp from 'fs/promises';
import path from 'path';

export async function fsyncPath(file) {
  const handle = await fsp.open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// Move a finished temp file (or directory: its entries are flushed, its
// files were published one by one) to its final name, durably.
export async function publish(tempPath, finalPath) {
  await fsyncPath(tempPath);
  await fsp.rename(tempPath, finalPath);
  await fsyncPath(path.dirname(finalPath));
}

// Test hook for check_crash.py: GG_TEST_PAUSE="linked:3000,published:3000"
// waits that many milliseconds at the named point, after logging
// "[test] pause <point>" (and "[test] resume <point>" after), so a check can kill the server inside a window
// that is otherwise too short to hit. Unset, it costs nothing.
const TEST_PAUSES = new Map((process.env.GG_TEST_PAUSE || '').split(',').filter(Boolean)
  .map(part => part.split(':')).map(([point, ms]) => [point, Number(ms) || 0]));
export async function testPause(point) {
  const ms = TEST_PAUSES.get(point);
  if (!ms) return;
  console.log('[test] pause ' + point);
  await new Promise(resolve => setTimeout(resolve, ms));
  console.log('[test] resume ' + point);
}

// Write data to finalPath durably (temp name: finalPath + '.tmp').
export async function writeFileDurably(finalPath, data) {
  const temp = finalPath + '.tmp';
  await fsp.writeFile(temp, data);
  await publish(temp, finalPath);
}
