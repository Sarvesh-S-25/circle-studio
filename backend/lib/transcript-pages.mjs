// Derived byte offsets into Circle-owned JSON transcripts. Never retain the complete transcript in memory.
import fs from 'node:fs';

const META_LIMIT = 1024 * 1024;
export function indexTranscript(file) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0, depth = 0, quoted = false, escaped = false, token = '', lastString = '', key = '';
  let start = -1, end = -1, item = -1;
  const offsets = [];
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!count) break;
      for (let i = 0; i < count; i++) {
        const c = buffer[i]; const absolute = position + i;
        if (quoted) {
          if (escaped) { escaped = false; if (depth === 1) token += String.fromCharCode(c); continue; }
          if (c === 92) { escaped = true; if (depth === 1) token += '\\'; continue; }
          if (c === 34) { quoted = false; if (depth === 1) lastString = token; continue; }
          if (depth === 1 && token.length < META_LIMIT) token += String.fromCharCode(c);
          continue;
        }
        if (c === 34) { quoted = true; token = ''; continue; }
        if (c === 58 && depth === 1) { key = lastString; continue; }
        if (c === 123 || c === 91) {
          if (c === 91 && depth === 1 && key === 'messages' && start < 0) start = absolute;
          if (start >= 0 && end < 0 && depth === 2 && c === 123) item = absolute;
          depth++; continue;
        }
        if (c === 125 || c === 93) {
          if (start >= 0 && end < 0 && depth === 3 && c === 125 && item >= 0) { offsets.push(item, absolute + 1); item = -1; }
          if (start >= 0 && end < 0 && depth === 2 && c === 93) end = absolute + 1;
          depth--;
        }
      }
      position += count;
    }
    if (quoted || depth !== 0 || start < 0 || end < start || start > META_LIMIT || position - end > META_LIMIT) throw new Error('This transcript cannot be paged.');
    const prefix = Buffer.alloc(start); fs.readSync(fd, prefix, 0, prefix.length, 0);
    const suffix = Buffer.alloc(position - end); fs.readSync(fd, suffix, 0, suffix.length, end);
    const metadata = JSON.parse(`${prefix.toString('utf8')}[]${suffix.toString('utf8')}`);
    delete metadata.messages;
    return { metadata, offsets, total: offsets.length / 2 };
  } finally { fs.closeSync(fd); }
}

export function readTranscriptPage(file, index, start, end) {
  if (start >= index.total || end <= start) return [];
  const first = index.offsets[start * 2];
  const last = index.offsets[Math.min(end, index.total) * 2 - 1];
  const buffer = Buffer.alloc(last - first);
  const fd = fs.openSync(file, 'r');
  try {
    let read = 0;
    while (read < buffer.length) { const n = fs.readSync(fd, buffer, read, buffer.length - read, first + read); if (!n) throw new Error('The transcript changed while reading.'); read += n; }
  } finally { fs.closeSync(fd); }
  return JSON.parse(`[${buffer.toString('utf8')}]`);
}
