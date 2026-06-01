import { describe, it, expect } from "vitest";
import type { Client4 } from "@mattermost/client";
import type { Config, GuardrailConfig } from "../config.js";
import type { MattermostSession } from "../mattermost/types.js";
import { dispatchToolCall } from "./registry.js";
import { userTools } from "./users.js";

function fakeSession(
  guardrails: Partial<GuardrailConfig> = {},
  client: Partial<Client4> = {},
): MattermostSession {
  const config: Config = {
    url: "http://mm.test",
    auth: { mode: "pat", token: "t" },
    guardrails: {
      readOnly: false,
      allowDestructive: false,
      teamAllowlist: [],
      channelAllowlist: [],
      maxMessageLen: 16383,
      ...guardrails,
    },
  };
  return { client: client as Client4, config, userId: "me1", call: (fn) => fn(client as Client4) };
}

async function call(
  name: string,
  args: unknown,
  guardrails: Partial<GuardrailConfig> = {},
  client: Partial<Client4> = {},
) {
  const res = await dispatchToolCall(
    userTools,
    { session: fakeSession(guardrails, client) },
    name,
    args,
  );
  return { text: (res.content[0] as { text: string }).text, isError: res.isError === true };
}

describe("get_user", () => {
  it("calls getUser when user_id is provided", async () => {
    const stub: Partial<Client4> = {
      getUser: async (id) => ({ id, username: "alice" }) as never,
    };
    const { text, isError } = await call("get_user", { user_id: "u42" }, {}, stub);
    expect(isError).toBe(false);
    expect(text).toContain("u42");
  });

  it("calls getUserByUsername when username is provided", async () => {
    const stub: Partial<Client4> = {
      getUserByUsername: async (username) => ({ id: "u99", username }) as never,
    };
    const { text, isError } = await call("get_user", { username: "bob" }, {}, stub);
    expect(isError).toBe(false);
    expect(text).toContain("bob");
  });

  it("returns an error when neither user_id nor username is provided", async () => {
    const { text, isError } = await call("get_user", {});
    expect(isError).toBe(true);
    expect(text).toMatch(/invalid arguments|exactly one/);
  });

  it("returns an error when both user_id and username are provided", async () => {
    const { text, isError } = await call("get_user", { user_id: "u1", username: "alice" });
    expect(isError).toBe(true);
    expect(text).toMatch(/invalid arguments|exactly one/);
  });
});

describe("search_users", () => {
  it("calls searchUsers and returns results", async () => {
    const stub: Partial<Client4> = {
      searchUsers: async (_term, _opts) =>
        [
          { id: "u1", username: "alice" },
          { id: "u2", username: "alicia" },
        ] as never,
    };
    const { text, isError } = await call("search_users", { term: "alic" }, {}, stub);
    expect(isError).toBe(false);
    expect(text).toContain("alice");
    expect(text).toContain("alicia");
  });
});

describe("set_status", () => {
  it("rejects an invalid status value", async () => {
    const { text, isError } = await call("set_status", { status: "busy" });
    expect(isError).toBe(true);
    expect(text).toMatch(/invalid arguments/);
  });

  it("calls updateStatus with the authenticated user id", async () => {
    let captured: unknown;
    const stub: Partial<Client4> = {
      updateStatus: async (s) => {
        captured = s;
        return s as never;
      },
    };
    const { isError } = await call("set_status", { status: "dnd" }, {}, stub);
    expect(isError).toBe(false);
    expect(captured).toMatchObject({ user_id: "me1", status: "dnd" });
  });

  it("is blocked under MM_READ_ONLY", async () => {
    const { text, isError } = await call("set_status", { status: "online" }, { readOnly: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/read-only/);
  });
});

describe("set_custom_status", () => {
  it("calls updateCustomStatus with emoji, text, and default duration", async () => {
    let captured: unknown;
    const stub: Partial<Client4> = {
      updateCustomStatus: async (cs) => {
        captured = cs;
        return {} as never;
      },
    };
    const { isError } = await call(
      "set_custom_status",
      { emoji: "coffee", text: "Working from home" },
      {},
      stub,
    );
    expect(isError).toBe(false);
    expect(captured).toMatchObject({ emoji: "coffee", text: "Working from home", duration: "" });
  });

  it("passes an explicit duration when provided", async () => {
    let captured: unknown;
    const stub: Partial<Client4> = {
      updateCustomStatus: async (cs) => {
        captured = cs;
        return {} as never;
      },
    };
    await call(
      "set_custom_status",
      { emoji: "zzz", text: "In a meeting", duration: "today" },
      {},
      stub,
    );
    expect(captured).toMatchObject({ duration: "today" });
  });
});
