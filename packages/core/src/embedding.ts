import { Config } from "./config.js";
import { isIP } from "node:net";
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_REQUEST_TIMEOUT_MS,
} from "./schemas.js";

export interface EmbeddingResponse {
  embeddings: Float32Array[];
  model: string;
  dimension: number;
}

export interface EmbeddingWarning {
  code: string;
  message: string;
  path?: string;
}

function isLocalhostHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function isPrivateIPv4(host: string): boolean {
  if (isIP(host) !== 4) return false;
  const [first, second] = host.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168)
  );
}

function isUniqueLocalIPv6(host: string): boolean {
  if (isIP(host) !== 6) return false;
  const firstHextet = Number.parseInt(host.split(":", 1)[0]!, 16);
  const firstByte = firstHextet >>> 8;
  return firstByte === 0xfc || firstByte === 0xfd;
}

function isPrivateNetworkHostname(host: string): boolean {
  if (host === "host.docker.internal") return true;

  const labels = host.split(".");
  const validLabels = labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/i.test(label),
  );
  if (!validLabels) return false;

  if (labels.length === 1) return true;
  return (
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".home.arpa")
  );
}

function isPrivateNetworkHost(host: string): boolean {
  const unbracketedHost = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    isPrivateIPv4(unbracketedHost) ||
    isUniqueLocalIPv6(unbracketedHost) ||
    isPrivateNetworkHostname(unbracketedHost)
  );
}

export function validateEmbeddingEndpoint(
  endpoint: string,
  allowPrivateNetworkEndpoint = false,
): string | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Embedding endpoint must be an HTTP or HTTPS URL";
    }
    if (
      !isLocalhostHost(url.hostname) &&
      (!allowPrivateNetworkEndpoint || !isPrivateNetworkHost(url.hostname))
    ) {
      if (allowPrivateNetworkEndpoint) {
        return "Embedding endpoint must use localhost or an allowed private-network host";
      }
      return "Embedding endpoint must use a localhost address (127.0.0.1, localhost, or ::1)";
    }
    return null;
  } catch {
    return "Invalid embedding endpoint URL";
  }
}

export class EmbeddingProvider {
  private endpoint: string;
  private model: string;
  private timeout: number;

  constructor(config: Config) {
    this.endpoint = config.embedding.endpoint;
    this.model = config.embedding.model;
    this.timeout = EMBEDDING_REQUEST_TIMEOUT_MS;
  }

  async embed(texts: string[]): Promise<EmbeddingResponse> {
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      batches.push(texts.slice(i, i + EMBEDDING_BATCH_SIZE));
    }

    const allEmbeddings: Float32Array[] = [];
    let responseModel = "";
    let dimension = 0;

    for (const batch of batches) {
      const response = await this.embedBatch(batch);
      allEmbeddings.push(...response.embeddings);
      if (!responseModel) {
        responseModel = response.model;
        dimension = response.dimension;
      }
    }

    return {
      embeddings: allEmbeddings,
      model: responseModel,
      dimension,
    };
  }

  private async embedBatch(texts: string[]): Promise<EmbeddingResponse> {
    const body = JSON.stringify({
      model: this.model,
      input: texts,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new EmbeddingProviderError(
          `Embedding provider returned HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
          response.status,
        );
      }

      const data = (await response.json()) as {
        model?: string;
        data?: Array<{ embedding?: number[] }>;
      };

      if (!data.data || !Array.isArray(data.data)) {
        throw new EmbeddingProviderError(
          "Embedding provider returned invalid response format",
        );
      }

      const embeddings = data.data.map((item) => {
        if (!item.embedding || !Array.isArray(item.embedding)) {
          throw new EmbeddingProviderError(
            "Embedding provider returned missing embedding data",
          );
        }
        return new Float32Array(item.embedding as number[]);
      });

      const dim = embeddings.length > 0 ? embeddings[0]!.length : 0;

      return {
        embeddings,
        model: data.model ?? this.model,
        dimension: dim,
      };
    } catch (error) {
      if (error instanceof EmbeddingProviderError) {
        throw error;
      }
      if ((error as Error).name === "AbortError") {
        throw new EmbeddingProviderError(
          `Embedding request timed out after ${this.timeout / 1000}s`,
        );
      }
      throw new EmbeddingProviderError(
        `Embedding provider request failed: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export class EmbeddingProviderError extends Error {
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "EmbeddingProviderError";
    this.statusCode = statusCode;
  }
}

export async function generateChunkEmbeddings(
  provider: EmbeddingProvider,
  chunkTexts: string[],
  contentHashes: string[],
): Promise<{ embeddings: Float32Array[]; model: string; dimension: number }> {
  if (chunkTexts.length !== contentHashes.length) {
    throw new Error("chunkTexts and contentHashes must have the same length");
  }

  const response = await provider.embed(chunkTexts);
  return {
    embeddings: response.embeddings,
    model: response.model,
    dimension: response.dimension,
  };
}
