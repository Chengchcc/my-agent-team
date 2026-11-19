/** ADR 0067: a stranger may not drive this agent, but silence teaches them
 *  nothing. A DM from a non-allowlisted person becomes an ACCESS REQUEST the
 *  operator answers, and both sides get a plain-text answer.
 *
 *  Text commands, not buttons: the grant path is a security boundary, so the
 *  smallest surface that can carry it wins. Buttons would add a card renderer
 *  and an action decoder in front of the same `open_id` argument. */

export interface AccessCommand {
  kind: "approve" | "deny";
  openId: string;
}

/** `/approve ou_<id>` / `/deny ou_<id>` from the operator's own DM.
 *
 *  Whitespace and case are forgiven (people type on phones); anything else — a
 *  sentence that happens to contain a command — is not a command, because the
 *  whole trimmed line has to match. */
export function parseOwnerCommand(text: string): AccessCommand | null {
  const m = text.trim().match(/^\/(approve|deny)\s+(\S+)$/i);
  if (!m) return null;
  const openId = m[2]!;
  // A malformed id would be written into the allowlist and never match again.
  if (!openId.startsWith("ou_") || openId.length <= 3) return null;
  return { kind: m[1]!.toLowerCase() === "approve" ? "approve" : "deny", openId };
}

/** What the stranger sees on their first DM (and on repeats while pending). */
export function requesterPendingText(): string {
  return "这个机器人是私人的，我先把你的使用申请转给管理员了。批准后你再发消息就能直接用。";
}

/** The operator's notice. The open_id is the argument their reply needs, so it
 *  is on its own line and the reply template is copy-pasteable. */
export function ownerNoticeText(input: {
  displayName: string;
  openId: string;
  created: boolean;
}): string {
  const who = input.displayName !== "" ? `${input.displayName}（${input.openId}）` : input.openId;
  const head = input.created ? `有人申请使用这个机器人：${who}` : `仍在等待你的决定：${who}`;
  return [head, `批准：/approve ${input.openId}`, `拒绝：/deny ${input.openId}`].join("\n");
}

export function requesterApprovedText(): string {
  return "管理员已批准，你现在可以直接跟我说话了。";
}

export function requesterDeniedText(): string {
  return "管理员拒绝了这次使用申请。";
}

/** The operator's own confirmation after running a command. */
export function ownerDecidedText(input: { openId: string; approve: boolean }): string {
  return input.approve
    ? `已批准 ${input.openId}，并写进了这个 agent 的允许名单。`
    : `已拒绝 ${input.openId}。`;
}
