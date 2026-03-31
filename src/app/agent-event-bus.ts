import type { AgentStreamEvent } from "../domain/assistant";
import { attempt } from "../utils/result";

export type BusEvent =
  | { kind: "agent_stream"; event: AgentStreamEvent }
  | { kind: "user_input"; text: string; source: string };

export type BusListener = (event: BusEvent) => void;

export class AgentEventBus {
  private listeners = new Set<BusListener>();

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(event: BusEvent): void {
    for (const listener of this.listeners) {
      attempt(() => listener(event));
    }
  }
}
