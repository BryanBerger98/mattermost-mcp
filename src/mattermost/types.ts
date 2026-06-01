import type { Client4 } from "@mattermost/client";
import type { Config } from "../config.js";

/**
 * An authenticated Mattermost context shared by every tool handler.
 * `call` wraps a Client4 invocation with auth-failure recovery
 * (password mode re-logins once on a 401).
 */
export interface MattermostSession {
  readonly client: Client4;
  readonly config: Config;
  readonly userId: string;
  call<T>(fn: (client: Client4) => Promise<T>): Promise<T>;
}
