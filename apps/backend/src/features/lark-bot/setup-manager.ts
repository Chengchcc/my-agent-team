/**
 * Lark profile setup sessions, PERSISTED (see setup-store.ts).
 *
 * Two things the in-memory version could not do: survive a backend restart,
 * and report that a link expired - it deleted expired sessions, so the read
 * model's `setup_expired` branch was unreachable. Expired and cancelled rows
 * are now tombstones the wizard can explain.
 */

import type { LarkProfileProvisioner } from "./provisioner.js";
import type { LarkSetupStore } from "./setup-store.js";

export interface LarkProfileSetupSession {
  setupId: string;
  agentId: string;
  profileRef: string;
  botDisplayName: string | null;
  brand: "feishu" | "lark";
  status: "pending" | "completed" | "failed" | "expired" | "cancelled";
  url: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const EXPIRE_CHECK_INTERVAL_MS = 60_000; // 1 minute
/** Settled sessions stay readable for a day, then stop taking space. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

export class LarkSetupManager {
  #store: LarkSetupStore;
  #provisioner: LarkProfileProvisioner;
  #expiryTimer: ReturnType<typeof setInterval>;
  #cancelFns = new Map<string, () => Promise<void>>();
  /** Callback when a setup session completes successfully. */
  #onComplete: (session: LarkProfileSetupSession) => Promise<void>;

  constructor(
    provisioner: LarkProfileProvisioner,
    onComplete: (session: LarkProfileSetupSession) => Promise<void>,
    store: LarkSetupStore,
  ) {
    this.#provisioner = provisioner;
    this.#onComplete = onComplete;
    this.#store = store;
    // Rows left pending by a previous process are unreachable: their lark-cli
    // child died with the process, so they are expired, not "still working".
    this.#store.expireAllPending();
    this.#expiryTimer = setInterval(() => this.#reapExpired(), EXPIRE_CHECK_INTERVAL_MS);
  }

  get provisioner(): LarkProfileProvisioner {
    return this.#provisioner;
  }

  /** Create a new setup session and start the provisioner. */
  async create(input: {
    agentId: string;
    botDisplayName?: string;
    brand: "feishu" | "lark";
  }): Promise<LarkProfileSetupSession> {
    const { agentId, botDisplayName, brand } = input;
    const profileRef = `agent:${agentId}`;
    const setupId = `setup_${crypto.randomUUID()}`;
    const now = Date.now();

    const session: LarkProfileSetupSession = {
      setupId,
      agentId,
      profileRef,
      botDisplayName: botDisplayName ?? null,
      brand,
      status: "pending",
      url: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + DEFAULT_TIMEOUT_MS,
    };

    // Start provisioner in background
    void this.#provisioner
      .start({
        agentId,
        profileRef,
        brand,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        onUrl: (url) => {
          // Surface the setup URL to the 3s polling UI as soon as lark-cli
          // prints it (stdout TTY or stderr piped) — do not wait for exit.
          session.url = url;
          session.updatedAt = Date.now();
          this.#store.update(setupId, { url, updatedAt: session.updatedAt });
        },
      })
      .then((result) => {
        // Store cancel function so cancel() can SIGTERM the lark-cli process
        this.#cancelFns.set(setupId, result.cancel);
        session.updatedAt = Date.now();
        this.#store.update(setupId, { updatedAt: session.updatedAt });

        void result.waitForCompletion
          .then((url) => {
            session.url = url; // resolved after all stdout data has arrived
            this.#store.update(setupId, { url, updatedAt: Date.now() });
            this.#cancelFns.delete(setupId);
            void this.complete(setupId);
          })
          .catch((err: Error) => {
            this.#cancelFns.delete(setupId);
            // Don't mark as failed if user cancelled
            if (this.#store.get(setupId)?.status !== "cancelled") {
              this.fail(setupId, err.message);
            }
          });
      })
      .catch((err: Error) => {
        this.fail(setupId, err.message);
      });

    this.#store.insert(session);
    return { ...session };
  }

  get(setupId: string): LarkProfileSetupSession | null {
    return this.#store.get(setupId);
  }

  /** The most recent session for an agent. "Most recent" now means newest by
   *  creation, not whichever the Map happened to yield first. */
  getByAgentId(agentId: string): LarkProfileSetupSession | null {
    return this.#store.latestForAgent(agentId);
  }

  async complete(setupId: string): Promise<void> {
    const session = this.#store.get(setupId);
    if (!session) return;
    session.status = "completed";
    session.updatedAt = Date.now();
    this.#store.update(setupId, { status: "completed", updatedAt: session.updatedAt });
    try {
      await this.#onComplete(session);
    } catch (err) {
      console.error(
        `[setup-manager] onComplete failed for ${setupId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  fail(setupId: string, error: string): void {
    if (!this.#store.get(setupId)) return;
    this.#store.update(setupId, { status: "failed", error, updatedAt: Date.now() });
  }

  cancel(setupId: string): void {
    if (!this.#store.get(setupId)) return;
    // A tombstone, not a delete: the wizard has to be able to say "cancelled".
    this.#store.update(setupId, { status: "cancelled", updatedAt: Date.now() });
    // SIGTERM the provisioner's lark-cli process (never SIGKILL)
    const cancelFn = this.#cancelFns.get(setupId);
    if (cancelFn) {
      this.#cancelFns.delete(setupId);
      void cancelFn();
    }
  }

  /** Expire what passed its deadline and drop what is long settled. */
  #reapExpired(): void {
    const now = Date.now();
    this.#store.expireStale(now);
    this.#store.purgeBefore(now - RETENTION_MS);
  }

  dispose(): void {
    clearInterval(this.#expiryTimer);
    for (const [, cancelFn] of this.#cancelFns) {
      void cancelFn();
    }
    this.#cancelFns.clear();
  }
}
