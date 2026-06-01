import { describe, it, expect, vi, afterEach } from "vitest";
import type { Client4 } from "@mattermost/client";
import type { Config, GuardrailConfig } from "../config.js";
import type { MattermostSession } from "../mattermost/types.js";
import { dispatchToolCall } from "./registry.js";
import { fileTools } from "./files.js";

// --- fixtures ----------------------------------------------------------------

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
    fileTools,
    { session: fakeSession(guardrails, client) },
    name,
    args,
  );
  return { text: (res.content[0] as { text: string }).text, isError: res.isError === true };
}

/** Minimal Client4 stub for raw-fetch tools. */
function rawFetchClient(): Partial<Client4> {
  return {
    getFileRoute: (id: string) => `http://mm.test/api/v4/files/${id}`,
    getToken: () => "tok",
  };
}

afterEach(() => vi.unstubAllGlobals());

// --- tests -------------------------------------------------------------------

describe("upload_file", () => {
  it("happy path — returns mapped file info", async () => {
    const uploadFile = vi.fn(async () => ({
      file_infos: [{ id: "f42", name: "hi.txt", size: 2, mime_type: "text/plain" }],
      client_ids: [],
    }));
    const { text, isError } = await call(
      "upload_file",
      {
        channel_id: "c1",
        filename: "hi.txt",
        content_base64: Buffer.from("hi").toString("base64"),
      },
      {},
      { uploadFile } as unknown as Partial<Client4>,
    );
    expect(isError).toBe(false);
    expect(text).toContain("f42");
    expect(uploadFile).toHaveBeenCalledOnce();
  });

  it("blocked under MM_READ_ONLY", async () => {
    const { text, isError } = await call(
      "upload_file",
      { channel_id: "c1", filename: "hi.txt", content_base64: "aGk=" },
      { readOnly: true },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/read-only/);
  });

  it("blocked by channel allowlist", async () => {
    const { text, isError } = await call(
      "upload_file",
      { channel_id: "c9", filename: "hi.txt", content_base64: "aGk=" },
      { channelAllowlist: ["c1"] },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/MM_CHANNEL_ALLOWLIST/);
  });
});

describe("get_file_metadata", () => {
  it("returns the JSON metadata from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: "f1", name: "a.txt" }),
        text: async () => "",
      })),
    );
    const { text, isError } = await call(
      "get_file_metadata",
      { file_id: "f1" },
      {},
      rawFetchClient(),
    );
    expect(isError).toBe(false);
    expect(text).toContain("f1");
  });

  it("surfaces a non-ok response as Mattermost API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        text: async () => "Not found",
      })),
    );
    const { text, isError } = await call(
      "get_file_metadata",
      { file_id: "missing" },
      {},
      rawFetchClient(),
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/Mattermost API error 404/);
  });
});

describe("get_file", () => {
  it("returns base64 content of the downloaded file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
        text: async () => "",
      })),
    );
    const { text, isError } = await call("get_file", { file_id: "f1" }, {}, rawFetchClient());
    expect(isError).toBe(false);
    // "hello" in base64
    expect(text).toContain(Buffer.from("hello").toString("base64")); // "aGVsbG8="
  });

  it("rejects when file exceeds max_bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        // 5 bytes: "hello"
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
        text: async () => "",
      })),
    );
    const { text, isError } = await call(
      "get_file",
      { file_id: "f1", max_bytes: 1 },
      {},
      rawFetchClient(),
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/exceeds max_bytes/);
  });

  it("surfaces a non-ok response as Mattermost API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        text: async () => "Not found",
      })),
    );
    const { text, isError } = await call("get_file", { file_id: "gone" }, {}, rawFetchClient());
    expect(isError).toBe(true);
    expect(text).toMatch(/Mattermost API error 404/);
  });
});
