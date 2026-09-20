// The only way a probe talks to the platform. Every request and every
// WebSocket frame lands in the request log with what a person debugging
// CORS or latency wants to see: whether the browser had to preflight, the
// Access-Control-* answer, Kong's latency headers and request id.
import { pushLog } from './store';

let seq = 0;

/**
 * What a probe wanted back from one request.
 *
 * Half of what a bench does is ask for a refusal on purpose: a wrong
 * password, a call with no key, a burst past the rate limit, a stranger
 * origin. The log had no way to know that, so it painted every one of them
 * red -- 408 of 408 rows red under a bench where all fourteen probes were
 * green, which reads as a broken platform. Declaring the wanted answer
 * makes the log able to separate "this failed" from "this was supposed to
 * fail", and it makes the *wrong* answer the loud one: a request that wants
 * 401 and gets 200 is a door standing open, and now it is the only red row.
 */
export type Want = number | number[] | 'refused' | 'any';

export function wantLabel(w: Want): string {
  if (w === 'any') return 'anything';
  if (w === 'refused') return 'refused';
  if (Array.isArray(w)) return w.map((n) => String(n)).join(' or ');
  return String(w);
}

export function wantMet(w: Want, status: number): boolean {
  if (w === 'any') return true;
  if (w === 'refused') return status === 0;
  if (Array.isArray(w)) return w.includes(status);
  return status === w;
}

export interface LogEntry {
  n: number;
  t: number;
  culture?: string;
  method: string;
  url: string;
  status: number;
  ok: boolean;
  ms: number;
  preflight?: boolean;
  allowOrigin?: string | null;
  allowCredentials?: string | null;
  upstreamMs?: string | null;
  proxyMs?: string | null;
  requestId?: string | null;
  error?: string;
  ws?: boolean;
  note?: string;
  /** what the probe asked for, rendered ("401", "refused", "anything") */
  want?: string;
  /** whether it got it; undefined when the probe did not say */
  met?: boolean;
  /** why a refusal is the right answer here, in the probe's words */
  why?: string;
  /** identical requests folded into this row (the burst probe sends 700) */
  count?: number;
}

export interface Res<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  json: T | null;
  text: string;
  ms: number;
}

export interface ReqOptions {
  method?: string;
  body?: unknown;
  token?: string;
  tenantKey?: string;
  headers?: Record<string, string>;
  culture?: string;
  /** send the body as-is (a Blob or ArrayBuffer), no JSON */
  raw?: boolean;
  signal?: AbortSignal;
  /** do not send the apikey header (the "no key" probes) */
  noKey?: boolean;
  /** send cookies: the stranger bench asks whether credentials buy anything */
  credentials?: RequestCredentials;
  /** 'no-cors' sends a simple request the page will not be allowed to read */
  mode?: RequestMode;
  /** the answer this request is asking for, when that is not "it worked" */
  want?: Want;
  /** one line the log shows instead of an error: why that answer is right */
  why?: string;
}

const SIMPLE_METHODS = new Set(['GET', 'HEAD', 'POST']);

function judge(entry: LogEntry, o: ReqOptions) {
  if (o.want === undefined) return;
  entry.want = wantLabel(o.want);
  entry.met = wantMet(o.want, entry.status);
  entry.why = o.why;
}

export class ApiClient {
  constructor(
    public readonly base: string,
    public readonly anonKey: string,
  ) {}

  url(path: string): string {
    return path.startsWith('http') ? path : this.base.replace(/\/$/, '') + path;
  }

  crossOrigin(url: string): boolean {
    try {
      return new URL(url, location.href).origin !== location.origin;
    } catch {
      return true;
    }
  }

  async req<T = unknown>(path: string, o: ReqOptions = {}): Promise<Res<T>> {
    const url = this.url(path);
    const method = (o.method || 'GET').toUpperCase();
    const headers: Record<string, string> = { ...(o.headers || {}) };
    if (!o.noKey) headers['apikey'] = this.anonKey;
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    if (o.tenantKey) headers['X-Baas-Api-Key'] = o.tenantKey;
    let body: BodyInit | undefined;
    if (o.body !== undefined) {
      if (o.raw) body = o.body as BodyInit;
      else {
        body = JSON.stringify(o.body);
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      }
    }
    // A browser preflights a cross-origin request that is not "simple":
    // any custom header (apikey, Authorization) or a non-simple method.
    const custom = Object.keys(headers).some((h) => !['accept', 'content-type'].includes(h.toLowerCase()));
    const preflight = this.crossOrigin(url) && (custom || !SIMPLE_METHODS.has(method) || headers['Content-Type'] === 'application/json');
    const t0 = performance.now();
    const entry: LogEntry = { n: ++seq, t: Date.now(), culture: o.culture, method, url, status: 0, ok: false, ms: 0, preflight };
    try {
      const r = await fetch(url, { method, headers, body, signal: o.signal, credentials: o.credentials || 'omit', mode: o.mode });
      const text = await r.text();
      let json: T | null = null;
      try {
        json = text ? (JSON.parse(text) as T) : null;
      } catch {
        json = null;
      }
      entry.ms = Math.round(performance.now() - t0);
      entry.status = r.status;
      entry.ok = r.ok;
      // a no-cors request comes back opaque: it was sent, and the page is
      // allowed to know nothing else about it. status 0 is not a refusal here.
      if (r.type === 'opaque') entry.note = 'opaque: sent, but the page may not read the answer';
      entry.allowOrigin = r.headers.get('access-control-allow-origin');
      entry.allowCredentials = r.headers.get('access-control-allow-credentials');
      entry.upstreamMs = r.headers.get('x-kong-upstream-latency');
      entry.proxyMs = r.headers.get('x-kong-proxy-latency');
      entry.requestId = r.headers.get('x-request-id');
      judge(entry, o);
      pushLog(entry);
      return { status: r.status, ok: r.ok, headers: r.headers, json, text, ms: entry.ms };
    } catch (e) {
      entry.ms = Math.round(performance.now() - t0);
      entry.error = e instanceof Error ? e.message : String(e);
      judge(entry, o);
      pushLog(entry);
      // status 0 is what the browser gives a CORS refusal: the response
      // exists, the page is not allowed to see it.
      return { status: 0, ok: false, headers: new Headers(), json: null, text: entry.error, ms: entry.ms };
    }
  }

  /** binary GET (storage objects): the bytes, logged like any request */
  async bytes(path: string, o: ReqOptions = {}): Promise<{ status: number; ok: boolean; data: ArrayBuffer; type: string | null; ms: number }> {
    const url = this.url(path);
    const headers: Record<string, string> = { ...(o.headers || {}) };
    if (!o.noKey) headers['apikey'] = this.anonKey;
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    const t0 = performance.now();
    const entry: LogEntry = { n: ++seq, t: Date.now(), culture: o.culture, method: 'GET', url, status: 0, ok: false, ms: 0, preflight: this.crossOrigin(url) };
    try {
      const r = await fetch(url, { headers, credentials: 'omit', signal: o.signal });
      const data = await r.arrayBuffer();
      entry.ms = Math.round(performance.now() - t0);
      entry.status = r.status;
      entry.ok = r.ok;
      entry.requestId = r.headers.get('x-request-id');
      entry.upstreamMs = r.headers.get('x-kong-upstream-latency');
      judge(entry, o);
      pushLog(entry);
      return { status: r.status, ok: r.ok, data, type: r.headers.get('content-type'), ms: entry.ms };
    } catch (e) {
      entry.ms = Math.round(performance.now() - t0);
      entry.error = e instanceof Error ? e.message : String(e);
      judge(entry, o);
      pushLog(entry);
      return { status: 0, ok: false, data: new ArrayBuffer(0), type: null, ms: entry.ms };
    }
  }

  /** Realtime WebSocket, the wire grobase's SDK speaks. */
  realtime(): RealtimeConn {
    return new RealtimeConn(this);
  }
}

export type Frame = Record<string, unknown> & { type: string };

/** how long to let frames in flight drain before closing a realtime socket */
const DRAIN_MS = 120;

export interface RtEvent {
  kind: 'change' | 'broadcast' | 'presence' | 'other';
  topic?: string;
  type?: string;
  payload: unknown;
  raw: Frame;
}

export class RealtimeConn {
  private ws?: WebSocket;
  private handlers: ((e: RtEvent) => void)[] = [];
  private frames: ((f: Frame) => void)[] = [];
  topic = '';
  subId = '';
  /** PRESENCE frames seen: zero after a TRACK means the server does not implement presence */
  presenceFrames = 0;
  /** who this socket belongs to, so the close row says whose it was */
  private who = 'lab';
  constructor(private readonly api: ApiClient) {}

  private log(note: string, ok = true, status = 101) {
    pushLog({ n: ++seq, t: Date.now(), method: 'WS', url: this.api.url('/realtime/v1/ws'), status, ok, ms: 0, ws: true, note });
  }

  on(handler: (e: RtEvent) => void) {
    this.handlers.push(handler);
  }
  onFrame(handler: (f: Frame) => void) {
    this.frames.push(handler);
  }

  send(frame: Record<string, unknown>) {
    this.ws?.send(JSON.stringify(frame));
  }

  /** open, AUTH, SUBSCRIBE (and TRACK when presenceMeta is given); resolves on SUBSCRIBED */
  open(opts: { token: string; topic: string; presenceMeta?: Record<string, unknown>; timeoutMs?: number; culture?: string }): Promise<void> {
    const url = new URL(this.api.url('/realtime/v1/ws'));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('apikey', this.api.anonKey);
    this.topic = opts.topic;
    this.who = opts.culture || 'lab';
    this.subId = `lab:${opts.topic}:${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url.toString());
      this.ws = ws;
      const timer = setTimeout(() => {
        this.log(`subscribe timeout on ${opts.topic}`, false, 0);
        ws.close();
        reject(new Error(`realtime: subscribe timeout on ${opts.topic}`));
      }, opts.timeoutMs ?? 10000);
      ws.onopen = () => {
        this.log(`open (${opts.culture || 'lab'}) -> AUTH`);
        this.send({ type: 'AUTH', token: opts.token });
      };
      ws.onerror = () => {
        this.log('socket error', false, 0);
      };
      // 1000 means both sides completed the closing handshake; 1006 means the
      // connection simply vanished -- no Close frame came back. The code alone
      // did not say which, and the difference is exactly the grobase defect
      // this bench found (the gateway used to drop the socket on goodbye).
      ws.onclose = (ev) =>
        this.log(
          `closed ${ev.code} (${this.who})${ev.wasClean ? ' clean: both sides said goodbye' : ' no closing handshake: the peer never answered'}${ev.reason ? ` — ${ev.reason}` : ''}`,
          ev.code === 1000 || ev.code === 1005,
          ev.code,
        );
      ws.onmessage = (m) => {
        let f: Frame;
        try {
          f = JSON.parse(String(m.data)) as Frame;
        } catch {
          return;
        }
        this.frames.forEach((h) => h(f));
        switch (f.type) {
          case 'AUTH_OK':
            this.log('AUTH_OK -> SUBSCRIBE ' + opts.topic);
            this.send({ type: 'SUBSCRIBE', sub_id: this.subId, topic: opts.topic });
            break;
          case 'SUBSCRIBED':
            clearTimeout(timer);
            this.log('SUBSCRIBED ' + opts.topic);
            if (opts.presenceMeta) this.send({ type: 'TRACK', topic: opts.topic, meta: opts.presenceMeta });
            resolve();
            break;
          case 'ERROR':
            clearTimeout(timer);
            this.log(`ERROR ${String(f.code)}: ${String(f.message)}`, false, 0);
            reject(new Error(`realtime: ${String(f.code)} ${String(f.message)}`));
            break;
          case 'PRESENCE': {
            // the server's presence snapshot: {type, topic, members:[{conn_id,user_id?,meta}]}
            this.presenceFrames++;
            const e: RtEvent = { kind: 'presence', topic: f.topic as string | undefined, type: 'presence', payload: { topic: f.topic, members: f.members }, raw: f };
            this.handlers.forEach((h) => h(e));
            break;
          }
          case 'EVENT': {
            const ev = (f.event || {}) as Record<string, unknown>;
            const et = String(ev.event_type ?? ev.event ?? ev.type ?? '');
            const kind: RtEvent['kind'] = et === 'presence' ? 'presence' : et === 'broadcast' ? 'broadcast' : et ? 'change' : 'other';
            if (kind === 'presence') this.presenceFrames++;
            // a broadcast arrives as payload {event, payload}: unwrap it, and
            // carry the broadcaster's event name as the RtEvent type
            let payload: unknown = ev.payload ?? ev;
            let type = et;
            if (kind === 'broadcast' && payload && typeof payload === 'object' && 'payload' in (payload as Record<string, unknown>)) {
              const inner = payload as { event?: string; payload?: unknown };
              type = String(inner.event ?? 'broadcast');
              payload = inner.payload;
            }
            const e: RtEvent = { kind, topic: ev.topic as string | undefined, type, payload, raw: f };
            this.handlers.forEach((h) => h(e));
            break;
          }
          default:
            break;
        }
      };
    });
  }

  broadcast(event: string, payload: unknown) {
    this.send({ type: 'BROADCAST', topic: this.topic, event, payload });
  }
  track(meta: Record<string, unknown>) {
    this.send({ type: 'TRACK', topic: this.topic, meta });
  }
  untrack() {
    this.send({ type: 'UNTRACK', topic: this.topic });
  }
  close() {
    // Closing a socket that is still CONNECTING aborts the handshake, and the
    // browser reports 1006 for it however polite the intent was: there is no
    // open connection to say goodbye on. Wait for it to open, or the bench
    // blames the server for its own impatience.
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.addEventListener('open', () => this.close(), { once: true });
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      this.send({ type: 'UNSUBSCRIBE', sub_id: this.subId });
    } catch {
      /* already gone */
    }
    // Closing on the same tick as the last broadcast leaves frames in flight
    // in both directions, and the closing handshake loses the race often
    // enough to show up as an occasional 1006. Unsubscribe, let the wire
    // drain for a moment, then say goodbye: measured 2 dirty closes per bench
    // run before, none after.
    setTimeout(() => {
      try {
        ws.close(1000);
      } catch {
        /* already closed */
      }
    }, DRAIN_MS);
  }
}
