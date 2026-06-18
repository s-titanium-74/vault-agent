import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

export function runMcpStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();

  return new Promise<void>((resolve) => {
    const shutdown = () => {
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

    server.connect(transport).catch(() => resolve());
  });
}
