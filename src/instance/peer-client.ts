import type {
  InstanceMessage,
  InstanceMessageResponse,
  InstanceStatus,
  PeerConfig,
} from "./types";
import type { PeerRegistry } from "./peer-registry";
import { telemetry } from "../services/infrastructure/telemetry";

/**
 * Client for sending messages to peer OpenElinaro instances.
 * Supports local Unix socket transport. SSH transport is planned (TODO).
 */
export class PeerClient {
  constructor(private readonly registry: PeerRegistry) {}

  async sendMessage(message: InstanceMessage): Promise<InstanceMessageResponse> {
    const peer = this.registry.getPeer(message.to);
    if (!peer) {
      return {
        accepted: false,
        conversationKey: message.conversationKey,
        error: `Unknown peer: ${message.to}`,
      };
    }

    if (peer.transport === "ssh") {
      return {
        accepted: false,
        conversationKey: message.conversationKey,
        error: `SSH transport not yet implemented for peer: ${message.to}`,
      };
    }

    return this.sendViaSocket(peer, message);
  }

  async getStatus(profileId: string): Promise<InstanceStatus | { error: string }> {
    const peer = this.registry.getPeer(profileId);
    if (!peer) {
      return { error: `Unknown peer: ${profileId}` };
    }
    if (peer.transport === "ssh") {
      return { error: "SSH transport not yet implemented" };
    }
    return this.getStatusViaSocket(peer);
  }

  private async sendViaSocket(
    peer: PeerConfig,
    message: InstanceMessage,
  ): Promise<InstanceMessageResponse> {
    const socketPath = resolveSocketPath(peer);
    try {
      const response = await fetch("http://localhost/message", {
        unix: socketPath,
        method: "POST",
        body: JSON.stringify(message),
        headers: { "Content-Type": "application/json" },
      } as RequestInit);
      return (await response.json()) as InstanceMessageResponse;
    } catch (error) {
      telemetry.recordError(error, { operation: "peer-client.sendMessage" });
      return {
        accepted: false,
        conversationKey: message.conversationKey,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async getStatusViaSocket(
    peer: PeerConfig,
  ): Promise<InstanceStatus | { error: string }> {
    const socketPath = resolveSocketPath(peer);
    try {
      const response = await fetch("http://localhost/status", {
        unix: socketPath,
      } as RequestInit);
      return (await response.json()) as InstanceStatus;
    } catch (error) {
      telemetry.recordError(error, { operation: "peer-client.getStatus" });
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function resolveSocketPath(peer: PeerConfig): string {
  if (peer.socketPath) {
    return peer.socketPath;
  }
  // Default: the peer's home directory at ~/.openelinaro/instance.sock
  // For local peers running as different OS users, this resolves via /home/<user>
  if (peer.sshUser) {
    return `/home/${peer.sshUser}/.openelinaro/instance.sock`;
  }
  return `${process.env.HOME}/.openelinaro/instance.sock`;
}
