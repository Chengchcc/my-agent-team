/** The slice of the official client a surface actually uses.
 *
 *  A surface needs to connect, subscribe to one chat and shut down; keeping that in one
 *  interface lets the wiring be tested without a socket, and `AhpClient` satisfies it as it
 *  stands. Upstream's reducers and state mirror stay theirs. */

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
  shutdown(): Promise<void>;
}
