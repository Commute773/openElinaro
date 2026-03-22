/**
 * Audio buffer management and speech detection for Gemini live phone calls.
 *
 * Includes:
 * - PCM constants and audio statistics tracking
 * - Speech energy detection (`hasSpeechLikeEnergy`)
 * - Audio packet recording and stream statistics
 * - Linear PCM resampling between sample rates
 * - Buffer conversion utilities
 */

/** Bytes per millisecond for 16 kHz 16-bit mono PCM. */
export const PCM_16KHZ_BYTES_PER_MS = 32;

/** Default RMS threshold for classifying a chunk as speech. */
export const DEFAULT_INBOUND_SPEECH_ENERGY_THRESHOLD = 700;

export type AudioStreamStats = {
  packets: number;
  bytes: number;
  firstPacketAt: string | null;
  lastPacketAt: string | null;
  gapCount: number;
  avgGapMs: number | null;
  maxGapMs: number | null;
  avgChunkMs: number | null;
  maxChunkMs: number | null;
};

export function emptyAudioStreamStats(): AudioStreamStats {
  return {
    packets: 0,
    bytes: 0,
    firstPacketAt: null,
    lastPacketAt: null,
    gapCount: 0,
    avgGapMs: null,
    maxGapMs: null,
    avgChunkMs: null,
    maxChunkMs: null,
  };
}

export function bytesToPcm16kDurationMs(byteLength: number) {
  return Math.max(0, Math.round(byteLength / PCM_16KHZ_BYTES_PER_MS));
}

/**
 * Returns `true` when the average sample magnitude of the given PCM-16 audio
 * buffer exceeds the speech energy threshold.
 */
export function hasSpeechLikeEnergy(
  audio: Buffer,
  threshold = DEFAULT_INBOUND_SPEECH_ENERGY_THRESHOLD,
) {
  if (audio.length < 2) {
    return false;
  }
  let total = 0;
  let sampleCount = 0;
  for (let index = 0; index + 1 < audio.length; index += 2) {
    total += Math.abs(audio.readInt16LE(index));
    sampleCount += 1;
  }
  if (sampleCount === 0) {
    return false;
  }
  const averageMagnitude = total / sampleCount;
  return averageMagnitude >= threshold;
}

/**
 * Records a single audio packet into the running stream statistics, updating
 * packet counts, byte totals, inter-packet gap metrics, and chunk duration
 * metrics.
 */
export function recordAudioPacket(
  stats: AudioStreamStats,
  byteLength: number,
  timestamp: string,
  isoToMs: (v: string | null | undefined) => number | null,
) {
  const currentMs = isoToMs(timestamp);
  const previousMs = isoToMs(stats.lastPacketAt);
  const chunkMs = bytesToPcm16kDurationMs(byteLength);
  stats.packets += 1;
  stats.bytes += byteLength;
  stats.firstPacketAt ??= timestamp;
  stats.maxChunkMs =
    stats.maxChunkMs === null ? chunkMs : Math.max(stats.maxChunkMs, chunkMs);
  stats.avgChunkMs =
    stats.avgChunkMs === null
      ? chunkMs
      : Math.round(
          (stats.avgChunkMs * (stats.packets - 1) + chunkMs) / stats.packets,
        );
  if (currentMs !== null && previousMs !== null) {
    const gapMs = Math.max(0, currentMs - previousMs);
    stats.maxGapMs =
      stats.maxGapMs === null ? gapMs : Math.max(stats.maxGapMs, gapMs);
    stats.avgGapMs =
      stats.avgGapMs === null
        ? gapMs
        : Math.round(
            (stats.avgGapMs * stats.gapCount + gapMs) / (stats.gapCount + 1),
          );
    stats.gapCount += 1;
  }
  stats.lastPacketAt = timestamp;
}

/** Converts any incoming websocket message to a `Buffer`. */
export function toBuffer(
  message: string | Buffer | ArrayBuffer | Uint8Array,
) {
  if (typeof message === "string") {
    return Buffer.from(message, "utf8");
  }
  if (Buffer.isBuffer(message)) {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return Buffer.from(message);
  }
  return Buffer.from(message.buffer, message.byteOffset, message.byteLength);
}

/**
 * Linear interpolation resampler for 16-bit mono PCM audio.
 *
 * Converts from `inputRate` to `outputRate` by linearly interpolating between
 * adjacent samples. Handles partial frames across successive `push()` calls.
 */
export class LinearPcmResampler {
  private readonly step: number;
  private leftover = Buffer.alloc(0);
  private sourcePosition = 0;

  constructor(
    private readonly inputRate: number,
    private readonly outputRate: number,
  ) {
    this.step = inputRate / outputRate;
  }

  push(chunk: Buffer) {
    if (chunk.length === 0 || this.inputRate === this.outputRate) {
      return Buffer.from(chunk);
    }

    this.leftover =
      this.leftover.length > 0
        ? Buffer.concat([this.leftover, chunk])
        : Buffer.from(chunk);

    const sampleCount = Math.floor(this.leftover.length / 2);
    if (sampleCount < 2) {
      return Buffer.alloc(0);
    }

    const samples = new Int16Array(sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
      samples[index] = this.leftover.readInt16LE(index * 2);
    }

    const output: number[] = [];
    while (this.sourcePosition + 1 < sampleCount) {
      const leftIndex = Math.floor(this.sourcePosition);
      const rightIndex = Math.min(leftIndex + 1, sampleCount - 1);
      const fraction = this.sourcePosition - leftIndex;
      const left = samples[leftIndex] ?? 0;
      const right = samples[rightIndex] ?? left;
      const interpolated = left + (right - left) * fraction;
      output.push(
        Math.max(-32768, Math.min(32767, Math.round(interpolated))),
      );
      this.sourcePosition += this.step;
    }

    const consumedSamples = Math.max(0, Math.floor(this.sourcePosition));
    const remainingSamples = Math.max(0, sampleCount - consumedSamples);
    const remainingBytes = remainingSamples * 2;
    this.leftover =
      remainingBytes > 0
        ? Buffer.from(
            this.leftover.subarray(
              consumedSamples * 2,
              consumedSamples * 2 + remainingBytes,
            ),
          )
        : Buffer.alloc(0);
    this.sourcePosition -= consumedSamples;

    const outputBuffer = Buffer.alloc(output.length * 2);
    for (let index = 0; index < output.length; index += 1) {
      outputBuffer.writeInt16LE(output[index] ?? 0, index * 2);
    }
    return outputBuffer;
  }
}
