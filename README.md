# Laboratory

A living test bench for the datacenter: a space where a program, low-level
or high-level, is exercised against the real platform from a real browser,
by several people at once, with every request visible. Docker is the only
dependency. The first bench is **grobase**, the BaaS running in the `baas`
VM built by born2root.

Think Storybook, turned toward a backend: instead of components in
isolation you get **probes** (one check each, rendered live), **cultures**
(personas with independent sessions: Ada, Linus, Grace, Margaret) and
**dishes** (scenarios that put several cultures in one probe). The same
registry powers the UI and the Playwright suite, so what you click is
exactly what CI asserts. A run exports as a **Slide** (Markdown + JSON).

## Quick start

```sh
cp .env.example .env && chmod 600 .env    # fill in TS_AUTHKEY, WAF_HOST, GROBASE_ANON_KEY
make up                                   # joins the tailnet, pins the WAF cert, serves the bench
open http://localhost:5180                # the bench · http://localhost:5181 is the hostile origin
make e2e                                  # Playwright in Docker: report/playwright/index.html, shots, videos
```

The bench schema is applied once by the VM owner (the gateway offers no
schema door in the `pro` tier):

```sh
make -C /goinfre/dlesieur/born2root sql FILE=$PWD/schema/001_grobase_bench.sql B2B_CONFIG=profiles/server.toml
```

## How it reaches the platform

```
browser  ──http://localhost:5180──►  lab (nginx, static)
   │
   └─fetch/WS──http://localhost:5174──►  relay (nginx) ─┐  same network namespace
                                          tailscale ────┘  a real tailnet device (kernel tun,
                                               │           rootless Docker)
                                               ▼  WireGuard
                                   https://<node>.ts.net:8443  WAF → Kong → grobase
```

The lab is a second device on the tailnet, subject to the same ACL a
teammate's laptop is. The browser origin (5180) and the API origin (5174)
differ on purpose: CORS is exercised for real, and the relay passes
`Origin` through untouched. The hostile origin (5181) serves the same app
from a port that is deliberately **not** in the gateway's list; its probes
are green when the browser refuses them.

The gateway is a knob: presets for the relay, the host SSH tunnel
(`make baas_access` in born2root, `http://127.0.0.1:18000`), the public
Funnel URL and the tailnet directly.

## Probes

| group | probe | what must hold |
| --- | --- | --- |
| Reach | Gateway is there | `/` answers, `/auth/v1/health` with the anon key, refused without it, REST OpenAPI, latency samples, Kong's exposed headers |
| CORS | This origin is allowed | preflighted GET and JSON POST pass; on the hostile origin both are refused (status 0) |
| CORS | A stranger origin is refused | the hostile page, in an iframe, reports what the browser let it see: nothing |
| Auth | Sign up, sign in, refresh, sign out | the session life, plus the answers that must be "no": wrong password, tampered token, refresh after sign-out; `rpc lab_ping` sees the same uid |
| Auth | The cast signs in | each culture holds its own session, distinct ids |
| Data | Rows, filters, pages, and who may see them | CRUD, `select`/`order`, `Range` paging, RPC, and RLS: Linus sees nothing private, everything public, cannot write or delete Ada's rows; anonymous reads public only |
| Realtime | Two cultures, one canvas | presence (each sees the other), a DB change crossing from Ada to Linus, cursors as broadcasts, roster shrinking on untrack |
| Realtime | Meet someone from another browser | opt-in: this page waits for anyone else on the topic; the Playwright "together" test runs it from two contexts |
| Storage | A file goes in and comes back equal | bucket, PNG upload, listing, download with equal SHA-256, signed URL, delete |
| Limits | The gateway pushes back | opt-in: a burst on the auth route must meet 429s |
| Engines | GraphQL door · Mongo door · The tenant you were issued | the other doors answer with the same key; a tenant key identifies the app at `/v1/tenants/me` |

## Playing together

Open the bench as someone else, anywhere: `http://localhost:5180/?culture=linus`
in another tab, another browser, or on a teammate's machine running its own
`make up`. Run *Meet someone from another browser* on both sides and watch
the rosters and cursors meet. Cultures have stable identities, so the same
Linus signs in from every device.

## Files

- `docker-compose.yml`: `tailscale`, `relay`, `lab`, `hostile`, `e2e` (profile).
- `relay/default.conf.template`: MagicDNS-resolved upstream, WebSocket upgrade, Origin passthrough.
- `certs/waf.pem`, `relay/tls.conf`: the WAF certificate pinned at first `make up`; verification is on when the chain validates against its pin, off (and said so) when the server does not send its issuer.
- `schema/001_grobase_bench.sql`: `lab_dishes`, `lab_notes`, RLS, `lab_ping`, `lab_note_count`; grobase's event trigger attaches realtime to new tables.
- `app/`: Vite + Preact + TypeScript, built in Docker. `src/lab/` is the contract (types, registry, client, cultures, store); `src/probes/` is the grobase bench; `src/ui/` the bench chrome.
- `e2e/`: Playwright, driven through `window.laboratory` (`list`, `run`, `runAll`, `results`, `slide`, `configure`).

## Adding a bench

A bench is a directory of probes registered through `registerProbe` with
the contract in `src/lab/types.ts`. Nothing in `src/lab` or `src/ui` knows
grobase; a bench for another backend, or for a low-level program driven
through a small HTTP shim, is a new `src/probes/<bench>/` and one import.
