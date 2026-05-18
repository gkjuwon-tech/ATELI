import { loadConfig, requireVoyageConfig } from "../config.js";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

/**
 * Voyage AI batch sizes:
 *   voyage-code-3 — up to 128 inputs per request, 320K tokens per request.
 * We keep batches small (64) to stay well under both ceilings.
 */
const BATCH = 64;

export interface EmbedResult {
  vectors: number[][];
  model: string;
  total_tokens: number;
}

export async function embed(
  texts: string[],
  inputType: "query" | "document",
): Promise<EmbedResult> {
  const cfg = loadConfig();
  requireVoyageConfig(cfg);

  if (texts.length === 0) {
    return { vectors: [], model: cfg.VOYAGE_EMBED_MODEL, total_tokens: 0 };
  }

  const all: number[][] = [];
  let totalTokens = 0;

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: cfg.VOYAGE_EMBED_MODEL,
        input: batch,
        input_type: inputType,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `voyage embeddings failed: ${res.status} ${res.statusText}: ${body.slice(0, 400)}`,
      );
    }
    const json = (await res.json()) as {
      data: { embedding: number[]; index: number }[];
      usage: { total_tokens: number };
      model: string;
    };
    // Voyage may return out-of-order — sort by index.
    const sorted = json.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
    all.push(...sorted);
    totalTokens += json.usage.total_tokens;
  }

  return { vectors: all, model: cfg.VOYAGE_EMBED_MODEL, total_tokens: totalTokens };
}

/** voyage-code-3 returns 1024-d vectors. Update if you change models. */
export function expectedDim(model: string): number {
  if (model === "voyage-code-3") return 1024;
  if (model === "voyage-3") return 1024;
  if (model === "voyage-3-large") return 1024;
  if (model === "voyage-3-lite") return 512;
  return 1024;
}
