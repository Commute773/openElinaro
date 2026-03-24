import { test, expect } from "bun:test";
import sharp from "sharp";
import { compressImageForApi } from "./image-compression";

test("small image passes through unchanged", async () => {
  const smallPng = await sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();

  const result = await compressImageForApi(new Uint8Array(smallPng));
  expect(result.compressed).toBe(false);
  expect(result.mimeType).toBe("image/png");
  expect(result.data).toEqual(new Uint8Array(smallPng));
});

test("small JPEG passes through unchanged", async () => {
  const smallJpeg = await sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 128, b: 255 } },
  }).jpeg().toBuffer();

  const result = await compressImageForApi(new Uint8Array(smallJpeg));
  expect(result.compressed).toBe(false);
  expect(result.mimeType).toBe("image/jpeg");
});

test("large PNG is compressed to fit within base64 limit", async () => {
  // Create a large uncompressed PNG (~48 MB raw pixels, PNG will be smaller
  // but still large enough to exceed the 5 MB base64 limit)
  const largePng = await sharp({
    create: { width: 4000, height: 3000, channels: 4, background: { r: 128, g: 64, b: 192, alpha: 255 } },
  }).png({ compressionLevel: 0 }).toBuffer();

  const result = await compressImageForApi(new Uint8Array(largePng));
  expect(result.compressed).toBe(true);
  expect(result.mimeType).toBe("image/jpeg");

  const base64Length = Buffer.from(result.data).toString("base64").length;
  expect(base64Length).toBeLessThan(5 * 1024 * 1024);
});

test("returns compressed: true flag when compression occurs", async () => {
  // Force compression by using a very low maxBase64Length
  const smallPng = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();

  const result = await compressImageForApi(new Uint8Array(smallPng), { maxBase64Length: 100 });
  expect(result.compressed).toBe(true);
  expect(result.mimeType).toBe("image/jpeg");
});

test("respects custom maxBase64Length option", async () => {
  const mediumPng = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 100, g: 200, b: 50 } },
  }).png({ compressionLevel: 0 }).toBuffer();

  // The raw PNG is large enough to exceed 50 KB base64 but small enough to
  // compress well.  With the default 5 MB limit this would pass through, but
  // with a 50 KB limit it must compress.
  const customLimit = 50_000;
  const result = await compressImageForApi(new Uint8Array(mediumPng), { maxBase64Length: customLimit });
  expect(result.compressed).toBe(true);
  expect(result.mimeType).toBe("image/jpeg");

  const base64Length = Buffer.from(result.data).toString("base64").length;
  expect(base64Length).toBeLessThan(customLimit);
});

test("detects WebP mime type on passthrough", async () => {
  const smallWebp = await sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 255, b: 0 } },
  }).webp().toBuffer();

  const result = await compressImageForApi(new Uint8Array(smallWebp));
  expect(result.compressed).toBe(false);
  expect(result.mimeType).toBe("image/webp");
});
