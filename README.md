# ggvideo-experimental

> **Experimental fork of [Goodgallery](https://github.com/cartossin/goodgallery)
> that adds video.** It has had **no security review**. In particular it runs
> ffmpeg on every video in the galleries, including uploaded ones, and
> ffmpeg's demuxers and decoders are a large attack surface. Do not expose it
> to untrusted users or untrusted files. Use upstream Goodgallery for a
> photo gallery you put on the internet.

What this fork adds to Goodgallery 2.0.0-rc.4: folders may hold videos next
to photos. A video shows in the grid as a still (its poster frame, built
exactly like a photo), then as a moving preview: all of a folder's previews
are packed into a few mosaic videos per size, which the viewer plays once
and cuts into tiles, the way the still grid uses sprite atlases. Opening a
video plays a browser-friendly copy (H.264 + AAC). See [Video](#video).

## Goodgallery

A web-based photo gallery solution focusing on ui and performance. One Node.js process, no npm
dependencies, libvips for image work, a WebGL grid on the client. Built and
tested against galleries of 100,000 images.

What makes it different:

- **Sprite-atlas thumbnails.** Small zoom levels are served as a handful of
  atlas images instead of one request per thumbnail, so a 100k-image grid
  scrolls end to end without the browser ever issuing 100k requests.
- **Resolution ladder.** Every image gets AVIF renditions at heights of
  200 to 1600 px, plus small copies 5 to 100 px high that are packed into
  the atlases; the client picks the tier that matches the current zoom and
  viewport. The small copies are kept lossless only until they are packed:
  the atlas images sent to browsers are AVIF at quality 80, so a thumbnail
  is compressed once.
- **Folders are galleries.** Point it at a directory tree. Each folder is a
  gallery; subfolders show as cards. Add images with the built-in uploader
  or by copying files in and rescanning.
- **No passwords.** Admin sign-in is a one-time link made on the server, or
  an optional WebAuthn passkey once you have HTTPS. Nothing to choose badly,
  nothing to leak, no accounts table.

## Requirements

- Linux. That is where it is developed and tested. On Windows or macOS, run
  it in a Linux VM, a container, or WSL 2 with the galleries on the Linux
  filesystem. Running it natively on Windows is not supported yet.
- Node.js 18 or newer. The packages in Debian 13 (20.19) and Ubuntu 24.04
  (18.19) both work.
- libvips 8.13 or newer, command-line tools, with AVIF and SVG support.
  AVIF needs libheif's AV1 encoder, a separate package on Debian and Ubuntu
  (`libheif-plugin-aomenc`) that `apt install --no-install-recommends` and
  many container images leave out. At startup the server checks the
  version, encodes a tiny AVIF, and refuses to start, naming what is
  missing, if `vips`, `vipsthumbnail` or `vipsheader` are missing, libvips
  is older than 8.13 (needed to keep its risky loaders away from uploaded
  files), or the AVIF encode fails.
- ffmpeg and ffprobe with the libx264 and AAC encoders and the `xstack`,
  `thumbnail`, `fillborders`, `scale` and `pad` filters (Debian's and
  Ubuntu's `ffmpeg` package has all of them; `zscale`, also in it, is used
  to tone-map HDR video). At startup the server encodes a tenth of a second
  of H.264 + AAC and refuses to start, naming what is missing, if it cannot.
- Optional: HTTPS in front of it (nginx, Caddy, a tunnel). Browsers only
  offer passkeys on secure origins, so passkey sign-in needs HTTPS or
  `localhost`; without it you sign in with links made on the server. The
  server itself speaks plain HTTP and sets the `Secure` cookie flag when it
  sees `X-Forwarded-Proto: https`. Serve it at the root of a host name
  (`https://photos.example.com/`); hosting under a path prefix
  (`https://example.com/photos/`) is not supported, because every URL it
  makes starts at `/`.

## Install

Debian 13 or Ubuntu 24.04:

```sh
apt update && apt install -y git nodejs libvips-tools libheif-plugin-aomenc ffmpeg
useradd -r -s /usr/sbin/nologin -d /var/lib/ggvideo ggvideo
# a copy of this repository in /opt/ggvideo (it is not published)
mkdir -p /var/lib/ggvideo/galleries
chown -R ggvideo:ggvideo /var/lib/ggvideo
install -m 644 /opt/ggvideo/ggvideo.service /etc/systemd/system/
systemctl enable --now ggvideo
```

Rocky Linux or RHEL 9: the default Node stream is 16 and libvips is not in
EPEL, so the first line becomes

```sh
dnf module enable -y nodejs:22
dnf install -y git nodejs epel-release
dnf install -y https://rpms.remirepo.net/enterprise/remi-release-9.rpm
dnf install -y vips-tools vips-heif
```

and the rest is the same. `vips-heif` is the AVIF support; the server
needs it. ffmpeg on RHEL comes from RPM Fusion, which this fork has not
been tried with.

These steps are upstream Goodgallery's, which were run on a fresh
container of each distro; with this fork only the Debian 13 one has been
used.

The unit runs as the `ggvideo` user on port 3000 with galleries under
`/var/lib/ggvideo/galleries` and state under `/var/lib/ggvideo`.
To change any of that, put the settings in `/etc/ggvideo.env` (see
Configuration) and restart the service. Edit that file rather than the
unit: `node server.js login-link` reads the same file, so the link it makes
points at the port the service listens on and is written where the service
looks for it.

Upgrading from a version whose unit has `Environment=PORT=...` lines: that
unit keeps working as it is. If you changed those values, move them into
`/etc/ggvideo.env` when you install the new unit, or `login-link` will
not know them.

The unit sets `UMask=0077`, so the photos and folders the service creates
(uploads, folders made on the admin page) are readable only by the
`ggvideo` user. If other users or a file share (SMB, NFS) must read
them, override it with `systemctl edit ggvideo`:
`[Service]` then `UMask=0022`. The sign-in files in the state dir
(passkey, sessions, login links) stay private either way.

To run it by hand instead: `node server.js`. It then takes its settings
from its own environment only.

## First run

1. On the server, as root, run
   `node /opt/ggvideo/server.js login-link` and open the link it prints
   within 10 minutes. It reads `/etc/ggvideo.env` as the service does,
   and leaves its file owned by the state dir's owner, so the service can
   read it. To run it as the service user instead (it has no login shell,
   so `su` does not work):
   `sudo -u ggvideo node /opt/ggvideo/server.js login-link`. The
   browser that opens the link stays signed in until it signs out, is
   signed out from the admin page, or loses the cookie. There is no other
   way in on a fresh install, so nobody can claim the admin by reaching the
   URL first. A link that has expired or was already used says so on the
   page.
2. Optional, on HTTPS or at `http://localhost`: open `/_admin/` and press
   **Create passkey** in the Sign-ins card. From then on the passkey signs
   in directly, and only passkey sessions can create login links from the
   page. Browsers refuse passkeys over plain HTTP at any address but
   `localhost`, and at an IP address even over HTTPS, so not at
   `http://127.0.0.1` either; there, keep using the server command. Lost
   the passkey? Delete `passkey.json` in the state dir and enroll again
   from a server-made link.

   A passkey belongs to the exact address it was created at: scheme, host
   name and port. One created at `http://localhost:3000` (for example
   through an SSH tunnel) does not work at `https://photos.example.com`,
   and the page allows one passkey. To move to the real address: sign in
   there with a server-made link, delete `passkey.json` in the state dir,
   and press **Create passkey** at the new address.
3. Create a folder or upload images from the admin page, or copy a directory
   of images into the galleries root, give it to the service user
   (`chown -R ggvideo:ggvideo <folder>`: a folder the service
   cannot write cannot be built, and the admin page says so), and press
   **Rescan all folders**
   (under Troubleshooting on the admin page).
4. Open `http://your-host:3000/` (or whatever your proxy serves); the
   server prints the address when it starts. The first visit to a folder
   builds its renditions and atlases in the background and shows
   progress; later visits are served from the committed build.

Everything in the galleries root is public: every photo, in full, with the
metadata embedded in the file, such as the GPS position where it was taken,
the camera and the author. The AVIF renditions keep that metadata too.
Remove it from the originals before adding them if it should stay private.
A hidden folder is only left out of listings; anyone with its address can
open it.

Supported source formats: JPEG, PNG, GIF, WebP, AVIF, and video files with
the extensions mp4, m4v, mov, mkv, webm, avi, wmv, flv, mpg, mpeg, ts,
m2ts, mts, 3gp, ogv, asf, divx and vob, in whatever codec ffmpeg decodes
(ffprobe decides; see [Video](#video)). A photo libvips cannot
read, one above the pixel limit (`MAX_SOURCE_MEGAPIXELS`), or one whose
conversion failed gets a red placeholder tile instead of breaking the
gallery, and the admin page names it and says why. Rescanning the folder
tries failed conversions again. A photo whose file name is longer than 233
bytes is left out, with a line in the log: its renditions' names would not
fit the filesystem's 255-byte limit. A video ffmpeg cannot read gets the
same placeholder and is listed like a broken photo (its original is still
served at its URL).

## Video

Videos are files in a gallery folder like photos, in any order with them:
listed, uploaded (the chunked uploader takes files up to `MAX_UPLOAD_BYTES`,
64 GiB by default; finishing an upload needs room for the file twice while
its chunks are joined), moved to the trash, restored and rescanned the same
way. The extension says a file is a video; ffprobe then decides whether it
has a video stream ffmpeg can decode.

What the server makes for each video, in this order:

1. **Poster and renditions.** One representative frame from the first
   seconds (from one second in, ffmpeg's `thumbnail` filter choosing among
   18 candidates, so a black or blurred first frame is not taken), upright
   (rotation metadata applied), with square pixels (anamorphic video
   widened), HDR tone-mapped, interlaced video deinterlaced. That frame goes
   through the photo pipeline, so a video gets the same AVIF renditions and
   the same place in the still atlas as a photo. The grid therefore works
   for videos with no viewer change, and the folder is browsable as soon as
   its stills are built.
2. **Preview clips and the video atlas.** Each video's first
   `VIDEO_PREVIEW_SECONDS` (60), or its whole seconds when shorter, without
   sound, at a constant `VIDEO_PREVIEW_FPS` (24), scaled to each tier's
   tile height (`VIDEO_TIERS`: 25, 50, 100, 200 and 400 px; wider than
   4:1 is shrunk to 4:1) are cached as small clips in `gg/`, with a
   keyframe at every second. A video has no tile in a tier taller than
   its own picture (a 360p video none in h400): the viewer shows the
   smallest tier at least as large as the tile on screen and scales it
   down, so no tile is ever an enlargement; above a video's tallest tier
   its pixels are all there is. All of a folder's clips are then packed into mosaic
   videos, one or more per tier, each exactly 60 s long so they all loop
   together; a shorter video loops inside its tile. A mosaic is limited
   only by its 3840x2160 frame (hardware decoding works everywhere up to
   that, at 30 fps): about 4,600 h25 tiles of 16:9 video, 1,480 h50, 400
   h100, 104 h200 or 25 h400 (35 of 4:3), so 10,000 videos fill 3 h25
   sheets. Each tile is
   surrounded by 4 px of its own edge pixels so compression never mixes
   neighbours. A viewer plays one mosaic per tier, uploads it to a WebGL
   texture each frame and cuts tiles out of it. The layout is in
   `gg/video_<id>/_video.json`; its exact format is documented at the top
   of `lib/video_atlas.js`.

   Mosaics are composed the way still atlases are: worker threads copy
   each tile's decoded pixels into frames of the sheet's size, and one
   ffmpeg encodes the finished frames, which it reads raw from a pipe. The
   tiles' clips are read a second at a time by a few single-threaded
   decoders, each going through its share of the clips one after the
   other, so a sheet of 4,600 tiles costs a handful of processes, not one
   decoder per tile. Its memory is two chunks of frames
   (`VIDEO_MOSAIC_MEMORY`, 512 MiB, at least a second each: about 600 MB
   at 4K) plus x264's (about 1 to 1.5 GB at 4K).
3. **Web copy.** `gg/<name>.web.mp4`: H.264 High, yuv420p, AAC stereo (or no
   sound if the video has none), the index at the front of the file
   (faststart), at most `VIDEO_WEB_MAX_HEIGHT` (1080) lines on the short
   side and never upscaled, frame rate kept (at most 60), and a keyframe
   at least every second (two, if copied), so a seek anywhere starts at
   most a second or two of video before its target: the browser fetches and decodes from the
   keyframe before the time asked for, so keyframes 10 s apart (x264's
   default, and common in downloaded films) made seeking fast or slow by
   where it landed. A video that is already H.264 of that kind is copied
   rather than encoded again (only its sound is converted if it is not AAC
   stereo), but only when its own keyframes are at most 2 s apart
   (measured on five 30-second windows of the file, in under half a
   second) or it is a minute long at most; otherwise it is encoded. Web
   copies made before this rule are made again for videos longer than a
   minute; shorter ones are kept (a short copy is a few megabytes the
   browser holds whole).

4. **Storyboard.** For the player's seek bar: frames across the whole
   video, 160 px tall, one a second up to 1,000 frames (then one every
   2, 3, ... s; a 2 h film gets one every 8 s, 987 frames), packed 10 x 10
   in AVIF sheets `gg/<name>.sb<k>.avif`, listed in the manifest as
   `storyboard: { interval, count, width, height, columns, rows, sheets }`
   (the exact contract is at the top of `lib/storyboard.js`). Made from
   the web copy after every web copy, by decoding only its keyframes
   (every web copy of a video over a minute has one each second): the 2 h
   film (from its present 8 GB copy) in 80 s and 2.9 MB, a 12 min 720p
   film in 29 s and 4.0 MB. Videos under 30 s get none.

Steps 2 to 4 run after the folder's build is committed, in a queue of
their own, at nice 10. Everything the server builds shares one budget of
working threads, `CPU_BUDGET` (the CPU count): a photo build is one unit
(one single-threaded vips), a preview clip job 3 (its decoder thread,
its filter thread, and the per-tier encoders of tiny pictures, which
together use about one core), a web copy at most half the budget and 8
(one decoder, one filter thread, the rest x264), a mosaic sheet what is
left beside one web copy, at most 8, split between decoder lanes (a
decoder thread and a compositing thread each) and x264 in proportion to
their measured work, which depends on the sheet's tile count: a full h25
sheet gets 5 lanes and 2 encoder threads, an h100 sheet 2 and 5. A bigger
sheet share would not make a sheet faster (x264 or the lanes would wait),
so a bigger budget composes several sheets side by side, of one folder or
several, as many as half the memory allows at 3 GiB each (a 4K sheet
peaks at 2.4 to 2.8 GB). Each job is started with exactly those thread
options, and a job starts only when its units are free, so the working
threads never outnumber the CPUs. Photos come first: while photos wait,
no video job starts. Clips and mosaics go before web copies, except that
one web copy at a time never waits for them: a folder of thousands of
videos keeps the mosaics busy for hours, and its web copies (what plays
when a video is opened) are made alongside. As a web copy takes at most
half the budget, a new folder's previews do not wait behind hours of web
copies elsewhere either. Adding a video makes its own poster, clips and web copy;
the mosaics are assembled again from the cached clips, and a sheet whose
tiles did not change is reused (hard-linked) instead of encoded again.
Tiles keep their places from one atlas to the next: a new video goes after
the last tile of each tier, a removed one leaves a gap (until the gaps add
up to a whole sheet, when the tier is packed afresh), so adding or removing
one video re-encodes one sheet per tier however large the folder.
Removing or replacing a video deletes its clips and web copy, and withdraws
at once every video atlas that shows it.

When the atlas settings change (`VIDEO_TIERS`, the preview's length or
frame rate) or a new version encodes mosaics differently, each folder's
atlas is made again the next time its video work runs (at startup, at
latest): only missing clip tiers are made (one more pass over each video's
first minute for a new tier), sheets whose content is unchanged are
reused, and web copies and posters are not touched. Adding a tier keeps
every tile of the other tiers in its place (the layout is kept across
tier changes), so only that tier's clips and sheets are made; the old
atlas is served until the new one is committed. This version's clips
have a keyframe every second, which earlier clips lack, so after upgrading
every clip is made once more.

A clip or web copy that failed because the machine was short of something
(tasks, memory, disk, file handles; ffmpeg killed) is tried again by
itself after 5 minutes (`VIDEO_RETRY_SECONDS`), then at doubling intervals
up to 6 hours, 8 times;
one that failed because of the file waits for a rescan or a new file.

What the page gets: the manifest (`gg/_manifest.json`) has
`videos: { "<name>": { duration, web, hasAudio, width, height, storyboard } }`
for every video ffmpeg can read (`web` is the web copy's file name in
`gg/`, or null until it is made; `width` and `height` are the displayed
size; `storyboard` is described below, or null) and
`videoAtlasDir` (`video_<id>`, or null while there is no atlas). The folder
page sets `videos` and `videoAtlas` (the `_video.json` contents plus `dir`)
next to `spriteMeta`. The build-status poll (`?build-status`) keeps its
meaning for the stills and adds a `video` object: whether video work is
running, how many clips, mosaics and web copies are queued, whether the
atlas is ready, and how many web copies of how many videos are done.

Static files, the web copies, mosaics and originals included, answer HTTP
range requests (`Range: bytes=...`, 206 and 416, `If-Range`), which
browsers need to play and seek video.

### In the browser

- **Grid.** Each mosaic sheet with a tile on screen plays in one hidden,
  muted, looping `<video>`; every new frame is uploaded to a WebGL texture
  and that sheet's tiles are drawn over their posters (the drawing buffer
  is kept, so a frame does not redraw the grid; a frame is one draw call
  per sheet). Pixels are never stretched, as for stills: one tier serves
  every tile in view, the smallest at least as tall as the tallest video
  tile on screen in device pixels (10% tolerated, since justified rows are
  never exactly a tier's height), scaled down, at most 4x. A video with
  no tile in that tier (its own picture is smaller) plays the tallest
  tier it has, all the pixels it has; its sheets count toward the 4. A
  tile taller than every tier plays its web copy instead, muted and
  looping the first 60 s like the mosaics, drawn the same way; at most 8 at once, nearest the window's centre first, freed
  as soon as they leave the screen or the grid. Only as a degraded case,
  when the tiles on screen are spread over more than 4 sheets of the
  right tier, a smaller tier plays. A sheet off screen pauses at once and
  is freed after 15 s. Opening the player view frees every sheet at once:
  a paused sheet still being fetched keeps downloading, and on a slow
  link that takes the film's bandwidth and holds up its seeks. Posters stay where nothing plays: tiles under a
  quarter of the smallest tier, a hidden page, the photo view, a video not
  ready yet, and anything that could not be loaded or decoded. The tiles
  move with `prefers-reduced-motion` too (it is often on for the system's
  own animations); only an opened video then waits for a click. While the
  mouse is over the top controls' pull tab, or the controls are open (on
  a touch screen: after a tap on the tab), every video tile at least 60
  px high and 40 wide shows a small badge with a play triangle and its
  duration; otherwise there is no badge at all.
- **Film strip.** In the photo view the strip's video tiles move too,
  from the same sheets, played by the same players under the same rules:
  one tier for the strip, the smallest at least as tall as its tiles in
  device pixels (h50 at 1x, h100 at 2x), scaled down; a video with no
  tile there plays the tallest tier it has; only sheets with a tile in
  view play, at most 4, the ones with the most tiles. The strip is a 2D
  canvas, so no texture is made: each new frame repaints the strip once,
  drawing every video tile in view straight from its sheet's `<video>`
  over its poster. When no video tile in view plays, nothing repaints.
  Posters stay where nothing plays: a video the atlas lacks, a folder
  whose atlas is not built yet, a sheet not loaded yet. The strip plays
  no web copies, so a strip tile taller than every tier stays a poster.
  The tiles move with `prefers-reduced-motion` too, as in the grid. Its sheets
  pause as soon as the photo view goes and are freed 15 s later, as in
  the grid, or at once by the player view (which covers the strip). The cost follows the
  tiles in view, not the folder: in a folder of 10,000 videos a strip
  of about 30 video tiles plays one h50 sheet.
- **Opening a video** shows the web copy over the poster, in the box a
  photo would fill, with the viewer's own controls (no browser controls):
  play/pause, a seek bar with the buffered ranges, time and duration,
  mute and volume, full screen, and a "Download original" link. It plays
  with sound if the browser lets the page start it (otherwise it waits for
  a click), not by itself under `prefers-reduced-motion`. Hovering the seek
  bar shows the time there and, when the video has a storyboard (frames
  sampled over the whole video in sprite sheets), that frame; dragging
  shows the frame over the picture at once, until the video has decoded
  the real one, and seeks while dragging, one seek at a time (`fastSeek`
  where the browser has it), then exactly where released. The controls
  fade after 2.5 s without the pointer while playing. Space plays and
  pauses; the arrows move between items as for photos, and seek 5 s on a
  focused seek bar and in full screen; Escape returns to the grid. Without
  a web copy yet, the poster and a note stay until the build-status poll
  finds it. Leaving stops playback.

### Cost

Measured on a 16-thread container (one Proxmox LXC):

- One full mosaic, made alone from cached clips of real 20 s 480p videos:
  h25, 4,599 tiles in 3796x2142, 132 s with 8 decoder lanes (16 CPUs,
  otherwise lightly loaded), 121 MB at the h25 ceiling of 16 Mbit/s;
  h50, 1,480 tiles in 3840x2146, 91 MB at 12 Mbit/s (measured on a machine
  at load 100, 10 minutes). A sheet build uses about 90 threads and 2.5 GB
  (about 1 GB in the compositor, 1.5 GB in x264), whatever its tile count.
  Pictures: h25 tiles are recognisable at their own size and blocky when
  enlarged; h50 at 12 Mbit/s is slightly softer than uncapped (22 Mbit/s).
- 466 films of the Prelinger archive (35 GB, about 8 minutes each): preview
  clips 687 s, the video atlas 309 s for 7 sheets (h25 1 sheet of
  3832x204, 11 MB; h50 1, 25 MB; h100 1, 69 MB; h200 4, 58 MB each when
  full); the web copies take hours (each film is decoded and encoded).
- A folder of 150 short synthetic videos (3 to 6 s, five shapes from 4:1 to
  9:16): mosaics h25 3818x102 5.7 MB, h50 3812x232 10 MB, h100 3838x864
  31 MB, h200 3822x2080 58 MB and 3548x1040 27 MB. The test pattern is far
  busier than real video and fills the bitrate ceiling.
- Adding one video to a built folder makes its poster, its clips (a second
  or two) and its web copy, re-encodes the last mosaic of each tier (at
  10,000 videos four full 4K sheets, two at a time: about 5 minutes on 16
  CPUs) and reuses every other sheet; removing one re-encodes the sheet it
  was on. The still atlas is baked again as upstream does for a photo.
- Real clips (Big Buck Bunny, Sintel, Tears of Steel and others, 26 files
  in 12 containers): 12 clips of 3 to 90 s gave mosaics of 1.5 MB (h50),
  3.8 MB (h100) and 10 MB (h200, 3360x416); preview clips take about 2 MB
  per video.
- A web copy costs a full decode and H.264 encode of the video (`-preset
  faster -crf 21`, a keyframe a second) unless it can be copied: a 2 h
  11 min 1080p film (1920x800) at about 3x real time with the 6 encoder
  threads of CPU budget 16, about 45 min and 4.3 GB (its stream copy, with
  keyframes up to 10 s apart, was 8.1 GB in 3 min). A keyframe a second
  costs 10 to 27% more than x264's default spacing on the films measured
  (lib/videos.js), and halves the worst seek against two seconds. Disk: about the size of a 1080p H.264
  file of the same length per video, plus the clips and the mosaics.
- ffprobe runs on every video at every rebuild of its folder that finds it
  new or changed; a poster costs a few seconds of decoding.

### Crash safety

The video work picks up by itself after a crash, `kill -9`, power cut or
reboot, from what it finished. Every clip, web copy, mosaic and state file
is written under a temp name, flushed to disk (fsync) and renamed, so it
appears complete or not at all; the record of what is made
(`_videos.json`) changes only after the file it describes is published,
and is written at most every 2 s, so a crash can lose news of finished
work (which is then done again) but never claim unfinished work. An atlas
is built in `video_<id>_building/` and renamed only when complete, and
the manifest names it only after that. Each finished mosaic in a building
directory has a `.key` file, so the next attempt after a crash reuses it;
an atlas finished but not yet committed when the server died is committed
as it is. At startup the server stops ffmpeg processes a killed run left
behind (`STATE_DIR/ffmpeg-children/`), sweeps temp files, and the startup
walk starts every folder's video work, which goes through one shared queue.
`check_crash.py` (outside the repository) kills the server and its ffmpeg
children at the phases of the video work and checks that the folder ends
exactly as an uninterrupted build does.

### Limits

- No security review. ffmpeg parses every video, uploaded ones included,
  with the local-file protocol only and only real video container demuxers
  allowed (no playlists, concat or image sequences), but its decoders are
  still a large attack surface.
- HDR is tone-mapped with a fixed curve (hable); Dolby Vision profiles
  without an HDR10 base layer are not handled specially.
- Subtitles, chapters, extra audio tracks and metadata are not carried
  into the web copy (only the first audio track, downmixed to stereo).
- The viewer's video side has been tested in headless Chromium with
  software rendering only, not yet on real GPUs, Safari or Firefox. A
  swipe on the playing video itself goes to the native player, not the
  film strip (the strip and the arrows still move between items).

## Admin page

`/_admin/` is the admin panel. It
shows the build queue, and for the current folder: counts and build state,
a notice when files on disk are not in the gallery yet, subfolders with
hide toggles, uploads of files or whole folders (chunked, several files in
flight), the image list, and the folder's trash. A chunk that fails because
of the network or a server error is sent again, so an upload survives a
brief network drop; a chunk the server refuses is not. An upload does not survive
reloading or closing the page, which starts the file over (the chunks
already sent are removed after 24 hours). Folders can be
created, hidden from public listings (they stay reachable by direct URL),
trashed, restored, emptied, rebuilt from scratch, or rescanned, and the
whole tree can be rescanned after copying files in.

The Sign-ins card lists every signed-in browser. **Create login link** mints
a one-time URL that signs in another browser; useful on a device that
cannot use your passkey. Only passkey sessions can mint links from the
page; `node server.js login-link` on the server always can. **Sign out all
other sessions** ends every session but the current one and cancels every
login link that has not been used yet. Sessions do not expire on their own.

The passkey and the sessions are files in the state dir (`passkey.json`,
`sessions.json`). If one of them is damaged the server refuses to start
and names the file, rather than treating it as absent.

## On-disk layout

Each gallery folder keeps all derived state in a `gg/` subdirectory next to
the originals:

```
<folder>/<image>.jpg
<folder>/gg/<image>.jpg.h200.avif     per-image renditions, AVIF (h200..h1600)
<folder>/gg/<image>.jpg.h5.v          small lossless copies, the atlas input (h5..h100)
<folder>/gg/atlas_<id>/               sprite atlases + imagemap for this build
<folder>/gg/<video>.mp4.v100.mp4      a video's preview clip for one tier (atlas input)
<folder>/gg/<video>.mp4.web.mp4       a video's playable copy
<folder>/gg/video_<id>/               the video atlas: mosaic-h<H>-<N>.mp4 + _video.json
<folder>/gg/_videos.json              what ffprobe said about each video, what is made
<folder>/gg/_manifest.json            the committed listing a pageview renders from
<folder>/gg/_sources.json             size and time of each photo at the last build
<folder>/gg/_placeholders.json        photos shown as placeholders, and why
<folder>/gg/trash/                    soft-deleted images and folders
<folder>/gg/hidden                    sentinel: folder is hidden from listings
```

`trash/` and `hidden` are user state; keep them. Everything else in `gg/` is
built from the photos. Deleting all of it at once is safe: the next visit
rebuilds the folder. Deleting only part of it is repaired too: a missing
`atlas_` directory on the next visit, missing renditions at the next rescan
or restart. One caution: `_sources.json` is how a photo replaced by an older
file of the same name is noticed, so if it is lost, rebuild the folder from
scratch after such a replacement. To rebuild a folder completely, delete all of it but `trash/`
and `hidden`, or use **Rebuild from scratch** on the admin page.

A manifest is only written after every file it references exists, so an
interrupted build never leaves a half-served gallery; it just rebuilds.

## Configuration

Environment variables, all optional. For the systemd service, put them in
`/etc/ggvideo.env`, one `VARIABLE=value` per line (lines starting with
`#` are comments; no `export`), for example:

```sh
PORT=8080
GALLERIES_ROOT=/srv/photos
```

The server checks every value when it starts and refuses to start with a
message naming the variable if one is not valid. Sizes are bytes, or a
whole number with `KiB`, `MiB`, `GiB` or `TiB` (`16MiB` or `16 MiB`; `MB`
is refused as ambiguous).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port (1 to 65535) |
| `HOST` | `0.0.0.0` | Listen address |
| `GALLERIES_ROOT` | `/var/lib/ggvideo/galleries` | Root of the gallery tree; everything in it is public |
| `STATE_DIR` | `/var/lib/ggvideo` | Passkey, sessions, server-made login links, in-progress uploads, placeholder tiles. Must not be inside `GALLERIES_ROOT` |
| `SITE_TITLE` | `ggvideo` | Shown in the page title and breadcrumb |
| `BUILD_CONCURRENCY` | CPU count | Parallel vips processes during builds (each runs at nice 10); `0` means CPU count |
| `MAX_SPRITE_BYTES` | `4MiB` | Target size of one atlas image (64 KiB to 64 MiB) |
| `BYTES_PER_PIXEL` | `0.30` | Estimated AVIF bytes per pixel, used to size atlases |
| `SPRITE_CELL_W_MAX` | `600` | Widest atlas cell, in pixels |
| `SPRITE_ENCODE_PARALLEL` | `4` | Atlas images encoded at once while a folder bakes |
| `AVIF_MAX_DIM` | `16384` | libheif per-axis limit; extreme panoramas are bounded to this width |
| `MAX_SOURCE_MEGAPIXELS` | `300` | Photos with more pixels than this get a placeholder instead of being decoded (memory follows the pixel count, not the file size) |
| `VIPS_TIMEOUT_SECONDS` | `600` | A vips process running longer than this is stopped and its photo counted as a failed conversion |
| `CHUNK_SIZE` | `16MiB` | Upload chunk size (64 KiB to 1 GiB) |
| `MAX_UPLOAD_BYTES` | `64GiB` | Largest file the uploader accepts |
| `VIPS_CONCURRENCY` | `1` | Threads inside each vips process. Builds run several processes instead (`BUILD_CONCURRENCY`) |
| `VIDEO_PREVIEW_SECONDS` | `60` | Length of every mosaic, and of the part of each video it shows (2 to 600) |
| `VIDEO_PREVIEW_FPS` | `24` | Frame rate of the mosaics (1 to 30) |
| `VIDEO_TIERS` | `25,50,100,200,400` | Tile heights of the video atlas, 16 to 1080, at most six |
| `VIDEO_MOSAIC_MEMORY` | `512MiB` | Frame buffers of one mosaic being made (two chunks of whole seconds, at least one second each) |
| `VIDEO_RETRY_SECONDS` | `300` | A clip or web copy that failed for a passing reason (out of tasks, memory or disk; ffmpeg killed) is tried again after this, then at doubling intervals up to 6 hours, 8 times; a failed atlas after twice this |
| `VIDEO_WEB_MAX_HEIGHT` | `1080` | Short side of the web copy at most (the long side at most 16:9 of it); never upscaled |
| `CPU_BUDGET` | CPU count | Working threads for all builds at once, photos and videos (photo builds are also limited by `BUILD_CONCURRENCY`); `0` means CPU count |
| `FFMPEG_TIMEOUT_SECONDS` | `14400` | An ffmpeg run longer than this is stopped and its video's clips or web copy counted as failed (a rescan tries again) |
| `GG_DEBUG_BUILDS` | unset | Any value logs a line for every photo the build queue looks at |
| `GG_ENV_FILE` | `/etc/ggvideo.env` | The settings file `login-link` reads (the unit's `EnvironmentFile=` must name the same file) |

## Layout of the code

- `server.js` creates the HTTP server and runs the `login-link` command
  (`lib/login_link.js`); everything else is in `lib/`.
- `lib/config.js` reads and checks the settings; `lib/env_file.js` reads
  the settings file for `login-link`.
- `lib/router.js` dispatches requests; `lib/http.js` holds the response,
  cookie and static-file helpers; `lib/paths.js` maps URLs to folders;
  `lib/page.js` renders the gallery page.
- `lib/manifest.js` keeps each folder's listing (`_manifest.json`) and
  `lib/sources.js` the record of its photos at the last build
  (`_sources.json`).
- `lib/rebuild.js` is the one place a folder's build is committed, using
  `lib/build_plan.js` (which sizes each photo still needs), `lib/build.js`
  (per-image renditions, through the libvips helpers in `lib/vips.js`),
  `lib/build_queue.js`, `lib/placeholders.js` (which photos are shown as
  placeholders, and why) and `lib/atlas.js` (atlases, baked in
  `lib/sprite_worker.js`).
- Video: `lib/ffmpeg.js` starts every ffmpeg and ffprobe (timeouts,
  shutdown, the startup check); `lib/videos.js` is one video's files
  (probe, poster, preview clips, web copy, the `_videos.json` record);
  `lib/video_atlas.js` lays out and encodes the mosaics and documents
  `_video.json`, composing them in `lib/mosaic_worker.js` and
  `lib/mosaic_lane_worker.js` (worker threads); `lib/video_stage.js` runs the video work of each folder
  after its stills are committed.
- `lib/auth.js`, `lib/webauthn.js` and `lib/admin_api.js` handle the passkey
  admin; `lib/upload.js` the chunked uploader; `lib/trash.js` the trash;
  `lib/place.js` puts a file under a name without replacing one that is
  there.
- `public/gallery.js` is the client: layout, WebGL grid, focus view.
- `public/admin.html`, `admin.css`, `admin.js` are the admin panel.

## How it was written

Designed and directed by Cory Salvesen, who wrote the original PHP
Goodgallery in 2007. Most of the code in this rewrite was written with Claude
(Anthropic) as a coding collaborator, which is why the commits carry a
co-author line.
