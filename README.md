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
cp .env.example .env && chmod 600 .env    # TS_AUTHKEY, WAF_HOST, GROBASE_ANON_KEY, GROBASE_REALTIME_TOKEN
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
| Realtime | A row Ada writes reaches Linus | two sockets on `pg/lab_notes/*`: inserted, updated (old and new row), deleted by cascade, in order |
| Realtime | Presence and cursors (broadcast) | two cultures join a `lab/bench/*` room with the publish-capable realtime token, each in the presence meta; cursors cross as broadcasts; the roster shrinks on untrack. Skipped with the reason without the token |
| Realtime | Meet someone from another browser | opt-in: heartbeat notes carry each page's cursor through the database; anyone else on the topic appears as a moving cursor; the Playwright "together" test runs it from two contexts |
| Storage | A file goes in and comes back equal | bucket, PNG upload, listing, download with equal SHA-256, signed URL, delete |
| Limits | The gateway pushes back | opt-in: a burst on a route Kong limits to 300/min must meet 429s (the auth route allows 60000/min, out of a browser's reach) |
| Engines | GraphQL door · Mongo door · The tenant you were issued | the other doors answer with the same key; a tenant key identifies the app at `/v1/tenants/me` |

## What it looks like

![the bench: probe tree, live canvas, knobs, request log](docs/shots/bench.png)

Ada's page during a meeting with Linus from another browser, cursors
arriving through the database:

![meet](docs/shots/meet.png)

The same app served from the hostile origin: green means the browser
refused, as it must.

![hostile origin](docs/shots/hostile-origin.png)

A burst against a limited route: 300 reach Kong's proxying, the rest get 429.

![limits](docs/shots/limits.png)

## What the bench found on its first day (2026-09-20)

Real platform behaviour, all reproduced through the WAF door and now
either fixed in born2root's installer or reported here:

- **PATCH, PUT and DELETE were refused by the WAF** with an HTML 403 and
  no CORS headers (browsers see "status 0"). grobase ships a CRS override
  widening the allowed methods, but the image's `setup.conf` never
  includes it, so the CRS default (GET HEAD POST OPTIONS) applied; `image/png`
  bodies were refused too. born2root's `install_grobase.sh` now sets the CRS
  image's `ALLOWED_METHODS` / `ALLOWED_REQUEST_CONTENT_TYPE` on the WAF.
- **Realtime topics are `pg/<table>/<inserted|updated|deleted>`**, without
  the schema; the JS SDK's default pattern (`pg/<schema>/<table>/*`)
  never matches. The bench subscribes to `pg/lab_notes/*`.
- **Presence and broadcast need a token GoTrue never issues.** The
  realtime plane accepts TRACK and BROADCAST only from a JWT carrying
  `can_publish: true` and a namespace grant; user sessions carry neither, so
  the plane logs "Track denied (namespace)" and stays silent, SDK included.
  born2root's `make realtime_token` now mints one in the guest, scoped to
  the `pg` and `lab` namespaces, the way grobase's own seed does for its
  game clients; the bench carries it as `GROBASE_REALTIME_TOKEN`. The
  published `:latest` realtime image predates presence entirely; the VM
  now runs the image tagged with the clone's commit.
- **The auth route allows 60,000 requests a minute per address**, not
  300; the 300/min limits sit on the tmdb, search and hypertube routes.
  Kong counts in fixed calendar minutes (a burst straddling the boundary
  never trips it) and, with `policy: local`, per Kong node.
- `/v1/tenants/me` takes the tenant key as `Authorization: Bearer`, not
  `X-Baas-Api-Key`; `/storage/v1/sign` wants the `method` it signs for; a
  refresh in the same second as sign-in returns a byte-identical JWT.
- `/graphql/v1` answers 406: PostgREST exposes no graphql schema in this
  image.

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
