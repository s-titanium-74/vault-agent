import { Command } from "commander";
import { loadConfig } from "@vault-agent/core";
import { CliContext } from "../context.js";
import {
  DEFAULT_TIMEOUT_MS,
  buildAttachmentUrl,
  exitCodeFromStatus,
  fetchWithTimeout,
  formatError,
  headersWithAuth,
} from "../http.js";

export function registerRetrievalCommands(
  program: Command,
  context: CliContext,
): void {
  const getCmd = program.command("get").description("Retrieve vault content");

  getCmd
    .command("note <noteId>")
    .description("Retrieve a note by ID")
    .option("--allow-large", "Allow retrieval of large notes")
    .option("--json", "Output as JSON")
    .action(async (noteId, opts) => {
      const config = loadConfig(context.resolveConfigPath());
      const endpoint = context.resolveEndpoint(config);
      const apiKey = context.resolveApiKey(config);

      const params = new URLSearchParams();
      if (opts.allowLarge) params.set("allowLarge", "true");
      const qs = params.toString();
      const url = `${endpoint}/notes/${noteId}${qs ? `?${qs}` : ""}`;

      try {
        const response = await fetchWithTimeout(
          url,
          { headers: headersWithAuth(apiKey) },
          DEFAULT_TIMEOUT_MS,
        );

        const data = await response.json();

        if (response.status >= 400) {
          process.exit(exitCodeFromStatus(response.status));
        }

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const result = data.data ?? data;
          console.error(`Path: ${result.path}`);
          console.error(`Title: ${result.title ?? "(untitled)"}`);
          console.error(`Size: ${result.size} bytes`);
          console.log(result.content);
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          console.error(`TIMEOUT: Request timed out.`);
        } else {
          console.error(
            `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
          );
        }
        process.exit(1);
      }
    });

  getCmd
    .command("chunk <noteId> [chunkIndex]")
    .description("Retrieve a chunk by note ID and chunk index")
    .option("--json", "Output as JSON")
    .action(async (noteId, chunkIndex, opts) => {
      const config = loadConfig(context.resolveConfigPath());
      const endpoint = context.resolveEndpoint(config);
      const apiKey = context.resolveApiKey(config);

      let url: string;
      if (chunkIndex !== undefined) {
        url = `${endpoint}/chunks/${noteId}/${chunkIndex}`;
      } else if (noteId.includes(":")) {
        const parts = noteId.split(":");
        url = `${endpoint}/chunks/${parts[0]}/${parts[1]}`;
      } else {
        console.error(
          "INVALID_ID: Provide note ID and chunk index, or a chunk ID in noteId:chunkIndex format.",
        );
        process.exit(2);
        return;
      }

      try {
        const response = await fetchWithTimeout(
          url,
          { headers: headersWithAuth(apiKey) },
          DEFAULT_TIMEOUT_MS,
        );

        const data = await response.json();

        if (response.status >= 400) {
          process.exit(exitCodeFromStatus(response.status));
        }

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const result = data.data ?? data;
          console.error(`Path: ${result.path}`);
          console.error(`Heading: ${result.heading ?? "(untitled)"}`);
          console.error(`Size: ${result.size} bytes`);
          console.log(result.content);
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          console.error(`TIMEOUT: Request timed out.`);
        } else {
          console.error(
            `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
          );
        }
        process.exit(1);
      }
    });

  getCmd
    .command("attachment <vaultRelativePath>")
    .description("Retrieve attachment metadata or download")
    .option("--download", "Download attachment bytes")
    .option("--output <path>", "Output file path (required with --download)")
    .option("--allow-large", "Allow large attachment downloads")
    .option("--json", "Output as JSON")
    .action(async (vaultRelativePath, opts) => {
      const config = loadConfig(context.resolveConfigPath());
      const endpoint = context.resolveEndpoint(config);
      const apiKey = context.resolveApiKey(config);

      if (opts.download && !opts.output) {
        console.error(
          "INVALID_REQUEST: --download requires --output <path> or --output -",
        );
        process.exit(2);
        return;
      }

      const params: Record<string, string> = {};
      if (opts.download) params.download = "true";
      if (opts.allowLarge) params.allowLarge = "true";

      const encodedPath = encodeURIComponent(vaultRelativePath);
      const url = buildAttachmentUrl(endpoint, encodedPath, params);

      try {
        const response = await fetchWithTimeout(
          url,
          {
            headers: {
              ...headersWithAuth(apiKey),
              ...(opts.download ? { Accept: "application/octet-stream" } : {}),
            },
          },
          opts.download ? DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
        );

        if (opts.download && response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());

          if (opts.output === "-") {
            process.stdout.write(buffer);
          } else {
            const fs = await import("node:fs");
            fs.writeFileSync(opts.output, buffer);
            if (!opts.json) {
              console.log(`Saved to ${opts.output}`);
            } else {
              console.log(
                JSON.stringify({ saved: opts.output, size: buffer.length }),
              );
            }
          }
          return;
        }

        const data = await response.json();

        if (response.status >= 400) {
          if (opts.json) {
            console.log(JSON.stringify(data, null, 2));
          } else {
            console.error(formatError(response, data));
          }
          process.exit(exitCodeFromStatus(response.status));
        }

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const result = data.data ?? data;
          console.log(`Path: ${result.path}`);
          console.log(`Type: ${result.contentType}`);
          console.log(`Size: ${result.size} bytes`);
          console.log(`Download available: ${result.downloadAvailable}`);
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          console.error(`TIMEOUT: Request timed out.`);
        } else {
          console.error(
            `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
          );
        }
        process.exit(1);
      }
    });
}
