import { FastifyInstance } from "fastify";
import {
  InvalidPathError,
  RetrievalSizeError,
  VaultDiscovery,
  getAttachmentBytes,
  getAttachmentMetadata,
  getChunk,
  getConfiguredNote,
  resolveVaultRelativePath,
  validateVaultPath,
} from "@vault-agent/core";
import { NOTE_ID_REGEX, err, incompatibleIndexError } from "../http-utils.js";
import { getAppState } from "../state.js";
import { PathSafetyError } from "@vault-agent/core";

export function registerRetrievalRoutes(app: FastifyInstance): void {
  app.get("/notes/:noteId", async (request, reply) => {
    const { store, config } = getAppState();
    if (!store || !config) {
      return reply
        .code(409)
        .send(
          err(
            "INDEX_NOT_FOUND",
            "No usable index. Start the server to build an initial index.",
            request.id,
          ),
        );
    }

    const compatibilityError = incompatibleIndexError(store, config);
    if (compatibilityError) {
      return reply
        .code(409)
        .send(
          err(compatibilityError.code, compatibilityError.message, request.id),
        );
    }

    const { noteId } = request.params as { noteId: string };
    const { allowLarge } = request.query as { allowLarge?: string };

    if (!NOTE_ID_REGEX.test(noteId)) {
      return reply
        .code(400)
        .send(err("INVALID_ID", "Invalid note ID format.", request.id));
    }

    try {
      const result = app.vaultMutations
        ? await app.vaultMutations.getNote(noteId, allowLarge === "true")
        : await getConfiguredNote(store, noteId, config, allowLarge === "true");

      if (!result) {
        return reply
          .code(404)
          .send(err("NOTE_NOT_FOUND", `Note not found: ${noteId}`, request.id));
      }

      return {
        data: result,
        warnings: [],
      };
    } catch (error) {
      if (
        error instanceof RetrievalSizeError &&
        error.code === "NOTE_TOO_LARGE"
      ) {
        return reply
          .code(413)
          .send(err("NOTE_TOO_LARGE", error.message, request.id));
      }
      throw error;
    }
  });

  app.get("/chunks/:noteId/:chunkIndex", async (request, reply) => {
    const { store, config } = getAppState();
    if (!store || !config) {
      return reply
        .code(409)
        .send(
          err(
            "INDEX_NOT_FOUND",
            "No usable index. Start the server to build an initial index.",
            request.id,
          ),
        );
    }

    const compatibilityError = incompatibleIndexError(store, config);
    if (compatibilityError) {
      return reply
        .code(409)
        .send(
          err(compatibilityError.code, compatibilityError.message, request.id),
        );
    }

    const { noteId, chunkIndex } = request.params as {
      noteId: string;
      chunkIndex: string;
    };
    const index = parseInt(chunkIndex, 10);

    if (!NOTE_ID_REGEX.test(noteId)) {
      return reply
        .code(400)
        .send(err("INVALID_ID", "Invalid note ID format.", request.id));
    }

    if (isNaN(index) || index < 0) {
      return reply
        .code(400)
        .send(err("INVALID_ID", "Invalid chunk index.", request.id));
    }

    const expected = (request.query as { expected_version?: string })
      .expected_version;
    if (
      app.vaultMutations &&
      (typeof expected !== "string" || !expected || expected.length > 1024)
    )
      return reply
        .code(400)
        .send(
          err(
            "INVALID_REQUEST",
            "Provide expected_version from search or a current note read.",
            request.id,
          ),
        );
    const result = app.vaultMutations
      ? await app.vaultMutations.service.getChunk(noteId, index, expected)
      : await getChunk(store, noteId, index);

    if (!result) {
      return reply
        .code(404)
        .send(
          err(
            "CHUNK_NOT_FOUND",
            `Chunk not found: ${noteId}:${index}`,
            request.id,
          ),
        );
    }

    return {
      data: result,
      warnings: [],
    };
  });

  app.get("/attachments/*", async (request, reply) => {
    const { config } = getAppState();
    if (!config) {
      return reply
        .code(500)
        .send(err("CONFIG_INVALID", "Server not configured.", request.id));
    }

    if (config.vault.pcloud)
      return reply
        .code(501)
        .send(
          err(
            "CAPABILITY_UNSUPPORTED",
            "pCloud attachments are unsupported.",
            request.id,
          ),
        );

    const vaultRelativePath = (request.params as { "*": string })["*"];
    const { download, allowLarge } = request.query as {
      download?: string;
      allowLarge?: string;
    };
    if (app.vaultMutations) {
      const current =
        app.vaultMutations.service.getFileVersion(vaultRelativePath);
      if (!current)
        return reply
          .code(404)
          .send(
            err("ATTACHMENT_NOT_FOUND", "Attachment not found.", request.id),
          );
      const metadata = getAttachmentMetadata(
        config.vault.root,
        vaultRelativePath,
        config.vault.exclude,
      );
      if (!metadata)
        return reply
          .code(403)
          .send(
            err(
              "ATTACHMENT_NOT_ALLOWED",
              "Attachment not allowed.",
              request.id,
            ),
          );
      if (download !== "true")
        return {
          data: { ...metadata, version: current.version },
          warnings: [],
        };
      const attachment = app.vaultMutations.service.getAttachment(
        vaultRelativePath,
        allowLarge === "true",
      );
      if (!attachment)
        return reply
          .code(404)
          .send(
            err("ATTACHMENT_NOT_FOUND", "Attachment not found.", request.id),
          );
      reply.header("Content-Type", metadata.contentType);
      reply.header(
        "Content-Disposition",
        `attachment; filename="${metadata.fileName}"`,
      );
      reply.header("X-Vault-Source-Version", attachment.version);
      return reply.send(Buffer.from(attachment.bytes));
    }

    try {
      resolveVaultRelativePath(
        validateVaultPath(config.vault.root),
        vaultRelativePath,
      );
    } catch (error) {
      if (error instanceof PathSafetyError) {
        return reply
          .code(403)
          .send(err("PATH_OUTSIDE_VAULT", error.message, request.id));
      }
      throw error;
    }

    if (
      !VaultDiscovery.isAttachmentAllowed(
        config.vault.root,
        vaultRelativePath,
        config.vault.exclude,
      )
    ) {
      return reply
        .code(403)
        .send(
          err(
            "ATTACHMENT_NOT_ALLOWED",
            `Attachment not allowed: ${vaultRelativePath}`,
            request.id,
          ),
        );
    }

    if (download === "true") {
      try {
        const result = await getAttachmentBytes(
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
                "ATTACHMENT_NOT_FOUND",
                `Attachment not found: ${vaultRelativePath}`,
                request.id,
              ),
            );
        }

        reply.header("Content-Type", result.contentType);
        reply.header(
          "Content-Disposition",
          `attachment; filename="${result.fileName}"`,
        );
        return reply.send(result.bytes);
      } catch (error) {
        if (
          error instanceof RetrievalSizeError &&
          error.code === "ATTACHMENT_TOO_LARGE"
        ) {
          return reply
            .code(413)
            .send(err("ATTACHMENT_TOO_LARGE", error.message, request.id));
        }
        if (error instanceof PathSafetyError) {
          return reply
            .code(403)
            .send(err("PATH_OUTSIDE_VAULT", error.message, request.id));
        }
        if (error instanceof InvalidPathError) {
          return reply
            .code(400)
            .send(err("INVALID_PATH", error.message, request.id));
        }
        throw error;
      }
    }

    try {
      const metadata = await getAttachmentMetadata(
        config.vault.root,
        vaultRelativePath,
        config.vault.exclude,
      );

      if (!metadata) {
        return reply
          .code(404)
          .send(
            err(
              "ATTACHMENT_NOT_FOUND",
              `Attachment not found: ${vaultRelativePath}`,
              request.id,
            ),
          );
      }

      return {
        data: metadata,
        warnings: [],
      };
    } catch (error) {
      if (error instanceof PathSafetyError) {
        return reply
          .code(403)
          .send(err("PATH_OUTSIDE_VAULT", error.message, request.id));
      }
      if (error instanceof InvalidPathError) {
        return reply
          .code(400)
          .send(err("INVALID_PATH", error.message, request.id));
      }
      throw error;
    }
  });
}
