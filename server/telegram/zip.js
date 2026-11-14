// Minimal streaming ZIP writer (store method, data descriptors). Files are written as they are
// downloaded, so a multi-file archive never sits in memory. Limited to < 4 GiB in total (no ZIP64).
import { crc32 } from 'node:zlib';

const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

function dosTime(date) {
  const d = new Date(date);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

/**
 * @param {{ name: string, date: Date|number, open: () => AsyncIterable<Buffer> }[]} entries
 * @returns {AsyncGenerator<Buffer>}
 */
export async function* zipStream(entries) {
  const central = [];
  let offset = 0;
  const used = new Set();
  for (const entry of entries) {
    let name = entry.name.replace(/[\\/]/g, '_') || 'file';
    for (let i = 2; used.has(name.toLowerCase()); i += 1) name = entry.name.replace(/(\.[^.]*)?$/, ` (${i})$1`);
    used.add(name.toLowerCase());
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, day } = dosTime(entry.date ?? Date.now());
    const flags = 0x0008 | 0x0800; // data descriptor + UTF-8 names
    const header = Buffer.concat([u32(0x04034b50), u16(20), u16(flags), u16(0), u16(time), u16(day), u32(0), u32(0), u32(0), u16(nameBuf.length), u16(0), nameBuf]);
    yield header;
    const start = offset;
    offset += header.length;
    let crc = 0;
    let size = 0;
    for await (const chunk of entry.open()) {
      crc = crc32(chunk, crc);
      size += chunk.length;
      offset += chunk.length;
      if (offset > 0xfffffff0) throw new Error('Archive larger than 4 GB; download the files separately.');
      yield chunk;
    }
    const descriptor = Buffer.concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]);
    yield descriptor;
    offset += descriptor.length;
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(flags), u16(0), u16(time), u16(day), u32(crc), u32(size), u32(size), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(start), nameBuf]));
  }
  const dir = Buffer.concat(central);
  yield dir;
  yield Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(dir.length), u32(offset), u16(0)]);
}
