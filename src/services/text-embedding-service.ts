import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
  type Tensor,
} from "@xenova/transformers";
import { resolveRuntimePath } from "./runtime-root";

const EMBEDDING_CACHE_DIR = resolveRuntimePath("models/transformers");
export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_BATCH_SIZE = 8;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
let extractorStatus: "cold" | "loading" | "ready" = "cold";

export function isEmbeddingExtractorReady() {
  return extractorStatus === "ready";
}

async function getEmbeddingExtractor() {
  env.cacheDir = EMBEDDING_CACHE_DIR;
  env.allowLocalModels = true;
  env.allowRemoteModels = true;

  if (!extractorPromise) {
    extractorStatus = "loading";
    extractorPromise = (pipeline(
      "feature-extraction",
      EMBEDDING_MODEL_ID,
    ) as Promise<FeatureExtractionPipeline>)
      .then((extractor) => {
        extractorStatus = "ready";
        return extractor;
      })
      .catch((error) => {
        extractorStatus = "cold";
        extractorPromise = null;
        throw error;
      });
  }

  return extractorPromise;
}

export async function embedTexts(texts: string[]) {
  const extractor = await getEmbeddingExtractor();
  const vectors: number[][] = [];

  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    if (batch.length === 0) {
      continue;
    }

    const output = await extractor(batch, {
      pooling: "mean",
      normalize: true,
    }) as Tensor;
    const rows = output.dims[0] ?? 0;
    const dimensions = output.dims[1] ?? 0;
    const raw = Array.from(output.data as Float32Array);
    for (let row = 0; row < rows; row += 1) {
      const offset = row * dimensions;
      vectors.push(raw.slice(offset, offset + dimensions));
    }
  }

  return vectors;
}
