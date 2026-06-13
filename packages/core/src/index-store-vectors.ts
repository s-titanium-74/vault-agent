export function float32ArrayToBuffer(value: Float32Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export function parseVectorDimension(sql: string): number | null {
  const match = sql.match(/float\[(\d+)\]/);
  return match ? parseInt(match[1]!, 10) : null;
}
