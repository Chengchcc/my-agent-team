import type { TokenProvider } from "./lark-api.js";

/**
 * ADR 0044 decision 6: cloud-doc events are PER FILE. Measured on the isolated
 * app (2026-10-14): with the app-level subscription in place but no per-file
 * call, a real comment produced no event at all; after this call the event
 * arrived on the long connection within milliseconds.
 *
 * `file_type` belongs in the QUERY STRING — in the body the API answers
 * `field validation failed: file_type is required`, which cost three rounds to
 * find. The call is idempotent on the platform's side (`get_subscribe` reports
 * `is_subscribe: true` afterwards), so re-running it is safe.
 */

const EVENT_TYPE = "drive.notice.comment_add_v1";
const DRIVE_API = "/open-apis/drive/v1/files";
/** The response is small; a longer body means something unexpected answered. */
const DETAIL_LIMIT = 200;

export interface SubscribeResult {
  ok: boolean;
  status: number;
  detail: string;
}

/** Registers this document for `drive.notice.comment_add_v1` notifications.
 *  Never throws: the caller logs the verdict and keeps working (a document that
 *  cannot be subscribed means no comment trigger for it, not a dead bot). */
export async function subscribeDocEvents(
  provider: TokenProvider,
  fileToken: string,
  fileType: string,
): Promise<SubscribeResult> {
  try {
    const token = await provider.getToken();
    const base = provider.getBaseUrl();
    const url =
      `${base}${DRIVE_API}/${encodeURIComponent(fileToken)}/subscribe` +
      `?file_type=${encodeURIComponent(fileType)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ event_type: EVENT_TYPE }),
    });
    const detail = (await res.text()).slice(0, DETAIL_LIMIT);
    return { ok: res.ok, status: res.status, detail };
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}
