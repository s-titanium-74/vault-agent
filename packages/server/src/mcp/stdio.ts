import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Transform } from "node:stream";
import { MCP_WRITE_REQUEST_BYTES } from "./mutations.js";

export function boundedStdioInput(
  maxBytes = MCP_WRITE_REQUEST_BYTES,
): Transform {
  let length = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        callback(new Error("MCP frame is not valid UTF-8."));
        return;
      }
      for (const byte of chunk) {
        if (byte === 10) length = 0;
        else if (++length > maxBytes) {
          callback(new Error("MCP frame exceeds size limit."));
          return;
        }
      }
      callback(null, chunk);
    },
    flush(callback) {
      try {
        decoder.decode();
        callback();
      } catch {
        callback(new Error("MCP frame is not valid UTF-8."));
      }
    },
  });
}

export function runMcpStdio(server: Server): Promise<void> {
  const input = boundedStdioInput();
  const transport = new StdioServerTransport(input);

  return new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      process.stdin.removeListener("end", shutdown);
      process.stdin.unpipe(input);
      process.stdin.pause();
      server
        .close()
        .catch(() => {
          // ignore cleanup errors
        })
        .finally(() => resolve());
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.stdin.once("end", shutdown);
    input.once("error", shutdown);

    server
      .connect(transport)
      .then(() => process.stdin.pipe(input))
      .catch(shutdown);
  });
}
