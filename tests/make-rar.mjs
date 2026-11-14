// Builds small RAR5 archives in "store" mode for the test fixtures (no RAR tool needed).
// Format: https://www.rarlab.com/technote.htm — verified by extracting with node-unrar-js (official unrar code).
// Usage: node tests/make-rar.mjs out.rar "path/in/archive=source-file" ...
import { readFileSync, writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

const vint = n => {
  const out = [];
  let v = BigInt(n);
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
};
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** One block: CRC32, size, then type+flags+fields (+ data area). */
function block(type, flags, fields, data) {
  const body = Buffer.concat([vint(type), vint(flags | (data ? 0x0002 : 0)), ...(data ? [vint(data.length)] : []), ...fields]);
  const head = Buffer.concat([vint(body.length), body]);
  return Buffer.concat([u32(crc32(head)), head, ...(data ? [data] : [])]);
}

export function makeRar(entries, mtime = Date.parse('2026-10-24T12:00:00Z') / 1000) {
  const parts = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])];
  parts.push(block(1, 0, [vint(0)]));                       // main archive header, no flags
  for (const { name, data, dir } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const fileFlags = (dir ? 0x0001 : 0) | 0x0002 | (dir ? 0 : 0x0004); // directory, mtime, CRC32
    const fields = [
      vint(fileFlags),
      vint(dir ? 0 : data.length),                           // unpacked size
      vint(dir ? 0x10 : 0x20),                               // Windows attributes
      u32(mtime),
      ...(dir ? [] : [u32(crc32(data))]),
      vint(0),                                               // compression: version 0, store, no solid
      vint(0),                                               // host OS: Windows
      vint(nameBytes.length),
      nameBytes,
    ];
    parts.push(block(2, 0, fields, dir ? null : data));
  }
  parts.push(block(5, 0, [vint(0)]));                       // end of archive
  return Buffer.concat(parts);
}

if (process.argv[1]?.endsWith('make-rar.mjs') && process.argv.length > 3) {
  const [, , out, ...specs] = process.argv;
  writeFileSync(out, makeRar(specs.map(s => {
    const [name, src] = s.split('=');
    return src ? { name, data: readFileSync(src) } : { name: name.replace(/\/$/, ''), dir: true };
  })));
}
