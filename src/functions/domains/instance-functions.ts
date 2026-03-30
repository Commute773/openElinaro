/**
 * Inter-instance messaging function definitions.
 *
 * Tools for sending messages to peer OpenElinaro instances and
 * querying their status.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import { formatResult } from "../formatters";

const INSTANCE_AUTH = { access: "root" as const, behavior: "uniform" as const };
const INSTANCE_DOMAINS = ["instance", "messaging"];

export const buildInstanceFunctions: FunctionDomainBuilder = (ctx) => [
  defineFunction({
    name: "send_message",
    description:
      "Send a message to another OpenElinaro instance. The message is delivered as a user message in the specified conversation on the target instance.",
    input: z.object({
      to: z.string().min(1).describe("Profile ID of the target instance (e.g. 'noumenal', 'liminal')"),
      conversationKey: z.string().min(1).describe("Conversation key on the target instance"),
      content: z.string().min(1).describe("Message text to deliver"),
      replyTo: z.string().optional().describe("Optional reference to a prior message"),
    }),
    surfaces: ["agent"],
    handler: async (input, fnCtx) => {
      const peerClient = fnCtx.services.peerClient;
      if (!peerClient) {
        return { accepted: false, conversationKey: input.conversationKey, error: "Instance messaging not configured" };
      }
      const result = await peerClient.sendMessage({
        from: fnCtx.services.access.getProfile().id,
        to: input.to,
        conversationKey: input.conversationKey,
        content: input.content,
        replyTo: input.replyTo,
      });
      return result;
    },
    format: (result) => {
      if (result.accepted) {
        return `Message delivered to conversation ${result.conversationKey}.`;
      }
      return `Message delivery failed: ${result.error ?? "unknown error"}`;
    },
    auth: INSTANCE_AUTH,
    domains: INSTANCE_DOMAINS,
    agentScopes: ["chat"],
    mutatesState: true,
  }),

  defineFunction({
    name: "instance_status",
    description: "Check the status of a peer OpenElinaro instance (up/down, uptime, active conversations).",
    input: z.object({
      profileId: z.string().min(1).describe("Profile ID of the instance to check"),
    }),
    surfaces: ["agent", "api"],
    handler: async (input, fnCtx) => {
      const peerClient = fnCtx.services.peerClient;
      if (!peerClient) {
        return { error: "Instance messaging not configured" };
      }
      return peerClient.getStatus(input.profileId);
    },
    format: (result) => {
      if ("error" in result) {
        return `Error: ${result.error}`;
      }
      const status = result as { profileId: string; uptime: number; activeConversations: string[] };
      const uptimeMin = Math.floor(status.uptime / 60_000);
      return [
        `Instance: ${status.profileId}`,
        `Uptime: ${uptimeMin}m`,
        `Active conversations: ${status.activeConversations.length}`,
      ].join("\n");
    },
    auth: INSTANCE_AUTH,
    domains: INSTANCE_DOMAINS,
    agentScopes: ["chat"],
    http: { method: "GET", path: "/instance/:profileId/status" },
  }),

  defineFunction({
    name: "instance_list",
    description: "List all configured peer instances and their transport type.",
    input: z.object({}),
    surfaces: ["agent", "api"],
    handler: async (_input, fnCtx) => {
      const peerClient = fnCtx.services.peerClient;
      if (!peerClient) {
        return { peers: [], error: "Instance messaging not configured" };
      }
      const peers = fnCtx.services.peerRegistry?.getPeers() ?? [];
      return {
        peers: peers.map((p) => ({
          profileId: p.profileId,
          transport: p.transport,
          socketPath: p.socketPath,
          sshHost: p.sshHost,
        })),
      };
    },
    format: (result) => {
      if (result.peers.length === 0) {
        return result.error ?? "No peers configured.";
      }
      return result.peers
        .map((p: { profileId: string; transport: string }) => `${p.profileId} (${p.transport})`)
        .join("\n");
    },
    auth: INSTANCE_AUTH,
    domains: INSTANCE_DOMAINS,
    agentScopes: ["chat"],
    http: { method: "GET", path: "/instances" },
  }),
];
