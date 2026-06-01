import { describe, it, expect } from "vitest";
import type { Client4 } from "@mattermost/client";
import type { Config, GuardrailConfig } from "../config.js";
import type { MattermostSession } from "../mattermost/types.js";
import { dispatchToolCall } from "./registry.js";
import { messagingTools } from "./messaging.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  return {
    client: client as Client4,
    config,
    userId: "me1",
    call: (fn) => fn(client as Client4),
  };
}

async function call(
  name: string,
  args: unknown,
  guardrails: Partial<GuardrailConfig> = {},
  client: Partial<Client4> = {},
): Promise<{ text: string; isError: boolean }> {
  const res = await dispatchToolCall(
    messagingTools,
    { session: fakeSession(guardrails, client) },
    name,
    args,
  );
  return { text: (res.content[0] as { text: string }).text, isError: res.isError === true };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("messaging tools", () => {
  // --- post_message ----------------------------------------------------------

  it("post_message: happy path returns the created post", async () => {
    const { text, isError } = await call(
      "post_message",
      { channel_id: "c1", message: "hello" },
      {},
      { createPost: async () => ({ id: "p1", message: "hello" }) as never },
    );
    expect(isError).toBe(false);
    expect(text).toContain("p1");
  });

  it("post_message: blocked by channel allowlist", async () => {
    const { text, isError } = await call(
      "post_message",
      { channel_id: "c9", message: "hello" },
      { channelAllowlist: ["c1"] },
      { createPost: async () => ({ id: "p1" }) as never },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/MM_CHANNEL_ALLOWLIST/);
  });

  it("post_message: blocked when message exceeds maxMessageLen", async () => {
    const { text, isError } = await call(
      "post_message",
      { channel_id: "c1", message: "abcdef" },
      { maxMessageLen: 5 },
      { createPost: async () => ({ id: "p1" }) as never },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/exceeds/);
  });

  // --- get_post --------------------------------------------------------------

  it("get_post: happy path returns the post", async () => {
    const { text, isError } = await call(
      "get_post",
      { post_id: "p42" },
      {},
      { getPost: async () => ({ id: "p42", message: "content" }) as never },
    );
    expect(isError).toBe(false);
    expect(text).toContain("p42");
  });

  // --- add_reaction ----------------------------------------------------------

  it("add_reaction: calls addReaction with session.userId (me1)", async () => {
    let capturedUserId: string | undefined;
    const { text, isError } = await call(
      "add_reaction",
      { post_id: "p1", emoji_name: "thumbsup" },
      {},
      {
        addReaction: async (userId: string, postId: string, emojiName: string) => {
          capturedUserId = userId;
          return { user_id: userId, post_id: postId, emoji_name: emojiName } as never;
        },
      },
    );
    expect(isError).toBe(false);
    expect(capturedUserId).toBe("me1");
    expect(text).toContain("me1");
  });

  // --- edit_post -------------------------------------------------------------

  it("edit_post: calls patchPost (not createPost)", async () => {
    let capturedPatch: unknown;
    const { text, isError } = await call(
      "edit_post",
      { post_id: "p1", message: "updated" },
      {},
      {
        patchPost: async (patch: unknown) => {
          capturedPatch = patch;
          return { id: "p1", message: "updated" } as never;
        },
      },
    );
    expect(isError).toBe(false);
    expect(capturedPatch).toMatchObject({ id: "p1", message: "updated" });
    expect(text).toContain("p1");
  });

  // --- send_dm ---------------------------------------------------------------

  it("send_dm: 1 other user → createDirectChannel with 2 members, then createPost", async () => {
    let capturedMembers: string[] | undefined;
    let capturedChannelId: string | undefined;

    const { text, isError } = await call(
      "send_dm",
      { user_ids: ["other1"], message: "hey" },
      {},
      {
        createDirectChannel: async (userIds: string[]) => {
          capturedMembers = userIds;
          return { id: "dm-channel" } as never;
        },
        createPost: async (post: { channel_id: string; message: string }) => {
          capturedChannelId = post.channel_id;
          return { id: "p1", channel_id: post.channel_id, message: post.message } as never;
        },
      },
    );

    expect(isError).toBe(false);
    expect(capturedMembers).toEqual(["me1", "other1"]);
    expect(capturedChannelId).toBe("dm-channel");
    expect(text).toContain("p1");
  });

  it("send_dm: 2 other users → createGroupChannel with 3 members", async () => {
    let capturedMembers: string[] | undefined;

    await call(
      "send_dm",
      { user_ids: ["u2", "u3"], message: "hey group" },
      {},
      {
        createGroupChannel: async (userIds: string[]) => {
          capturedMembers = userIds;
          return { id: "grp-channel" } as never;
        },
        createPost: async () => ({ id: "p2" }) as never,
      },
    );

    expect(capturedMembers).toEqual(["me1", "u2", "u3"]);
  });

  // --- delete_post -----------------------------------------------------------

  it("delete_post: blocked without confirm AND without flag", async () => {
    const { text, isError } = await call(
      "delete_post",
      { post_id: "p1" },
      {},
      { deletePost: async () => ({}) as never },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/MM_ALLOW_DESTRUCTIVE/);
  });

  it("delete_post: blocked with flag but without confirm:true", async () => {
    const { text, isError } = await call(
      "delete_post",
      { post_id: "p1" },
      { allowDestructive: true },
      { deletePost: async () => ({}) as never },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/confirm:true/);
  });

  it("delete_post: allowed with confirm:true and allowDestructive:true", async () => {
    const { text, isError } = await call(
      "delete_post",
      { post_id: "p1", confirm: true },
      { allowDestructive: true },
      { deletePost: async () => ({ status: "OK" }) as never },
    );
    expect(isError).toBe(false);
    expect(text).toContain("OK");
  });
});
