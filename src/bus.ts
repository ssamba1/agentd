import { EventEmitter } from "node:events";

/**
 * Everything the PWA reacts to flows through here: WebSocket fan-out for a
 * foregrounded client, Web Push for a backgrounded one.
 *
 * The bus is a notification channel, never a source of truth. iOS suspends
 * WebSockets the moment the app backgrounds, so a client that missed events
 * must be able to rebuild its whole view from the REST API. Every payload is
 * therefore a hint ("something changed, here is roughly what") rather than a
 * delta the client is expected to apply blindly.
 */
export interface BusEvent {
  kind: string;
  sessionId: string | null;
  /** events.id when this event was journalled, for cursor-based catch-up. */
  seq?: number | undefined;
  data?: Record<string, unknown> | undefined;
  ts: number;
}

export type BusListener = (event: BusEvent) => void;

export class Bus {
  readonly #emitter = new EventEmitter();

  constructor() {
    // Fan-out counts scale with connected devices, not with load.
    this.#emitter.setMaxListeners(64);
  }

  emit(
    kind: string,
    sessionId: string | null,
    data?: Record<string, unknown>,
    seq?: number,
  ): BusEvent {
    const event: BusEvent = { kind, sessionId, seq, data, ts: Date.now() };
    // A throwing subscriber must never take down the code path that emitted.
    try {
      this.#emitter.emit("event", event);
    } catch {
      /* ignored by design */
    }
    return event;
  }

  subscribe(listener: BusListener): () => void {
    const wrapped: BusListener = (event) => {
      try {
        listener(event);
      } catch (err) {
        console.error("[bus] subscriber threw:", err);
      }
    };
    this.#emitter.on("event", wrapped);
    return () => this.#emitter.off("event", wrapped);
  }
}
