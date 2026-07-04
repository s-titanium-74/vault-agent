import { FastifyInstance } from "fastify";
import {
  PathSafetyError,
  RetrievalSizeError,
  getAgentGuidance,
  listAgentGuidance,
} from "@vault-agent/core";
import { err } from "../http-utils.js";
import { getAppState } from "../state.js";

export function registerGuidanceRoutes(app: FastifyInstance): void {
  app.get("/agent-guidance", async (request, reply) => {
    const { config } = getAppState();
    if (!config) {
      return reply
        .code(409)
        .send(
          err("VAULT_NOT_CONFIGURED", "Server not configured.", request.id),
        );
    }

    try {
      return {
        data: listAgentGuidance(config.vault.root, config.vault.exclude),
        warnings: [],
      };
    } catch (error) {
      if (error instanceof PathSafetyError) {
        return reply.code(400).send(err(error.code, error.message, request.id));
      }
      throw error;
    }
  });

  app.get("/agent-guidance/*", async (request, reply) => {
    const { config } = getAppState();
    if (!config) {
      return reply
        .code(409)
        .send(
          err("VAULT_NOT_CONFIGURED", "Server not configured.", request.id),
        );
    }

    const vaultRelativePath = (request.params as { "*": string })["*"];
    const { allowLarge } = request.query as { allowLarge?: string };

    try {
      const result = getAgentGuidance(
        config.vault.root,
        vaultRelativePath,
        allowLarge === "true",
        config.vault.exclude,
      );

      if (!result) {
        return reply
          .code(404)
          .send(
            err(
              "GUIDANCE_NOT_FOUND",
              `Guidance file not found: ${vaultRelativePath}`,
              request.id,
            ),
          );
      }

      return { data: result, warnings: [] };
    } catch (error) {
      if (error instanceof RetrievalSizeError) {
        return reply
          .code(413)
          .send(err("GUIDANCE_TOO_LARGE", error.message, request.id));
      }
      if (error instanceof PathSafetyError) {
        return reply
          .code(403)
          .send(err("PATH_OUTSIDE_VAULT", error.message, request.id));
      }
      throw error;
    }
  });
}
