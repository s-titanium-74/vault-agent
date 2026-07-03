import type { FastifyInstance } from "fastify";

/**
 * Fastify's inject() uses a mock socket that lacks destroySoon. Some transports
 * (e.g. MCP's Streamable HTTP timeout cleanup) call it, so we polyfill it for
 * tests to avoid unhandled exceptions.
 */
export function patchMockSocketDestroySoon(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    const socket = request.raw.socket as
      import("node:net").Socket | undefined | null;
    if (socket && typeof socket.destroySoon !== "function") {
      (socket as { destroySoon?: () => void }).destroySoon = () => {
        if (typeof socket.destroy === "function") {
          socket.destroy();
        }
      };
    }
  });
}
