export const INDEXING_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 60 * 1000;

export interface CommandHttpResult {
  ok: boolean;
  exitCode: number;
  message: string;
}

export function exitCodeFromStatus(status: number): number {
  if (status === 401 || status === 403) return 3;
  if (status === 404) return 4;
  if (status >= 400 && status < 500) return 2;
  if (status >= 500) return 1;
  return 1;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function getCommandResultFromHttpResponse(
  status: number,
  data: unknown,
): CommandHttpResult {
  if (status < 400) {
    return { ok: true, exitCode: 0, message: "" };
  }

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const error =
      obj.error && typeof obj.error === "object"
        ? (obj.error as Record<string, unknown>)
        : obj;
    const code = typeof error.code === "string" ? error.code : `HTTP_${status}`;
    const message =
      typeof error.message === "string" ? error.message : "Request failed";
    return {
      ok: false,
      exitCode: exitCodeFromStatus(status),
      message: `${code}: ${message}`,
    };
  }
  return {
    ok: false,
    exitCode: exitCodeFromStatus(status),
    message: `HTTP_${status}: Request failed`,
  };
}

export function formatError(response: Response, data: unknown): string {
  return getCommandResultFromHttpResponse(response.status, data).message;
}

export function headersWithAuth(
  apiKey: string | undefined,
): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export function buildAttachmentUrl(
  endpoint: string,
  encodedPath: string,
  params: Record<string, string>,
): string {
  const url = new URL(`/attachments/${encodedPath}`, endpoint);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
