import { Command } from "commander";
import { registerConfigCommands } from "./commands/config.js";
import { registerIndexingCommands } from "./commands/indexing.js";
import { registerRetrievalCommands } from "./commands/retrieval.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerServeCommand } from "./commands/serve.js";
import { registerStatusCommands } from "./commands/status.js";
import { registerSyncCommands } from "./commands/sync.js";
import { createCliContext } from "./context.js";
export {
  getCommandResultFromHttpResponse,
  type CommandHttpResult,
} from "./http.js";

export const program = new Command();
const context = createCliContext(program);

program
  .name("vault-agent")
  .version("0.1.0")
  .option("--config <path>", "Path to config file")
  .option("--endpoint <url>", "Server endpoint URL")
  .option("--api-key <key>", "API key for authentication")
  .option("--json", "Output as JSON");

registerServeCommand(program, context);
registerIndexingCommands(program, context);
registerSearchCommands(program, context);
registerRetrievalCommands(program, context);
registerConfigCommands(program, context);
registerStatusCommands(program, context);
registerSyncCommands(program, context);

export { program as default };
