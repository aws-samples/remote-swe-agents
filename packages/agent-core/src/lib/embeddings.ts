import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { LESSON_EMBEDDING_DIMENSIONS, LESSON_EMBEDDING_MODEL_ID } from '../schema/lesson';

/**
 * Text embedding support for the lesson (memory) store.
 *
 * IMPORTANT — inference-mode independence:
 * The agent conversation loop runs on kiro-cli (the deployment does NOT use
 * "Bedrock mode" for inference). This module is a SEPARATE, single-shot
 * `InvokeModel` call to a Bedrock embedding model, used only to compute vectors
 * for semantic retrieval of lessons. It is intentionally decoupled from the
 * conversation inference path and never touches the cross-account assumeRole
 * route. If Bedrock embeddings are unavailable in the deployment, every
 * function here fails soft (returns undefined / empty) so the agent turn is
 * never broken — callers fall back to recency-based lesson selection.
 */

/**
 * Titan Text Embeddings V2. 1024-dim, multilingual, available in ap-northeast-1.
 * Default id comes from the shared schema constant (single source of truth);
 * an `EMBEDDING_MODEL_ID` env var overrides it for the deployment.
 */
export const EMBEDDING_MODEL_ID = process.env.EMBEDDING_MODEL_ID || LESSON_EMBEDDING_MODEL_ID;

/**
 * The embedding client uses the same default credential chain / region as the
 * rest of the worker (in-account role). No cross-account assumeRole.
 */
const client = new BedrockRuntimeClient({});

/** Whether embeddings are enabled. Set EMBEDDINGS_DISABLED=1 to force the recency fallback. */
export const embeddingsEnabled = (): boolean => process.env.EMBEDDINGS_DISABLED !== '1';

/**
 * Compute an embedding vector for the given text using Titan Text Embeddings
 * V2. Returns `undefined` on ANY failure (disabled, throttling, model access,
 * malformed response) so callers can gracefully degrade — this function must
 * never throw.
 */
export const embedText = async (text: string): Promise<number[] | undefined> => {
  if (!embeddingsEnabled()) return undefined;
  const trimmed = text?.trim();
  if (!trimmed) return undefined;

  try {
    const res = await client.send(
      new InvokeModelCommand({
        modelId: EMBEDDING_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          inputText: trimmed.slice(0, 8000),
          dimensions: LESSON_EMBEDDING_DIMENSIONS,
          normalize: true,
        }),
      })
    );
    const payload = JSON.parse(new TextDecoder().decode(res.body));
    const embedding = payload?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      console.warn('[embeddings] Unexpected embedding response shape; skipping.');
      return undefined;
    }
    return embedding as number[];
  } catch (error) {
    console.warn('[embeddings] embedText failed (graceful fallback to no-embedding):', error);
    return undefined;
  }
};

/** Encode an embedding vector as a compact base64 string (Float32). */
export const encodeEmbedding = (vector: number[]): string => {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
};

/** Decode a base64 Float32 embedding back to a number[]. Returns undefined on malformed input. */
export const decodeEmbedding = (encoded: string | undefined): number[] | undefined => {
  if (!encoded) return undefined;
  try {
    const buf = Buffer.from(encoded, 'base64');
    // A valid Float32 buffer length must be a multiple of 4 bytes.
    if (buf.length === 0 || buf.length % 4 !== 0) return undefined;
    const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    return Array.from(floats);
  } catch {
    return undefined;
  }
};

/**
 * Cosine similarity between two vectors. Returns 0 for mismatched or empty
 * vectors. Titan V2 vectors are L2-normalized (normalize:true) so this reduces
 * to a dot product, but we compute the full form defensively in case a stored
 * vector was produced without normalization.
 */
export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};
