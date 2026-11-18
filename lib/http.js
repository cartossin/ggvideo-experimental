// HTTP plumbing: responses, cookies, request bodies, static files.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream';
import { PUBLIC_DIR } from './config.js';

export function hxEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// JSON for use inside an inline <script>. JSON.stringify leaves "<" alone,
// so a value containing "</script>" would end the script element; folder
// names reach this. Those characters, and the two line terminators JSON
// allows but JavaScript did not, are written as \uXXXX escapes.
export function jsLiteral(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
export function jsString(s) {
  return jsLiteral(String(s));
}
// Text from outside (a passkey's claimed origin, a file name) for a log
// line: quoted, with control characters escaped, so it can neither start a
// forged line nor send escape sequences to the operator's terminal.
// JSON.stringify covers U+0000-U+001F; DEL, the C1 controls and the two
// Unicode line separators are escaped here too.
export function logText(value) {
  return JSON.stringify(String(value)).replace(/[\u007f-\u009f\u2028\u2029]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
// What to tell the admin's browser about an error. Node's file-system errors
// carry the server's absolute paths in their message, so for those the reply
// names only the error code and the operation; the log has the rest.
export function errorTextForClient(error) {
  if (error && error.code && error.syscall) return `${error.code} (${error.syscall})`;
  return error && error.message ? error.message : String(error);
}
export function parseCookies(h) {
  const out = {};
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    // decodeURIComponent throws URIError on malformed %-escapes (e.g.
    // `Cookie: x=%`), which would otherwise crash the request handler and
    // hand an anonymous DoS to any client. Fall back to the raw value —
    // our own cookies (ggSession base64url) contain no percent-escapes.
    try { out[k] = decodeURIComponent(raw); }
    catch { out[k] = raw; }
  }
  return out;
}
export function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}
export function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(body);
}
export function notFound(res, msg = 'not found') { sendText(res, 404, msg); }
export function badRequest(res, msg = 'bad request') { sendText(res, 400, msg); }

export class BodyTooLargeError extends Error {
  constructor(limit) { super(`request body larger than ${limit} bytes`); }
}

// A body over the limit is refused with BodyTooLargeError as soon as it
// passes the limit, but the rest is still read and thrown away instead of
// cutting the connection: a connection closed while the client is still
// sending is reset, and the client never sees the 4xx the caller answers.
// Node's requestTimeout bounds how long a client can keep sending.
export function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return;
      total += c.length;
      if (total > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BodyTooLargeError(limit));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// Reads a JSON request body that must be an object ({...}): anything else
// (null, an array, a number) has no fields to read. On failure it has
// already answered the request and returns null.
export async function readJsonObject(req, res, limit) {
  if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
    sendJson(res, 415, { error: 'expected application/json' });
    return null;
  }
  let body;
  try { body = JSON.parse(await readBody(req, limit)); }
  catch (err) {
    if (err instanceof BodyTooLargeError) sendJson(res, 413, { error: err.message });
    else badRequest(res);
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'expected a JSON object' });
    return null;
  }
  return body;
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css':  return 'text/css; charset=utf-8';
    case '.js':   return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json';
    case '.svg':  return 'image/svg+xml';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png':  return 'image/png';
    case '.gif':  return 'image/gif';
    case '.webp': return 'image/webp';
    case '.avif': return 'image/avif';
    // Videos: web copies and mosaics are MP4; originals are served as what
    // their extension says, so a browser that can play one directly may.
    case '.mp4': case '.m4v': return 'video/mp4';
    case '.mov':  return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.mkv':  return 'video/x-matroska';
    case '.ogv':  return 'video/ogg';
    case '.avi': case '.divx': return 'video/x-msvideo';
    case '.wmv':  return 'video/x-ms-wmv';
    case '.asf':  return 'video/x-ms-asf';
    case '.flv':  return 'video/x-flv';
    case '.mpg': case '.mpeg': case '.vob': return 'video/mpeg';
    case '.ts': case '.m2ts': case '.mts': return 'video/mp2t';
    case '.3gp':  return 'video/3gpp';
    default: return 'application/octet-stream';
  }
}
export function serveStatic(req, res, rel) {
  if (rel.includes('..') || /[\x00-\x1f]/.test(rel)) return notFound(res);
  return serveStaticFile(req, res, path.join(PUBLIC_DIR, rel));
}
// Cache policy is based on the on-disk filename, not the URL — so admin
// pages and gallery pageviews share the policy table.
function cacheControlFor(abs) {
  const base = path.basename(abs);
  // Per-image LoDs and sprite atlases are content-addressed: a rebuild
  // mints new filenames (sprite version bump, .h<N>.avif keyed by image
  // mtime via the build pipeline). Safe to cache forever.
  if (/\.h\d+\.avif$/.test(base)) return 'public, max-age=31536000, immutable';
  if (/^sprite(?:-h\d+)?-\d+\.(jpg|avif)$/.test(base)) return 'public, max-age=31536000, immutable';
  // Mosaics live in a video_<id>/ directory that is never reused.
  if (/^mosaic-h\d+-\d+\.mp4$/.test(base)) return 'public, max-age=31536000, immutable';
  // Imagemap + sprite metadata don't change name but do change content.
  // Short cache + ETag for cheap revalidation.
  if (base === '_imagemap.bin' || base === '_sprite.json' || base === '_video.json') return 'public, max-age=60, must-revalidate';
  // Other static assets (gallery.js, css, html, svg, favicon) — shortish
  // cache plus ETag. Cloudflare edge caches these per Browser Cache TTL.
  return 'public, max-age=300, must-revalidate';
}

// The file is opened before anything is answered, and the size and dates
// come from the open file, so a file that is unreadable or deleted in the
// meantime fails this request only. The body is sent with stream.pipeline,
// which closes the file when the client goes away or a read fails.
// versioned: the request named the file's version in its URL (?v=, see
// router.js), so this answer can be kept for good: another version of the
// file has another URL.
const VERSIONED_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export async function serveStaticFile(req, res, abs, { versioned = false } = {}) {
  const cacheControl = versioned ? VERSIONED_CACHE_CONTROL : cacheControlFor(abs);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendText(res, 405, 'method not allowed');
  }
  let file;
  try {
    // O_NONBLOCK: opening a FIFO someone named x.jpg would otherwise wait
    // for a writer and hold one of libuv's few file-system threads for
    // good. It changes nothing for regular files; the fstat below turns
    // anything that is not one away.
    file = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (err) {
    return answerOpenFailure(res, abs, err);
  }
  let st;
  try {
    st = await file.stat();
  } catch (err) {
    await file.close();
    return answerOpenFailure(res, abs, err);
  }
  if (!st.isFile()) {
    await file.close();
    return notFound(res);
  }
  // The ETag is the file's size and modification time, as a strong tag (no
  // W/): every file served is written whole under a new name and renamed
  // into place (or by git), never changed in place, so the same size and
  // time is the same bytes; nginx does the same. It must be strong for
  // seeking: Chrome asks for the part between two parts it already has
  // with "Range: a-b" and "If-Range: <our ETag>", and If-Range matches a
  // tag only by strong comparison (RFC 9110 13.1.5). With a weak tag every
  // such seek got the whole file back (200), which Chrome throws away
  // before asking again: 2 s for a seek in a playing video on a LAN.
  // Cheap and sufficient for browser
  // conditional GETs. Rebuild produces a new mtime so cache invalidates.
  const etag = '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
  if (isNotModified(req, etag, st.mtimeMs)) {
    await file.close();
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
    return res.end();
  }
  const headers = {
    'Content-Type': contentType(abs),
    'Content-Length': st.size,
    'Last-Modified': st.mtime.toUTCString(),
    'ETag': etag,
    'Cache-Control': cacheControl,
    // Browsers play and seek video only from servers that take ranges
    // (Safari will not play at all without them).
    'Accept-Ranges': 'bytes',
  };
  const range = requestedRange(req, st.size, st.mtimeMs, etag);
  if (range === UNSATISFIABLE) {
    await file.close();
    res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': 0 });
    return res.end();
  }
  let start = 0, end = st.size - 1;
  if (range) {
    ({ start, end } = range);
    res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
  } else {
    res.writeHead(200, headers);
  }
  if (req.method === 'HEAD' || st.size === 0) {
    await file.close();
    return res.end();
  }
  // Exactly the stat'ed length (or range), so the body matches
  // Content-Length even if the file grows while it is sent.
  const body = file.createReadStream({ start, end });
  pipeline(body, res, err => {
    // A client hanging up mid-download is normal. A read error after the
    // headers went out can only be signalled by cutting the connection,
    // which pipeline has already done.
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.warn('[serve] read failed', JSON.stringify(abs), err.code || err.message);
    }
  });
}

// The byte range a request asks for: null for the whole file (no Range
// header, one this server does not take, or an If-Range that does not
// match), { start, end } (inclusive) for one range, or UNSATISFIABLE.
// RFC 9110 14.2: one range only, as "a-b", "a-" or "-n" (the last n bytes);
// a request for several ranges gets the whole file, which the RFC allows,
// and no media player asks for several. A Range header that does not parse
// is ignored, as the RFC says. HEAD answers as GET would, without a body.
const UNSATISFIABLE = Symbol('unsatisfiable');
function requestedRange(req, size, mtimeMs, etag) {
  const header = req.headers.range;
  if (typeof header !== 'string') return null;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (!ifRangeAllows(req, mtimeMs, etag)) return null;
  let start, end;
  if (match[1] === '') {
    // Suffix: the last n bytes; "-0" asks for nothing.
    const length = Number(match[2]);
    if (length === 0) return UNSATISFIABLE;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (match[2] !== '' && Number(match[2]) < start) return null;  // invalid: ignored
  }
  if (start >= size) return UNSATISFIABLE;
  return { start, end };
}

// If-Range (RFC 9110 13.1.5): send the range only if the file is still the
// one the client has part of. An entity tag there must match by strong
// comparison: exactly our (strong) ETag; a weak tag (W/..., as this server
// sent before) never matches and gets the whole file. A date matches when
// it is exactly the file's Last-Modified and that date is a strong
// validator: the file has not changed in the second it names (it is at
// least a second old now).
function ifRangeAllows(req, mtimeMs, etag) {
  const header = req.headers['if-range'];
  if (header === undefined) return true;
  const value = header.trim();
  if (value.startsWith('"')) return value === etag;
  if (value.startsWith('W/')) return false;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return false;
  const lastModified = Math.floor(mtimeMs / 1000) * 1000;
  return date === lastModified && Date.now() - mtimeMs >= 1000;
}

// RFC 9110 13.1.3: when If-None-Match is sent it alone decides, and
// If-Modified-Since is ignored. A file replaced by an older one (cp -p,
// rsync -t) has a new ETag but an older date, and must not get a 304.
function isNotModified(req, etag, mtimeMs) {
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch !== undefined) return etagListMatches(ifNoneMatch, etag);
  const ifModifiedSince = Date.parse(req.headers['if-modified-since'] || '');
  if (Number.isNaN(ifModifiedSince)) return false;
  // HTTP dates carry whole seconds; Last-Modified is the mtime rounded down.
  return Math.floor(mtimeMs / 1000) * 1000 <= ifModifiedSince;
}
// If-None-Match is "*" or a comma-separated list of ETags, compared weakly
// (W/ prefixes ignored), as the RFC asks for GET and HEAD.
function etagListMatches(header, etag) {
  if (header.trim() === '*') return true;
  const opaque = tag => tag.trim().replace(/^W\//, '');
  return header.split(',').some(tag => opaque(tag) === opaque(etag));
}

// Missing files are a 404. Anything else (permissions, out of descriptors)
// is the server's problem: a 500 for this request, and a line for the operator.
function answerOpenFailure(res, abs, err) {
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR') return notFound(res);
  console.warn('[serve] cannot open', JSON.stringify(abs), err.code || err.message);
  return sendText(res, 500, 'cannot read this file');
}
