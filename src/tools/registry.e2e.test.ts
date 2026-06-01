// Real MCP round-trip over an in-process transport: a Client talks to a Server
// wired by registerTools — no stdio spawn, no network.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Client4 } from "@mattermost/client";
import type { Config } from "../config.js";
import type { MattermostSession } from "../mattermost/types.js";
import { defineTool, registerTools, type AnyToolDef } from "./registry.js";
import { getMe } from "./users.js";

function session(readOnly = false): MattermostSession {
  const config: Config = {
    url: "http://mm.test",
    auth: { mode: "pat", token: "t" },
    guardrails: {
      readOnly,
      allowDestructive: false,
      teamAllowlist: [],
      channelAllowlist: [],
      maxMessageLen: 16383,
    },
  };
  const client = {
    getMe: async () => ({ id: "u1", username: "alice" }) as never,
  } as Partial<Client4>;
  return { client: client as Client4, config, userId: "u1", call: (fn) => fn(client as Client4) };
}

const writeStub = defineTool({
  name: "post_stub",
  title: "Post stub",
  description: "guarded write stub",
  inputSchema: z.object({}),
  write: true,
  handler: async () => "wrote",
});

async function connect(tools: AnyToolDef[], readOnly = false): Promise<Client> {
  const server = new Server({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerTools(server, tools, { session: session(readOnly) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP server (in-process transport)", () => {
  it("tools/list advertises get_me", async () => {
    const client = await connect([getMe, writeStub]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("get_me");
    await client.close();
  });

  it("tools/call get_me returns the current user", async () => {
    const client = await connect([getMe]);
    const res = await client.callTool({ name: "get_me", arguments: {} });
    expect((res.content as { text: string }[])[0]!.text).toContain("alice");
    expect(res.isError).toBeFalsy();
    await client.close();
  });

  it("a guarded write tool is blocked under MM_READ_ONLY", async () => {
    const client = await connect([writeStub], true);
    const res = await client.callTool({ name: "post_stub", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toMatch(/read-only/);
    await client.close();
  });
});
