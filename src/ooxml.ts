const textEncoder = new TextEncoder();

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface CentralEntry {
  name: string;
  central: Uint8Array;
  localOffset: number;
  localRecord: Uint8Array;
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end of central directory is missing");
}

function parseCentralEntries(bytes: Uint8Array): { entries: CentralEntry[]; comment: Uint8Array } {
  const eocd = findEndOfCentralDirectory(bytes);
  const count = readU16(bytes, eocd + 10);
  const centralSize = readU32(bytes, eocd + 12);
  const centralOffset = readU32(bytes, eocd + 16);
  if (centralOffset + centralSize > eocd || count > 65_535) throw new Error("ZIP central directory is invalid");
  const entries: CentralEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (readU32(bytes, offset) !== 0x02014b50) throw new Error("ZIP central entry is invalid");
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const size = 46 + nameLength + extraLength + commentLength;
    const central = bytes.slice(offset, offset + size);
    const name = utf8(bytes.slice(offset + 46, offset + 46 + nameLength));
    const localOffset = readU32(central, 42);
    const localNameLength = readU16(bytes, localOffset + 26);
    const localExtraLength = readU16(bytes, localOffset + 28);
    const flags = readU16(central, 8);
    const compressedSize = readU32(central, 20);
    const dataEnd = localOffset + 30 + localNameLength + localExtraLength + compressedSize;
    if (dataEnd > centralOffset) throw new Error("ZIP local entry is invalid");
    let recordEnd = dataEnd;
    if ((flags & 0x0008) !== 0) {
      if (readU32(bytes, dataEnd) === 0x08074b50) recordEnd += 16;
      else recordEnd += 12;
      if (recordEnd > centralOffset) throw new Error("ZIP data descriptor is invalid");
    }
    entries.push({ name, central, localOffset, localRecord: bytes.slice(localOffset, recordEnd) });
    offset += size;
  }
  const commentLength = readU16(bytes, eocd + 20);
  return { entries, comment: bytes.slice(eocd + 22, eocd + 22 + commentLength) };
}

function storedEntry(name: string, contents: Uint8Array): { local: Uint8Array; central: Uint8Array } {
  const nameBytes = textEncoder.encode(name);
  const local = new Uint8Array(30 + nameBytes.byteLength + contents.byteLength);
  writeU32(local, 0, 0x04034b50);
  writeU16(local, 4, 20);
  writeU16(local, 8, 0);
  writeU16(local, 10, 0);
  const checksum = crc32(contents);
  writeU32(local, 14, checksum);
  writeU32(local, 18, contents.byteLength);
  writeU32(local, 22, contents.byteLength);
  writeU16(local, 26, nameBytes.byteLength);
  local.set(nameBytes, 30);
  local.set(contents, 30 + nameBytes.byteLength);

  const central = new Uint8Array(46 + nameBytes.byteLength);
  writeU32(central, 0, 0x02014b50);
  writeU16(central, 4, 20);
  writeU16(central, 6, 20);
  writeU16(central, 8, 0);
  writeU16(central, 10, 0);
  writeU32(central, 16, checksum);
  writeU32(central, 20, contents.byteLength);
  writeU32(central, 24, contents.byteLength);
  writeU16(central, 28, nameBytes.byteLength);
  central.set(nameBytes, 46);
  return { local, central };
}

export function surgicalZipRewrite(
  input: Uint8Array,
  changes: ReadonlyMap<string, Uint8Array | null>,
): Uint8Array {
  const original = parseCentralEntries(input);
  const known = new Set(original.entries.map((entry) => entry.name));
  for (const name of changes.keys()) {
    if (!known.has(name) && changes.get(name) !== null) throw new Error(`cannot add undeclared ZIP member ${name}`);
  }
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of original.entries) {
    const change = changes.get(entry.name);
    if (change === null) continue;
    let local: Uint8Array;
    let central: Uint8Array;
    if (change !== undefined) {
      ({ local, central } = storedEntry(entry.name, change));
    } else {
      local = entry.localRecord;
      central = new Uint8Array(entry.central);
    }
    writeU32(central, 42, localOffset);
    locals.push(local);
    centrals.push(central);
    localOffset += local.byteLength;
  }
  const centralDirectory = concat(centrals);
  const eocd = new Uint8Array(22 + original.comment.byteLength);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 8, centrals.length);
  writeU16(eocd, 10, centrals.length);
  writeU32(eocd, 12, centralDirectory.byteLength);
  writeU32(eocd, 16, localOffset);
  writeU16(eocd, 20, original.comment.byteLength);
  eocd.set(original.comment, 22);
  return concat([...locals, centralDirectory, eocd]);
}
