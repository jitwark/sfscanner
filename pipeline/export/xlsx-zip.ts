import { inflateRawSync, deflateRawSync } from 'node:zlib';

export type ZipEntry = { name: string; data: Buffer };

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer { const output = Buffer.alloc(2); output.writeUInt16LE(value, 0); return output; }
function u32(value: number): Buffer { const output = Buffer.alloc(4); output.writeUInt32LE(value >>> 0, 0); return output; }

export function createZip(entries: readonly ZipEntry[]): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'); const compressed = deflateRawSync(entry.data, { level: 6 }); const crc = crc32(entry.data);
    const header = Buffer.concat([u32(0x04034b50), u16(20), u16(0x800), u16(8), u16(0), u16(0), u32(crc), u32(compressed.length), u32(entry.data.length), u16(name.length), u16(0), name]);
    local.push(header, compressed);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x800), u16(8), u16(0), u16(0), u32(crc), u32(compressed.length), u32(entry.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += header.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central); const localBytes = Buffer.concat(local);
  return Buffer.concat([localBytes, centralBytes, Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralBytes.length), u32(localBytes.length), u16(0)])]);
}

function findEnd(buffer: Buffer): number {
  for (let index = buffer.length - 22; index >= 0; index--) if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  throw new Error('XLSX: missing ZIP end record');
}

export function readZip(buffer: Buffer): Map<string, Buffer> {
  const end = findEnd(buffer); const count = buffer.readUInt16LE(end + 10); const centralOffset = buffer.readUInt32LE(end + 16); let cursor = centralOffset; const result = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('XLSX: malformed central directory');
    const method = buffer.readUInt16LE(cursor + 10); const compressedSize = buffer.readUInt32LE(cursor + 20); const nameLength = buffer.readUInt16LE(cursor + 28); const extraLength = buffer.readUInt16LE(cursor + 30); const commentLength = buffer.readUInt16LE(cursor + 32); const localOffset = buffer.readUInt32LE(cursor + 42); const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26); const localExtraLength = buffer.readUInt16LE(localOffset + 28); const start = localOffset + 30 + localNameLength + localExtraLength; const compressed = buffer.subarray(start, start + compressedSize);
    result.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}
