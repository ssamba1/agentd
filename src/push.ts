import { randomUUID } from "node:crypto";
import webpush from "web-push";
import type { Bus } from "./bus.js";
import { type Db, getConfigValue, setConfigValue } from "./db.js";

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string | undefined;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failures: number;
}

/**
 * Web Push is the only wake path that works on iOS.
 *
 * A home-screen PWA's WebSocket dies the moment the app backgrounds, so the
 * socket cannot be what tells you an approval is waiting -- that is precisely
 * the case where you are away from the device. Push wakes the app; the app
 * then reconnects and refetches pending approvals from SQLite, which stays the
 * source of truth.
 *
 * iOS constraints this is built around:
 *  - No silent push. Every message must render a visible notification, so only
 *    genuinely notify-worthy events are sent (approvals, failures), never
 *    routine stream traffic.
 *  - Subscriptions expire without warning. A 404 or 410 means gone for good,
 *    so the row is deleted rather than retried.
 *  - Requires an installed home-screen PWA served over HTTPS with a real
 *    certificate, which Tailscale Serve provides.
 */
export class PushService {
  readonly #db: Db;
  #enabled = false;
  #publicKey = "";

  constructor(db: Db, bus: Bus, contact: string) {
    this.#db = db;

    let publicKey = getConfigValue(db, "vapid_public");
    let privateKey = getConfigValue(db, "vapid_private");
    if (!publicKey || !privateKey) {
      const generated = webpush.generateVAPIDKeys();
      publicKey = generated.publicKey;
      privateKey = generated.privateKey;
      setConfigValue(db, "vapid_public", publicKey);
      setConfigValue(db, "vapid_private", privateKey);
      console.log("[push] generated a new VAPID keypair");
    }

    try {
      webpush.setVapidDetails(contact, publicKey, privateKey);
      this.#publicKey = publicKey;
      this.#enabled = true;
    } catch (err) {
      // A malformed contact URL should degrade to "no push", not stop agentd.
      console.error("[push] disabled:", err instanceof Error ? err.message : err);
    }

    bus.subscribe((event) => {
      if (!this.#enabled) return;
      if (event.kind === "approval.pending") {
        void this.#broadcast({
          title: "Approval needed",
          body: String(event.data?.["summary"] ?? "A tool call is waiting for you."),
          tag: `approval-${event.data?.["approvalId"] ?? "unknown"}`,
          url: `/#/approvals`,
        });
      } else if (event.kind === "session.failed") {
        void this.#broadcast({
          title: "Session failed",
          body: String(event.data?.["error"] ?? "").slice(0, 160) || "A session ended in error.",
          tag: `session-${event.sessionId}`,
          url: `/#/sessions/${event.sessionId}`,
        });
      }
    });
  }

  get publicKey(): string {
    return this.#publicKey;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  subscribe(input: PushSubscriptionInput): string {
    const existing = this.#db
      .prepare(`SELECT id FROM push_subscriptions WHERE endpoint = ?`)
      .get(input.endpoint) as { id: string } | undefined;
    if (existing) {
      // Re-subscribing is routine: iOS hands out a fresh subscription on many
      // app opens. Refresh the keys and clear the failure count.
      this.#db
        .prepare(
          `UPDATE push_subscriptions SET p256dh = ?, auth = ?, label = COALESCE(?, label),
                  failures = 0, last_ok_at = ? WHERE id = ?`,
        )
        .run(input.keys.p256dh, input.keys.auth, input.label ?? null, Date.now(), existing.id);
      return existing.id;
    }
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, created_at, failures)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(id, input.endpoint, input.keys.p256dh, input.keys.auth, input.label ?? null, Date.now());
    return id;
  }

  unsubscribe(endpoint: string): boolean {
    return (
      this.#db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint).changes > 0
    );
  }

  list(): Array<{ id: string; label: string | null; created_at: number; failures: number }> {
    return this.#db
      .prepare(`SELECT id, label, created_at, failures FROM push_subscriptions ORDER BY created_at`)
      .all() as Array<{ id: string; label: string | null; created_at: number; failures: number }>;
  }

  async #broadcast(payload: {
    title: string;
    body: string;
    tag: string;
    url: string;
  }): Promise<{ sent: number; pruned: number }> {
    const subs = this.#db
      .prepare(`SELECT id, endpoint, p256dh, auth, failures FROM push_subscriptions`)
      .all() as SubscriptionRow[];
    const body = JSON.stringify(payload);
    let sent = 0;
    let pruned = 0;

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
            { TTL: 3600, urgency: "high" },
          );
          this.#db
            .prepare(`UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id = ?`)
            .run(Date.now(), sub.id);
          sent++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // Gone for good. Retrying a dead endpoint forever is how push
            // queues rot.
            this.#db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(sub.id);
            pruned++;
          } else {
            this.#db
              .prepare(`UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?`)
              .run(sub.id);
            console.error(`[push] send failed (${status ?? "no status"}) for ${sub.id}`);
          }
        }
      }),
    );
    return { sent, pruned };
  }

  /** Exposed so the PWA can prove notifications work before relying on them. */
  async test(): Promise<{ sent: number; pruned: number }> {
    return this.#broadcast({
      title: "agentd",
      body: "Notifications are working.",
      tag: "agentd-test",
      url: "/",
    });
  }
}
