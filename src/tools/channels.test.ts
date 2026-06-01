import { describe, it, expect } from "vitest";
import type { Client4 } from "@mattermost/client";
import type { Config, GuardrailConfig } from "../config.js";
import type { MattermostSession } from "../mattermost/types.js";
import { dispatchToolCall } from "./registry.js";
import { channelTools } from "./channels.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

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
): Promise<{ text: string; isError: boolean }> {
  const res = await dispatchToolCall(
    channelTools,
    { session: fakeSession(guardrails, client) },
    name,
    args,
  );
  return { text: (res.content[0] as { text: string }).text, isError: res.isError === true };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("list_teams", () => {
  it("returns the teams returned by getMyTeams", async () => {
    const teams = [
      { id: "tm1", name: "alpha" },
      { id: "tm2", name: "beta" },
    ];
    const { text, isError } = await call(
      "list_teams",
      {},
      {},
      { getMyTeams: async () => teams as never },
    );
    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("tm1");
  });
});

describe("list_channels", () => {
  it("blocks a team not in the team allowlist", async () => {
    const { text, isError } = await call(
      "list_channels",
      { team_id: "t9" },
      { teamAllowlist: ["t1"] },
      { getMyChannels: async () => [] as never },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/MM_TEAM_ALLOWLIST/);
  });

  it("allows a team that is in the allowlist", async () => {
    const channels = [{ id: "ch1", name: "general" }];
    const { text, isError } = await call(
      "list_channels",
      { team_id: "t1" },
      { teamAllowlist: ["t1"] },
      { getMyChannels: async () => channels as never },
    );
    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed[0].id).toBe("ch1");
  });
});

describe("get_channel", () => {
  it("returns a channel by id", async () => {
    const channel = { id: "ch42", name: "ops" };
    const { text, isError } = await call(
      "get_channel",
      { channel_id: "ch42" },
      {},
      { getChannel: async () => channel as never },
    );
    expect(isError).toBe(false);
    expect(JSON.parse(text).id).toBe("ch42");
  });
});

describe("create_channel", () => {
  it("rejects an invalid channel type with isError and /invalid arguments/", async () => {
    const { text, isError } = await call("create_channel", {
      name: "my-chan",
      display_name: "My Chan",
      type: "X",
      team_id: "tm1",
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/invalid arguments/);
  });
});

describe("join_channel", () => {
  it("calls addToChannel with (session.userId, channel_id)", async () => {
    let capturedUserId: string | undefined;
    let capturedChannelId: string | undefined;
    const membership = { channel_id: "ch7", user_id: "me1" };
    const { isError } = await call(
      "join_channel",
      { channel_id: "ch7" },
      {},
      {
        addToChannel: async (userId, channelId) => {
          capturedUserId = userId;
          capturedChannelId = channelId;
          return membership as never;
        },
      },
    );
    expect(isError).toBe(false);
    expect(capturedUserId).toBe("me1");
    expect(capturedChannelId).toBe("ch7");
  });
});

describe("archive_channel", () => {
  it("is blocked without MM_ALLOW_DESTRUCTIVE", async () => {
    const { text, isError } = await call(
      "archive_channel",
      { channel_id: "ch1", confirm: true },
      { allowDestructive: false },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/MM_ALLOW_DESTRUCTIVE/);
  });

  it("is blocked when flag is set but confirm is absent", async () => {
    const { text, isError } = await call(
      "archive_channel",
      { channel_id: "ch1" },
      { allowDestructive: true },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/confirm:true/);
  });

  it("succeeds when both MM_ALLOW_DESTRUCTIVE and confirm:true are set", async () => {
    const { text, isError } = await call(
      "archive_channel",
      { channel_id: "ch1", confirm: true },
      { allowDestructive: true },
      { deleteChannel: async () => ({ status: "OK" }) as never },
    );
    expect(isError).toBe(false);
    expect(text).toContain("OK");
  });
});

describe("remove_member", () => {
  it("is blocked under read-only mode", async () => {
    const { text, isError } = await call(
      "remove_member",
      { channel_id: "ch1", user_id: "u2", confirm: true },
      { readOnly: true },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/read-only/);
  });
});

describe("get_unreads", () => {
  it("maps memberships to { channel_id, msg_count, mention_count }", async () => {
    const rawMemberships = [
      { channel_id: "ch1", msg_count: 5, mention_count: 2, roles: "channel_user" },
      { channel_id: "ch2", msg_count: 0, mention_count: 0, roles: "channel_user" },
    ];
    const { text, isError } = await call(
      "get_unreads",
      { team_id: "tm1" },
      {},
      { getMyChannelMembers: async () => rawMemberships as never },
    );
    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ channel_id: "ch1", msg_count: 5, mention_count: 2 });
    expect(parsed[1]).toEqual({ channel_id: "ch2", msg_count: 0, mention_count: 0 });
    // Ensure no extra fields leak through
    expect(Object.keys(parsed[0])).toEqual(["channel_id", "msg_count", "mention_count"]);
  });
});
