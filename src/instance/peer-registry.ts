import { getRuntimeConfig } from "../config/runtime-config";
import type { PeerConfig } from "./types";

/**
 * Registry of known peer instances. Reads from runtime config.
 */
export class PeerRegistry {
  getPeers(): PeerConfig[] {
    return getRuntimeConfig().core.app.instance.peers;
  }

  getPeer(profileId: string): PeerConfig | undefined {
    return this.getPeers().find((p) => p.profileId === profileId);
  }

  listPeerIds(): string[] {
    return this.getPeers().map((p) => p.profileId);
  }
}
