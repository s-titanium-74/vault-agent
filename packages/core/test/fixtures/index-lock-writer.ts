import { acquireIndexLock } from "../../src/local/index-lock.js";
import { IndexError } from "../../src/errors.js";

process.once("message", () => {
  try {
    const release = acquireIndexLock(process.argv[2]!);
    process.once("message", () => {
      release();
      process.disconnect();
    });
    process.send?.("acquired");
  } catch (error) {
    if (!(error instanceof IndexError)) throw error;
    process.send?.(error.code);
    process.disconnect();
  }
});
process.send?.("ready");
