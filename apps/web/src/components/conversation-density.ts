import { createContext } from "react";

/** Which scale a conversation runs at. A chat page uses the prototype's page scale; the same
 *  panel embedded in a side sheet (an editor with the PA's conversation beside it) uses the
 *  prototype's tighter editor-panel scale. Width-based media queries cannot tell these apart —
 *  a 660px sheet on a 1440px desktop — so the embedding sheet states it. */
export type ConversationDensity = "page" | "panel";

/** Read it with `useContext`; the default is the page scale. */
export const ConversationDensityContext = createContext<ConversationDensity>("page");
