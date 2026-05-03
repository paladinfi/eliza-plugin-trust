/**
 * Error scrubbing for paid-mode error sites.
 *
 * viem errors carry rich context — `.cause`, `.details`, `.metaMessages`,
 * full request init — that we never want surfaced to users or logged. A raw
 * `String(error)` after a failed sign can leak headers, body bytes, or worse.
 *
 * `scrubViemError` returns a bounded, single-string summary safe to surface.
 */

export function scrubViemError(e: unknown): string {
  if (e instanceof Error) {
    const short = (e as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string" && short.length > 0) {
      return short.slice(0, 200);
    }
    const msg = e.message ?? "";
    return msg.length > 0 ? msg.slice(0, 200) : "redacted error";
  }
  return String(e).slice(0, 200);
}
