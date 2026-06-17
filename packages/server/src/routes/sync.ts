import { FastifyInstance } from "fastify";
import { err, constantTimeEqual } from "../http-utils.js";
import { getAppState } from "../state.js";
import { SyncError } from "@vault-agent/core";

export function registerSyncRoutes(app: FastifyInstance): void {
  app.post("/sync/pull", async (request, reply) => {
    const { config, gitSync } = getAppState();

    if (!config) {
      reply
        .code(409)
        .send(err("CONFIG_NOT_FOUND", "Server not initialized.", request.id));
      return;
    }

    if (!gitSync) {
      reply
        .code(409)
        .send(
          err("SYNC_NOT_CONFIGURED", "Git sync is not configured.", request.id),
        );
      return;
    }

    if (!config.sync.repo) {
      reply
        .code(400)
        .send(
          err(
            "SYNC_NOT_CONFIGURED",
            "No sync repository configured.",
            request.id,
          ),
        );
      return;
    }

    const body = request.body as
      | { wait?: boolean; timeoutSeconds?: number }
      | undefined;
    const wait = body?.wait ?? false;
    const timeoutSeconds =
      body?.timeoutSeconds ?? config.sync.pull_timeout_seconds;

    try {
      const result = await gitSync.pull({ wait, timeoutSeconds });
      const { freshnessMachine } = getAppState();
      const indexFreshness = freshnessMachine?.info.state ?? "fresh";
      reply.send({
        data: {
          status: result.status,
          changed: result.changed,
          indexFreshness,
          startedAt: new Date(result.startedAt).toISOString(),
          finishedAt: new Date(result.finishedAt).toISOString(),
        },
        warnings: [],
      });
    } catch (syncErr) {
      if (syncErr instanceof SyncError) {
        if (syncErr.code === "SYNC_IN_PROGRESS") {
          reply.code(409).send(err(syncErr.code, syncErr.message, request.id));
          return;
        }
        reply.code(400).send(err(syncErr.code, syncErr.message, request.id));
        return;
      }
      reply
        .code(500)
        .send(err("SYNC_FAILED", (syncErr as Error).message, request.id));
    }
  });

  app.post("/sync/webhook", async (request, reply) => {
    const { config, gitSync } = getAppState();

    if (!config) {
      reply
        .code(409)
        .send(err("CONFIG_NOT_FOUND", "Server not initialized.", request.id));
      return;
    }

    if (!gitSync) {
      reply
        .code(409)
        .send(
          err(
            "WEBHOOK_SYNC_NOT_CONFIGURED",
            "Git sync is not configured.",
            request.id,
          ),
        );
      return;
    }

    if (!config.sync.webhook_enabled) {
      reply
        .code(403)
        .send(
          err("WEBHOOK_DISABLED", "Webhook sync is not enabled.", request.id),
        );
      return;
    }

    if (!config.sync.enabled) {
      reply
        .code(409)
        .send(
          err(
            "WEBHOOK_SYNC_NOT_CONFIGURED",
            "Sync is not enabled. Set sync.enabled = true to use webhook-triggered sync.",
            request.id,
          ),
        );
      return;
    }

    if (!config.sync.webhook_secret) {
      reply
        .code(503)
        .send(
          err(
            "WEBHOOK_SECRET_NOT_CONFIGURED",
            "Webhook secret is not configured.",
            request.id,
          ),
        );
      return;
    }

    const secretHeader = request.headers["x-vault-agent-webhook-secret"];
    if (!secretHeader || typeof secretHeader !== "string") {
      reply
        .code(401)
        .send(
          err(
            "WEBHOOK_SECRET_INVALID",
            "Missing webhook secret header.",
            request.id,
          ),
        );
      return;
    }

    if (!constantTimeEqual(secretHeader, config.sync.webhook_secret)) {
      reply
        .code(401)
        .send(
          err("WEBHOOK_SECRET_INVALID", "Invalid webhook secret.", request.id),
        );
      return;
    }

    const rawBody = request.body;
    if (
      rawBody &&
      typeof rawBody === "object" &&
      Object.keys(rawBody).length > 0
    ) {
      // Payload content is ignored; sync is triggered on valid secret alone
    }

    try {
      await gitSync.handleWebhook(secretHeader, rawBody);
      reply.code(202).send({
        data: { accepted: true },
        warnings: [],
      });
    } catch (syncErr) {
      if (syncErr instanceof SyncError) {
        if (syncErr.code === "WEBHOOK_RATE_LIMITED") {
          reply.code(429).send(err(syncErr.code, syncErr.message, request.id));
          return;
        }
        if (syncErr.code === "WEBHOOK_BODY_TOO_LARGE") {
          reply.code(413).send(err(syncErr.code, syncErr.message, request.id));
          return;
        }
        reply.code(400).send(err(syncErr.code, syncErr.message, request.id));
        return;
      }
      reply
        .code(500)
        .send(err("WEBHOOK_FAILED", (syncErr as Error).message, request.id));
    }
  });

  app.get("/sync/webhook", async (_request, reply) => {
    reply
      .code(405)
      .send(
        err(
          "WEBHOOK_INVALID_METHOD",
          "Webhook endpoint only accepts POST requests.",
          _request.id,
        ),
      );
  });

  app.put("/sync/webhook", async (_request, reply) => {
    reply
      .code(405)
      .send(
        err(
          "WEBHOOK_INVALID_METHOD",
          "Webhook endpoint only accepts POST requests.",
          _request.id,
        ),
      );
  });

  app.delete("/sync/webhook", async (_request, reply) => {
    reply
      .code(405)
      .send(
        err(
          "WEBHOOK_INVALID_METHOD",
          "Webhook endpoint only accepts POST requests.",
          _request.id,
        ),
      );
  });

  app.get("/sync/pull", async (_request, reply) => {
    reply
      .code(405)
      .send(
        err(
          "INVALID_METHOD",
          "Sync pull endpoint only accepts POST requests.",
          _request.id,
        ),
      );
  });
}
