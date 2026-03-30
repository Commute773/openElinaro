import { test, expect, describe } from "bun:test";
import { detectMimeFromBytes } from "./image-compression";

// ---------------------------------------------------------------------------
// detectMimeFromBytes
// ---------------------------------------------------------------------------
describe("detectMimeFromBytes", () => {
  test("detects PNG from magic bytes", () => {
    // PNG header: 89 50 4E 47 0D 0A 1A 0A
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectMimeFromBytes(png)).toBe("image/png");
  });

  test("detects JPEG from magic bytes", () => {
    // JPEG header: FF D8 FF
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectMimeFromBytes(jpeg)).toBe("image/jpeg");
  });

  test("detects GIF from magic bytes", () => {
    // GIF header: 47 49 46 (GIF87a or GIF89a)
    const gif87 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
    expect(detectMimeFromBytes(gif87)).toBe("image/gif");

    const gif89 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectMimeFromBytes(gif89)).toBe("image/gif");
  });

  test("detects WebP from magic bytes", () => {
    // WebP header: RIFF....WEBP
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // file size (don't care)
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    expect(detectMimeFromBytes(webp)).toBe("image/webp");
  });

  test("returns undefined for unknown bytes", () => {
    const unknown = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(detectMimeFromBytes(unknown)).toBeUndefined();
  });

  test("returns undefined for empty buffer", () => {
    const empty = new Uint8Array([]);
    expect(detectMimeFromBytes(empty)).toBeUndefined();
  });

  test("returns undefined for buffer too short for any format", () => {
    const short = new Uint8Array([0x89, 0x50]);
    expect(detectMimeFromBytes(short)).toBeUndefined();
  });

  test("detects PNG with additional trailing data", () => {
    const pngPlusExtra = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0xff, 0xff, 0xff, 0xff, // extra data
    ]);
    expect(detectMimeFromBytes(pngPlusExtra)).toBe("image/png");
  });

  test("does not falsely detect partial RIFF as WebP", () => {
    // RIFF header but not WEBP
    const riffNotWebp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x41, 0x56, 0x49, 0x20, // AVI instead of WEBP
    ]);
    expect(detectMimeFromBytes(riffNotWebp)).toBeUndefined();
  });
});
