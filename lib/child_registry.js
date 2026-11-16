// The ffmpeg processes this server has running, as one empty file per
// process id in STATE_DIR/ffmpeg-children/. A server that is killed with
// kill -9 (or crashes) cannot stop its children, and an ffmpeg making a
// web copy would go on for hours with nobody to use its output. At the next
// start, killLeftoverChildren stops every such process that is still an
// ffmpeg working on our galleries. (Under systemd the unit's cgroup is
// killed with the server anyway.)
//
// Used from the main thread (ffmpeg.js) and from the mosaic worker
// threads, so only synchronous calls of the fs module, which are cheap.

import fs from 'fs';
import path from 'path';
import { GALLERIES_ROOT, STATE_DIR } from './config.js';

const DIR = path.join(STATE_DIR, 'ffmpeg-children');

export function registerChild(pid) {
  if (!pid) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, String(pid)), '');
  } catch {}
}

export function unregisterChild(pid) {
  if (!pid) return;
  try { fs.unlinkSync(path.join(DIR, String(pid))); } catch {}
}

// At startup, before any new work: kill what a previous run left running.
// A process id may have been reused since, so only a process that is
// ffmpeg or ffprobe and names a path in the galleries root is killed.
export function killLeftoverChildren() {
  let names;
  try { names = fs.readdirSync(DIR); } catch { return 0; }
  let killed = 0;
  for (const name of names) {
    const pid = Number(name);
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      const program = path.basename(argv[0] || '');
      if ((program === 'ffmpeg' || program === 'ffprobe') && argv.some(arg => arg.includes(GALLERIES_ROOT))) {
        process.kill(pid, 'SIGKILL');
        killed++;
      }
    } catch {}
    try { fs.unlinkSync(path.join(DIR, name)); } catch {}
  }
  return killed;
}
