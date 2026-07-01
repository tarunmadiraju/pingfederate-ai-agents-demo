# Workforce Portal — AI Coding Instructions

> Platform-wide context (hostnames, credentials, k3d patterns, trust model) is in `acp-platform/AGENTS.md`.

## Project Overview

Employee-facing web portal with an AI-powered Workforce Assistant. PingAccess acts as a BFF — the browser never sees OAuth tokens. All tokens are stored server-side in PA's encrypted session.

The browser communicates with the Workforce AI Agent exclusively via **AG-UI SSE** transport (`POST /api/agent/run`, proxied directly by PA — the portal pod is not in the path). The browser acts as an **AG-UI host**; the agent acts as an **AG-UI server** streaming typed events.

**Tech Stack**: Express (Node 22 Alpine), Vanilla HTML/JS (global scripts, no ES modules on frontend), Tailwind CSS (CDN).

## Architecture

### Two-Zone Express Server ([server.js](../server.js))

| Zone | Path | Protection | Purpose |
|------|------|-----------|---------|
| PUBLIC | `/` | None | Landing page (`landing.html`) |
| PUBLIC | `/health` | None | Health check |
| PROTECTED | `/workforce-portal` | PA Web Session (OIDC) | Dashboard (`index.html`) |
| PROTECTED | `/workforce-portal/me` | PA Header Identity Mapping | Returns `{sub, name, email}` from PA headers |
| PROTECTED | `/workforce-portal/reset` | PA Web Session (OIDC) | Reset demo data |
| PROTECTED | `/workforce-portal/traces` | PA Web Session (OIDC) | OTLP trace forwarder to Jaeger |
| PROTECTED | `/workforce-portal/trace/:traceId` | PA Web Session (OIDC) | Fetch + project beats for a given traceId → JSON for Telemetry panel |
| PROTECTED | `/authenticator-app` | PA Web Session (OIDC) | Mobile CIBA consent PWA |
| PROTECTED | `/authenticator-app/me` | PA Header Identity Mapping | Returns `{sub, name, email}` from PA headers |
| PROTECTED | `/workforce-portal/ciba/*` | PA Web Session (OIDC) | CIBA proxy → acp-ciba-service (browser-facing only; PA injects X-PA-Sub) |
| PROTECTED | `/authenticator-app/ciba/*` | PA Web Session (OIDC) | CIBA proxy → acp-ciba-service (authenticator app context) |

Protected routes rely on PingAccess — Express has no auth middleware. PA injects `X-PA-Sub`, `X-PA-Name`, `X-PA-Email` headers.

### PingAccess Pattern

The browser **never** handles tokens:
- PA stores tokens server-side, sets encrypted `PA.ACE_ws` HttpOnly cookie
- Frontend uses `credentials: 'same-origin'` on all `fetch()` calls — no `Authorization` headers
- `/api/*` requests are proxied by PA to the Workforce AI Agent with a PA-signed JWT injected via JWT Identity Mapping

### AG-UI Client (agentClient.js)

Browser-global IIFE that implements the AG-UI SSE client:
- No session lifecycle — each chat message is a stateless SSE run
- `runAgent(message, threadId, callbacks)` — POSTs to `/api/agent/run` (PA-proxied) and streams AG-UI events
- `readResource(uri)` — fetches MCP App HTML via `/api/agent/resource` (PA-proxied)
- `abortRun()` — cancels in-flight request via AbortController
- PA session cookie sent automatically (credentials: 'same-origin')

### MCP Apps (hotel-search)

Per the MCP Apps extension spec (2026-01-26), the portal implements a double-iframe sandbox proxy pattern:

1. Agent sets `_meta.ui.resourceUri` on `CallToolResult` for tools with UIs
2. Portal fetches HTML via `mcpClient.readResource(uri)`
3. Outer iframe (sandbox: allow-scripts allow-same-origin) loads the sandbox proxy
4. Sandbox proxy creates inner iframe (sandbox: allow-scripts only, CSP) with the View HTML
5. Full MCP Apps lifecycle: `sandbox-proxy-ready` → `sandbox-resource-ready` → `ui/initialize` → `initialized` → `tool-input` → `tool-result`

### File Structure

```
acp-workforce-portal/
├── server.js          # Express server (public + protected zones)
├── package.json       # ES module ("type": "module"), express only
├── Dockerfile         # Node 22 Alpine
├── index.html         # Authenticated dashboard (served at /workforce-portal)
├── landing.html       # Public landing page (served at /)
├── js/
│   ├── config.js      # CONFIG object (frozen, same-origin paths: agentRun, agentResource, health)
│   ├── auth.js        # fetchCurrentUser() via /workforce-portal/me, logout
│   ├── agentClient.js # AG-UI SSE client (IIFE, browser global)
│   ├── chat.js        # sendChatMessage(), AG-UI streaming helpers, state rendering, MCP App bridge,
│   │                  # CIBA consent cards, agent health LED
│   ├── elicitation.js # Inline elicitation cards (form + url modes)
│   ├── telemetry.js   # Telemetry panel: fetch trace per chat turn, render trace cards + beat summaries, handle modal
│   └── app.js         # initApp(), event wiring
└── deploy/            # Kustomize manifests (namespace: acp-workforce-portal)
```

## Key Coding Patterns

### Frontend (Vanilla JS, global scripts)
- All JS files loaded via `<script>` tags — **not** ES modules. Functions are globals.
- Load order: `config.js` → `otel-bundle.js` → `otel.js` → `auth.js` → `agentClient.js` → `elicitation.js` → `chat.js` → `telemetry.js` → `app.js`
- `CONFIG` is a deeply frozen global object. All API paths are same-origin (PA proxies).
- DOM manipulation via `document.getElementById()` / `createElement()` — no framework.
- Chat messages appended imperatively to the DOM.

### Auth ([auth.js](../js/auth.js))
- `fetchCurrentUser()` calls `/workforce-portal/me` — reads PA-injected identity headers
- `logout()` redirects to `/pa/oidc/logout` (PA SLO flow)
- No PKCE, no token storage, no authorization headers — PA handles everything

### AG-UI Client ([agentClient.js](../js/agentClient.js))
- Browser-global IIFE: `window.agentClient = { runAgent, getLastTraceId, abortRun, readResource }`
- Consumes the AG-UI SSE stream from `POST /api/agent/run` (PA-proxied)
- `runAgent(message, threadId, callbacks)` — streams events to typed callbacks, returns Promise<{ traceId, finalState }>
- `readResource(uri)` — fetches MCP App HTML via `/api/agent/resource` (PA-proxied)
- PA session cookie sent automatically (credentials: 'same-origin')
- No session lifecycle — each run is stateless; thread continuity is maintained by `threadId`

### Chat ([chat.js](../js/chat.js))
- `sendChatMessage()` calls `agentClient.runAgent(message, _conversationId, callbacks)`
- Streaming callbacks update the UI incrementally via `_startStreamBubble` / `_appendStreamDelta`
- `_renderStateResults()` renders AG-UI `STATE_SNAPSHOT`/`STATE_DELTA` results as tool output cards
- Renders typed data via `renderStructuredContent()` keyed by `structuredContent.type`
- Detects `_meta.ui.resourceUri` for MCP App iframe rendering
- Agent health polling via `/api/health` (15s interval, 3s timeout, status LED)
- CIBA consent card flow: polls `/ciba/pending`, renders consent UI, handles approve/deny
- `/new` slash command: resets `_conversationId` (starts new thread)
- `/reset` slash command: calls `/workforce-portal/reset` directly (portal backend, bypasses agent)

### Telemetry Panel ([telemetry.js](../js/telemetry.js))
- `toggleTelemetryPanel()` — expand/collapse the right-rail Telemetry panel
- `_upsertTraceCard(traceId, data)` — prepend a new trace card (newest on top); updates in place if card exists
- `renderTraceCard(data)` — renders beat summaries and status chip for a given trace
- Fetches `GET /workforce-portal/trace/:traceId` ~3s after each assistant reply; shows "tracing the flow…" pending state
- DOM IDs: `telemetry-stack`, `telemetry-panel-content`, `telemetry-panel-chevron`, `telemetry-trace-count-badge`
- CSS classes: `.telemetry-panel-content-expanded`, `.telemetry-chip`
- Log prefix: `[Telemetry]`

### Response Rendering
- `formatCallToolResult()` — dispatches based on `structuredContent.type`
- `renderStructuredContent()` — per-type renderers (expense cards, budget grid, flight cards, etc.)
- Authorization errors: amber-styled cards (insufficient_scope, CIBA consent)
- MCP App iframes: sandbox proxy pattern with full spec lifecycle

## Deployment

| Property | Value |
|----------|-------|
| Namespace | `acp-workforce-portal` |
| Image | `acp-workforce-portal:latest` |
| Port | 3000 |
| Ingress host | `portal-internal.localhost` (PA backend) |
| Browser URL | `https://portal-external.localhost` (through PA) |
| Health | `GET /health` |

## Testing Locally

```bash
# Direct (no PA, /workforce-portal/me returns 401):
node server.js

# Full flow requires PingAccess deployed and configured
```
