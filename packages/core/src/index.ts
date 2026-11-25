import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const AXIOM_VERSION: string = pkg.version;

export type {
  AttachThreadInput,
  Clock,
  CreateTaskInput,
  CreateTopicInput,
  CreateWorkItemInput,
  EntryInput,
  ListNotificationsOptions,
  ListTopicsFilter,
  UpdateTaskInput,
} from "./axiom.js";
export { describeToolUse, oneLine } from "./activity.js";
export { Axiom } from "./axiom.js";
export * from "./constants.js";
export type { OpenOptions } from "./database.js";
export { defaultDatabasePath, migrate, openDatabase } from "./database.js";
export type { AxiomErrorCode } from "./errors.js";
export { AxiomError } from "./errors.js";
export * as rules from "./rules.js";
export * from "./rules.js";
export * from "./schemas.js";
export type * from "./types.js";
