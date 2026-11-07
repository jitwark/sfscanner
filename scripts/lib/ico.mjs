/**
 * Pure logic for `scripts/generate-favicon.mjs`, matching the
 * `scripts/lib/spec-validate.mjs` pattern: the CLI script does I/O (reading
 * the source SVG, calling `sharp`, writing files), tests call this directly.
 */

/**
 * Wraps one PNG in a minimal single-image ICO container: a 6-byte ICONDIR, a
 * 16-byte ICONDIRENTRY, then the raw PNG bytes verbatim. PNG-in-ICO has been
 * valid since Windows Vista, so no BMP re-encoding is needed — this avoids
 * adding an ico-encoding dependency for one static brand asset.
 */
export function wrapPngAsIco(pngBuffer, size) {
  if (!Number.isInteger(size) || size <= 0 || size > 255) {
    throw new Error(`wrapPngAsIco requires an icon size in 1..255, got ${size}`);
  }
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  header.writeUInt8(size, 6); // width (0 would mean 256)
  header.writeUInt8(size, 7); // height
  header.writeUInt8(0, 8); // color count (0 = no palette)
  header.writeUInt8(0, 9); // reserved
  header.writeUInt16LE(1, 10); // color planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(pngBuffer.length, 14); // size of image data
  header.writeUInt32LE(6 + 16, 18); // offset of image data
  return Buffer.concat([header, pngBuffer]);
}
