#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createSession } from "./mattermost/client.js";
import { registerTools } from "./tools/registry.js";
import { allTools } from "./tools/index.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  // Fail fast on bad config, then authenticate before serving.
  const config = loadConfig();
  const session = await createSession(config);

  const server = new Server(
    { name: "mattermost-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // tools/list + tools/call dispatched from the registry, sharing the session.
  registerTools(server, allTools, { session });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("server running on stdio");
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
