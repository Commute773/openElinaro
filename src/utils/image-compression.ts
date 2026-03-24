const MAX_API_BASE64_LENGTH = 5 * 1024 * 1024;

export async function compressImageForApi(
  bytes: Uint8Array,
  options?: { maxBase64Length?: number },
): Promise<{ data: Uint8Array; mimeType: string; compressed: boolean }> {
  const maxBase64 = options?.maxBase64Length ?? MAX_API_BASE64_LENGTH;

  // Fast path: if base64 would fit, return as-is
  const estimatedBase64Length = Math.ceil(bytes.length * 4 / 3);
  if (estimatedBase64Length <= maxBase64) {
    const mimeType = detectMimeFromBytes(bytes) ?? "image/png";
    return { data: bytes, mimeType, compressed: false };
  }

  // Need compression — lazy import sharp
  const sharp = (await import("sharp")).default;

  // Target raw bytes that will produce base64 under the limit (with margin)
  const targetBytes = Math.floor(maxBase64 * 3 / 4) - 1024;

  const passes: Array<{ quality: number; maxDimension: number | undefined }> = [
    { quality: 85, maxDimension: undefined },
    { quality: 80, maxDimension: 3000 },
    { quality: 70, maxDimension: 2048 },
    { quality: 60, maxDimension: 1024 },
  ];

  for (const pass of passes) {
    let pipeline = sharp(bytes);
    if (pass.maxDimension) {
      pipeline = pipeline.resize(pass.maxDimension, pass.maxDimension, {
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    const result = await pipeline.jpeg({ quality: pass.quality }).toBuffer();
    if (result.length <= targetBytes) {
      return { data: new Uint8Array(result), mimeType: "image/jpeg", compressed: true };
    }
  }

  // Return the smallest we achieved even if still over
  const lastPass = passes[passes.length - 1]!;
  const result = await sharp(bytes)
    .resize(lastPass.maxDimension, lastPass.maxDimension, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: lastPass.quality })
    .toBuffer();
  return { data: new Uint8Array(result), mimeType: "image/jpeg", compressed: true };
}

function detectMimeFromBytes(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return "image/gif";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return undefined;
}
