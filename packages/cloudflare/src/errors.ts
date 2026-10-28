export class CloudError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
export function failure(code: string, status: number) {
  return Response.json(
    {
      error: {
        code,
        message: "The operation could not be completed.",
        details: { requestId: crypto.randomUUID() },
      },
    },
    { status },
  );
}
export async function boundedBytes(
  stream: ReadableStream<Uint8Array>,
  max: number,
  signal?: AbortSignal,
) {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) throw new CloudError("SOURCE_TOO_LARGE", 413);
      parts.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
