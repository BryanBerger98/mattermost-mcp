import { z } from "zod";
import { defineTool, type AnyToolDef } from "./registry.js";

/** Identity tool — the Phase 4 demo, wired end-to-end through the framework. */
export const getMe = defineTool({
  name: "get_me",
  title: "Get current user",
  description: "Return the authenticated Mattermost user (GET /users/me).",
  inputSchema: z.object({}),
  handler: (_args, { session }) => session.call((c) => c.getMe()),
});

/** Look up a user by id or username (exactly one must be provided). */
export const getUser = defineTool({
  name: "get_user",
  title: "Get user",
  description:
    "Return a Mattermost user by id or username (GET /users/{id} · /users/username/{name}).",
  inputSchema: z
    .object({
      user_id: z.string().optional(),
      username: z.string().optional(),
    })
    .refine((a) => Boolean(a.user_id) !== Boolean(a.username), {
      message: "provide exactly one of user_id or username",
    }),
  handler: (args, { session }) =>
    session.call((c) =>
      args.user_id ? c.getUser(args.user_id) : c.getUserByUsername(args.username!),
    ),
});

/** Search users by a search term. */
export const searchUsers = defineTool({
  name: "search_users",
  title: "Search users",
  description: "Search Mattermost users by term (POST /users/search).",
  inputSchema: z.object({
    term: z.string().min(1),
  }),
  handler: (args, { session }) => session.call((c) => c.searchUsers(args.term, {})),
});

/** Get the presence status of a user. */
export const getUserStatus = defineTool({
  name: "get_user_status",
  title: "Get user status",
  description: "Return the presence status of a user (GET /users/{id}/status).",
  inputSchema: z.object({
    user_id: z.string(),
  }),
  handler: (args, { session }) => session.call((c) => c.getStatus(args.user_id)),
});

/** Set the presence status of the authenticated user. */
export const setStatus = defineTool({
  name: "set_status",
  title: "Set status",
  description: "Set the presence status of the authenticated user (PUT /users/me/status).",
  inputSchema: z.object({
    status: z.enum(["online", "away", "offline", "dnd"]),
  }),
  write: true,
  handler: (args, { session }) =>
    session.call((c) => c.updateStatus({ user_id: session.userId, status: args.status })),
});

/** Set a custom status for the authenticated user. */
export const setCustomStatus = defineTool({
  name: "set_custom_status",
  title: "Set custom status",
  description:
    "Set a custom status (emoji + text) for the authenticated user (PUT /users/me/status/custom).",
  inputSchema: z.object({
    emoji: z.string(),
    text: z.string(),
    duration: z.string().optional(),
  }),
  write: true,
  handler: (args, { session }) =>
    session.call((c) =>
      c.updateCustomStatus({
        emoji: args.emoji,
        text: args.text,
        duration: args.duration ?? "",
      } as Parameters<typeof c.updateCustomStatus>[0]),
    ),
});

export const userTools: AnyToolDef[] = [
  getMe,
  getUser,
  searchUsers,
  getUserStatus,
  setStatus,
  setCustomStatus,
];
