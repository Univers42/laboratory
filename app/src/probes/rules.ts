// The judgements a probe makes about the platform, as pure functions.
//
// They used to live inside the call that produced the evidence, where the only
// way to exercise them was to break the platform for real. Mutation testing
// walked in and weakened three of them -- "blocked" accepted any status, the
// change order accepted any order, the burst accepted no 429 at all -- and the
// whole Playwright suite stayed green, because every spec only ever asked
// "did the probe say ok?". Out here they can be fed the inputs a healthy
// platform never produces, which is what e2e/rules.spec.ts does through
// window.laboratory.rules.

/** the browser refused a cross-origin request: no status ever reaches the page */
export function blockedByBrowser(seen: { status?: number } | undefined): boolean {
  return seen !== undefined && seen.status === 0;
}

/** the life of one row as realtime delivered it, in order */
export function changeOrder(types: string[]): string {
  return types.join(',');
}

/** insert, then update, then delete -- all three, once each, in that order */
export function isFullChangeOrder(types: string[]): boolean {
  return changeOrder(types) === 'inserted,updated,deleted';
}

/** the burst met the gateway's limit rather than sailing past it */
export function sawRateLimit(hist: Record<string, number>): boolean {
  return (hist['429'] || 0) > 0;
}

/**
 * the realtime handshake was turned away. Its own judgement rather than a bare
 * `!opened`, because CORS cannot express this one: a WebSocket is upgraded
 * without a preflight, so only the server's own Origin check can refuse it,
 * and "the socket opened" is the whole finding.
 */
export function socketRefused(outcome: { opened: boolean }): boolean {
  return !outcome.opened;
}

/**
 * A socket the bench closed politely must come back closed politely.
 *
 * RFC 6455 §5.5.1: an endpoint that receives a Close frame must send one
 * back. A server that just drops the connection leaves the browser reporting
 * code 1006 ("abnormal closure"), which an SDK cannot tell from the network
 * dying -- so a normal goodbye drives reconnect-with-backoff and error logs.
 * 1000 is the completed handshake, 1005 is "no status", which is still clean.
 */
export function closedCleanly(close: { code: number; wasClean: boolean }): boolean {
  return close.wasClean && (close.code === 1000 || close.code === 1005);
}

export const RULES = { blockedByBrowser, changeOrder, isFullChangeOrder, sawRateLimit, socketRefused, closedCleanly };
