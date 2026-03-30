/**
 * Inter-instance messaging protocol types.
 *
 * OpenElinaro instances communicate peer-to-peer over Unix sockets (local)
 * or SSH tunnels (remote). One instance can deliver messages to another
 * as if it were the user.
 */

// ---------------------------------------------------------------------------
// Message protocol
// ---------------------------------------------------------------------------

/** A message sent from one instance to another. */
export interface InstanceMessage {
  /** Sender profile id. */
  from: string;
  /** Recipient profile id. */
  to: string;
  /** Conversation key on the recipient instance. */
  conversationKey: string;
  /** Message text, delivered as a user message on the recipient. */
  content: string;
  /** Optional reference to a prior message for threading. */
  replyTo?: string;
}

/** Response returned after delivering a message. */
export interface InstanceMessageResponse {
  accepted: boolean;
  conversationKey: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Status of a running instance. */
export interface InstanceStatus {
  profileId: string;
  uptime: number;
  activeConversations: string[];
}

// ---------------------------------------------------------------------------
// Peer configuration
// ---------------------------------------------------------------------------

export type PeerTransport = "local" | "ssh";

/** Configuration for a known peer instance. */
export interface PeerConfig {
  profileId: string;
  transport: PeerTransport;
  /** Unix socket path (local transport). Defaults to ~/.openelinaro/instance.sock under the peer's home. */
  socketPath?: string;
  /** SSH host (ssh transport). */
  sshHost?: string;
  /** SSH user (ssh transport). */
  sshUser?: string;
}
