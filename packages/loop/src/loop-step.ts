import type { LoopState, LoopAction } from "./types.js";
import { loopReducer } from "./loop-reducer.js";
import { parseStateMd, formatStateMd, parseInboxMd, formatInboxMd } from "./state-md.js";

type ReviewAction = {
  itemId: string;
  verdict: "approve" | "reject" | "promote" | "retry" | "dismiss";
  feedback?: string;
};

function actionVerdictToLoopAction(action: ReviewAction): LoopAction {
  switch (action.verdict) {
    case "approve":
      return { type: "APPROVE", itemId: action.itemId };
    case "reject":
      return {
        type: "REJECT_HUMAN",
        itemId: action.itemId,
        feedback: action.feedback,
      };
    case "promote":
      return { type: "PROMOTE", itemId: action.itemId };
    case "retry":
      return { type: "RETRY", itemId: action.itemId };
    case "dismiss":
      return { type: "DISMISS", itemId: action.itemId };
  }
}

function pruneTerminal(items: LoopState["items"]): LoopState["items"] {
  const result: LoopState["items"] = {};
  for (const [id, item] of Object.entries(items)) {
    if (item.step !== "resolved" && item.step !== "promoted") {
      result[id] = item;
    }
  }
  return result;
}

function extractInboxItems(
  items: LoopState["items"],
): [LoopState["items"], LoopState["items"]] {
  const inbox: LoopState["items"] = {};
  const remaining: LoopState["items"] = {};
  for (const [id, item] of Object.entries(items)) {
    if (item.step === "inbox") {
      inbox[id] = item;
    } else {
      remaining[id] = item;
    }
  }
  return [inbox, remaining];
}

export async function loopStep(params: {
  loopConfigPath: string;
  action?: ReviewAction;
}): Promise<LoopState> {
  const statePath = `${params.loopConfigPath}/STATE.md`;
  const inboxPath = `${params.loopConfigPath}/INBOX.md`;

  // 1. Read files
  let stateMd: string;
  let inboxMd: string;
  try {
    stateMd = await Bun.file(statePath).text();
  } catch {
    stateMd = "";
  }
  try {
    inboxMd = await Bun.file(inboxPath).text();
  } catch {
    inboxMd = "";
  }

  let state = parseStateMd(stateMd);
  const inboxItems = parseInboxMd(inboxMd);

  // 2. Action or TICK
  if (params.action) {
    const action = params.action;

    if (action.verdict === "retry") {
      // Move from INBOX → STATE
      const item = inboxItems[action.itemId];
      if (item) {
        state = loopReducer(state, {
          type: "ADD_ITEM",
          item: { id: item.id, source: item.source, summary: item.summary },
          priority: item.priority,
        });
        // Remove from inbox — handled later via delete + write
        // TICK to push to fixing
        state = loopReducer(state, { type: "TICK" });
        // Handled: delete inbox entry after reducer
      }
    } else if (action.verdict === "dismiss") {
      // Remove from inbox — handled after merge
    } else {
      // APPROVE / REJECT_HUMAN / PROMOTE
      const itemInState = state.items[action.itemId];
      const itemInInbox = inboxItems[action.itemId];

      if (itemInState) {
        state = loopReducer(state, actionVerdictToLoopAction(action));
      } else if (itemInInbox) {
        // Item is in inbox — temporarily add to state, apply action, then extract
        state = loopReducer(
          { ...state, items: { ...state.items, [action.itemId]: itemInInbox } },
          actionVerdictToLoopAction(action),
        );
      }
      // If item doesn't exist: no-op (reducer handles unknown id)
    }
  } else {
    // Cron TICK
    state = loopReducer(state, { type: "TICK" });
  }

  // 3. Extract inbox items + prune terminal
  const [newInboxItems, remainingItems] = extractInboxItems(state.items);

  // Merge with existing inbox, minus dismissed/retried
  let mergedInbox: LoopState["items"];
  if (params.action?.verdict === "retry") {
    // Remove retried item from inbox
    mergedInbox = { ...inboxItems };
    delete mergedInbox[params.action.itemId];
  } else if (params.action?.verdict === "dismiss") {
    // Remove dismissed item from inbox
    mergedInbox = { ...inboxItems };
    delete mergedInbox[params.action.itemId];
  } else {
    // Merge new inbox items with existing
    mergedInbox = { ...inboxItems, ...newInboxItems };
  }

  state = { ...state, items: pruneTerminal(remainingItems) };

  // 4. Write back
  await Bun.write(statePath, formatStateMd(state));
  await Bun.write(inboxPath, formatInboxMd(mergedInbox));

  return state;
}
