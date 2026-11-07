import { describe, expect, it } from 'vitest';
import { wrapPngAsIco } from './ico.mjs';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('wrapPngAsIco', () => {
  it('produces a valid single-image ICONDIR/ICONDIRENTRY header around the PNG bytes', () => {
    const png = Buffer.concat([PNG_MAGIC, Buffer.from('fake-png-body')]);
    const ico = wrapPngAsIco(png, 32);

    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    expect(ico.readUInt16LE(4)).toBe(1); // one image
    expect(ico.readUInt8(6)).toBe(32); // width
    expect(ico.readUInt8(7)).toBe(32); // height
    expect(ico.readUInt16LE(12)).toBe(32); // bits per pixel
    expect(ico.readUInt32LE(14)).toBe(png.length); // embedded PNG length
    expect(ico.readUInt32LE(18)).toBe(22); // offset: 6-byte ICONDIR + 16-byte ICONDIRENTRY
    expect(ico.subarray(22)).toEqual(png);
    expect(ico.subarray(22, 30)).toEqual(PNG_MAGIC);
  });

  it('rejects a size that cannot be represented in the one-byte width/height field', () => {
    expect(() => wrapPngAsIco(Buffer.from('x'), 0)).toThrow();
    expect(() => wrapPngAsIco(Buffer.from('x'), 256)).toThrow();
    expect(() => wrapPngAsIco(Buffer.from('x'), -1)).toThrow();
    expect(() => wrapPngAsIco(Buffer.from('x'), 1.5)).toThrow();
  });
});
