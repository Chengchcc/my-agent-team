/** The slice of the official client a surface actually uses.
 *
 *  A surface needs to connect, subscribe to one chat, re-read a snapshot and shut down; keeping
 *  that in one interface lets the wiring be tested without a socket, and `AhpClient` satisfies it
 *  as it stands. Upstream's reducers and state mirror stay theirs. */
export interface AhpSubscribeReply {
  /** The channel's state at read time, in the protocol's `subscribe` response shape. */
  readonly result?: { readonly snapshot?: { readonly state?: unknown } };
  /** The carrier subscription: it exists only to deliver this response, so the caller closes it.
   *  Upstream has no `unsubscribe` command, so closing never disturbs other subscriptions. */
  readonly subscription: { close(): Promise<void> | void };
}

import type { URI } from "@microsoft/agent-host-protocol";
import type { SubscriptionEvent } from "@microsoft/agent-host-protocol/client";

export interface AhpClientLike {
  connect(): void;
  initialize(args: {
    readonly clientId: string;
    readonly protocolVersions: readonly string[];
    readonly initialSubscriptions?: readonly URI[];
  }): Promise<{
    readonly snapshots: ReadonlyArray<{ readonly resource: URI; readonly state: unknown }>;
  }>;
  attachSubscription(uri: URI): AsyncIterableIterator<SubscriptionEvent>;
  /** Re-read one channel's snapshot. A host drops a channel's cached projection when a DB-only
   *  fact changes (no action can carry those facts), so this is how a surface picks the fresh
   *  state up instead of painting its first snapshot forever (#52). */
  subscribe(uri: URI): Promise<AhpSubscribeReply>;
  shutdown(): Promise<void>;
}
