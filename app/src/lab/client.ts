// The only way a probe talks to the platform. Every request and every
// WebSocket frame lands in the request log with what a person debugging
// CORS or latency wants to see: whether the browser had to preflight, the
// Access-Control-* answer, Kong's latency headers and request id.
import { pushLog } from './store';

let seq = 0;

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
}

const SIMPLE_METHODS = new Set(['GET', 'HEAD', 'POST']);

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
      const r = await fetch(url, { method, headers, body, signal: o.signal, credentials: 'omit' });
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
      entry.allowOrigin = r.headers.get('access-control-allow-origin');
      entry.allowCredentials = r.headers.get('access-control-allow-credentials');
      entry.upstreamMs = r.headers.get('x-kong-upstream-latency');
      entry.proxyMs = r.headers.get('x-kong-proxy-latency');
      entry.requestId = r.headers.get('x-request-id');
      pushLog(entry);
      return { status: r.status, ok: r.ok, headers: r.headers, json, text, ms: entry.ms };
    } catch (e) {
      entry.ms = Math.round(performance.now() - t0);
      entry.error = e instanceof Error ? e.message : String(e);
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
      pushLog(entry);
      return { status: r.status, ok: r.ok, data, type: r.headers.get('content-type'), ms: entry.ms };
    } catch (e) {
      entry.ms = Math.round(performance.now() - t0);
      entry.error = e instanceof Error ? e.message : String(e);
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
      ws.onclose = (ev) => this.log(`closed ${ev.code}`, ev.code === 1000 || ev.code === 1005, ev.code);
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
    try {
      this.send({ type: 'UNSUBSCRIBE', sub_id: this.subId });
    } catch {
      /* already gone */
    }
    this.ws?.close(1000);
  }
}
