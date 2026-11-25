import {
  type Actor,
  type Axiom,
  AxiomError,
  defaultDatabasePath,
  openDatabase,
  type Provider,
  type Thread,
  type TopicRef,
} from "@axiom/core";

/** Wrong flags or arguments; the CLI exits with 2. */
export class UsageError extends Error {}

export interface CurrentThreadId {
  provider: Provider;
  providerThreadId: string;
}

/** Which thread the CLI is running inside, from the environment. T3 wins (04, Q9). */
export function currentThreadId(env: NodeJS.ProcessEnv): CurrentThreadId | undefined {
  if (env.T3CODE_THREAD_ID) return { provider: "t3", providerThreadId: env.T3CODE_THREAD_ID };
  if (env.CLAUDE_CODE_SESSION_ID) {
    return { provider: "claude-code", providerThreadId: env.CLAUDE_CODE_SESSION_ID };
  }
  return undefined;
}

export function isAgent(env: NodeJS.ProcessEnv): boolean {
  if (env.AXIOM_ACTOR === "owner") return false;
  return env.AXIOM_ACTOR === "agent" || env.CLAUDECODE === "1" || Boolean(env.T3CODE_THREAD_ID);
}

export class Context {
  private db: Axiom | undefined;

  constructor(
    readonly env: NodeJS.ProcessEnv,
    readonly options: { db?: string; json?: boolean },
  ) {}

  get json(): boolean {
    return this.options.json === true;
  }

  get axiom(): Axiom {
    this.db ??= openDatabase(this.options.db ?? defaultDatabasePath(this.env));
    return this.db;
  }

  close(): void {
    this.db?.close();
  }

  /** The attached thread this session runs in, if any. */
  currentThread(): Thread | undefined {
    const id = currentThreadId(this.env);
    return id ? this.axiom.findThread(id) : undefined;
  }

  get actor(): Actor {
    if (!isAgent(this.env)) return { kind: "owner" };
    const thread = this.currentThread();
    return thread ? { kind: "agent", threadId: thread.id } : { kind: "agent" };
  }

  /** The named topic, else the current thread's topic. */
  topic(explicit?: string): TopicRef {
    if (explicit) return explicit;
    const thread = this.currentThread();
    if (thread) return thread.topicId;
    throw new AxiomError(
      "validation",
      "no topic given, and this session is not attached to a topic (use `axiom thread attach <topic>`)",
    );
  }
}
