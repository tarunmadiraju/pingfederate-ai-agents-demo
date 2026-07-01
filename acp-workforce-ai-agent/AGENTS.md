# Workforce AI Agent — AI Coding Instructions

> Platform-wide context (hostnames, credentials, k3d patterns, trust model) is in `acp-platform/AGENTS.md`.

## Project Overview

Express.js service that exposes the **AG-UI protocol** to the Workforce Portal and acts as an **MCP Client** to downstream MCP servers — expense-mcp, travel-mcp. The portal communicates via SSE-streamed AG-UI events on `POST /api/agent/run`. The agent **remains an MCP client** to downstream tools; only the portal-to-agent boundary moved to AG-UI.

The agent receives requests through PingAccess → Envoy + Authn Sidecar with an actor-injected request carrying both the user's subject token (`X-Subject-Token`) and the agent's SPIFFE identity (`Authorization: Bearer <JWT-SVID>`). It streams AG-UI events as the keyword or LLM router executes downstream MCP tools.

**Tech Stack**: Node.js 20 (Alpine), Express, ES Modules, `@ag-ui/core@0.0.53`, `@ag-ui/encoder@0.0.53`, `rxjs@7.8.1`.

## Architecture

### AG-UI Server (to portal)

The agent exposes the AG-UI protocol over SSE. The portal POSTs a `RunAgentInput` and the agent streams a sequence of typed AG-UI events (`RUN_STARTED`, `STATE_SNAPSHOT`, `STEP_*`, `TOOL_CALL_*`, `STATE_DELTA`, `TEXT_MESSAGE_*`, `CUSTOM`, `RUN_FINISHED`).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Health check + active-run count |
| `POST` | `/api/agent/run` | Start or resume a run; streams AG-UI events as `text/event-stream` (carries `resume[]` for AG-UI Interrupts) |
| `GET` | `/api/agent/resource?uri=ui://server/path` | Proxy a downstream MCP resource (e.g., MCP App HTML) |

**RunAgentInput shape** (per `@ag-ui/core`):
```jsonc
{
  "threadId": "thread-123",
  "runId": "run-456",
  "messages": [{ "role": "user", "content": "list my expenses" }],
  "tools": [],          // optional, ignored — agent uses its own MCP tool catalog
  "state": { ... },     // optional prior state, hydrated into the run's stateManager
  "resume": [ ... ]     // optional AG-UI Interrupts resume entries (see Elicitation)
}
```

**Event sequence** — see `acp-platform/docs/IMPL-PLAN-AGUI-INTEGRATION.md` (lines 64–102) for the full LLM and keyword-mode flows.

**State schema** — `state.results[]` (append-only card history), `state.error` (set on auth errors). Full schema in the plan (lines 36–56).

**Elicitation (AG-UI Interrupts)** — when a tool needs user input (gather missing args, confirm a destructive booking, OAuth delegation), the run terminates with `RUN_FINISHED { outcome: { type: "interrupt", interrupts: [{ id, reason, responseSchema?, data }] } }`. A continuation is saved server-side keyed by `interruptId` (in-memory `interruptStore`, 120s TTL). The portal renders the prompt, then starts a follow-up run on the same `threadId` with `RunAgentInput.resume = [{ interruptId, status: "resolved"|"cancelled", payload? }]`. Spec: <https://docs.ag-ui.com/concepts/interrupts>.

**CIBA error path** — when a downstream MCP server returns an authorization error, the agent emits `STATE_DELTA` setting `state.error.type = "authorization_error"` plus `CUSTOM { name: "ciba.consent_pending", value: <unchanged payload> }`, then `RUN_FINISHED`. The portal continues polling `/ciba/pending` exactly as before.

### MCP Client (to downstream servers)

The agent connects to downstream MCP servers via `src/mcpClient.js` (Streamable HTTP client with SSE parsing, session caching per-actor token with 5-min TTL):

| Server Key | URL | Tools |
|-----------|-----|-------|
| `expense-mcp` | `https://acp-expense-mcp.localhost` | get_expense_status, list_expenses, list_pending_approvals, approve_expense, submit_expense, get_budget_summary |
| `travel-mcp` | `https://acp-travel-mcp.localhost` | search_flights, book_flight, get_booking, search_hotels, book_hotel, get_itinerary |

### MCP Apps

Only `search_hotels` on `travel-mcp` has an MCP App. The agent sets `_meta.ui.resourceUri: "ui://travel-mcp/hotel-search.html"` on the `CallToolResult`, and proxies `resources/read` requests from the portal to the downstream server via a `ResourceTemplate`.

### Envoy + Authn Sidecar

The agent does NOT handle authentication or token exchange directly. An Envoy proxy and Authn Sidecar (`acp-identity-sidecar`) run as native K8s sidecars in the same pod:

**Inbound (Envoy :10000 → ext_proc → Agent :3002)**:
1. The K8s Service (port 3001) routes inbound traffic to Envoy's inbound listener (:10000)
2. Envoy calls the Authn Sidecar's ext_proc gRPC service (:9010) on every request via bidirectional streaming
3. The sidecar extracts the subject token from the Authorization header, moves it to `X-Subject-Token`
4. The sidecar mints a SPIFFE JWT-SVID (actor identity) and injects it as `Authorization: Bearer <JWT-SVID>`
5. Envoy applies the header mutations (SetHeaders + RemoveHeaders) and forwards to the agent on localhost:3002
6. Dynamic metadata (`subject`, `actor_spiffe_id`) is populated for Envoy access logs

**Outbound (Agent → iptables → Envoy :15001)**:
1. An `iptables-init` container sets up traffic interception rules (exclude UIDs 1337/Envoy, 10002/authn sidecar, localhost)
2. Agent's outbound TCP connections are redirected to Envoy's outbound listener (:15001) via iptables
3. Envoy uses TLS inspector to separate TLS (TCP passthrough) from HTTP traffic
4. HTTP to CIBA-capable hosts (pinggateway.localhost) is routed to the CIBA proxy (:15002)
5. On 403 `insufficient_scope`, the CIBA proxy initiates a CIBA consent flow with PingFederate, polls for approval, and retries
6. All other HTTP traffic passes through to the original destination via `ORIGINAL_DST` cluster

The agent receives requests with a JWT-SVID as the Bearer token and the user's subject token in `X-Subject-Token`.

## File Structure

```
src/
├── index.js                    # Express server — mounts AG-UI routes, /api/health
├── config.js                   # Centralized config from env vars (server, MCP, llm)
├── mcpClient.js                # MCP Streamable HTTP client to downstream MCP servers
├── routerState.js              # Mutable routing mode singleton ({ mode: 'keyword' })
├── agui/
│   ├── auth.js                 # extractAuth(req) — Bearer + X-Subject-Token
│   ├── eventEmitter.js         # AguiEventEmitter — typed emit methods, SSE framing,
│   │                           # 15s keep-alive
│   ├── stateManager.js         # AguiStateManager — STATE_SNAPSHOT/STATE_DELTA helpers,
│   │                           # RFC 6902 patches (plain JS, no deps)
│   ├── interruptStore.js       # Map<interruptId, Continuation> — save/claim, 120s TTL
│   ├── interruptError.js       # Sentinel thrown by elicitation callbacks; bubbled to outcome
│   ├── chatExecutor.js         # Routing → dispatch → elicitation flow (keyword mode)
│   ├── runHandler.js           # POST /api/agent/run entry; activeRuns counter
│   ├── keywordRunHandler.js    # AG-UI event sequence for keyword mode
│   └── llmRunHandler.js        # ReAct loop with token streaming via Ollama (LLM mode)
└── routers/
    └── keywordToolRouter.js    # Deterministic keyword chain → { toolName, toolArgs } | null
```

LLM routing in this codebase is the ReAct loop in `agui/llmRunHandler.js` — there is no separate router module for LLM mode. The keyword router is unchanged.

## Key Patterns

- **ES Modules** throughout (`import`/`export`, `"type": "module"`)
- **Config-first**: All env-driven config centralized in `config.js` (including `config.llm`: `ollamaUrl`, `model`, `timeoutMs`)
- **Routing modes**: Selected at runtime by `routerState.mode` (toggled via `/mode keyword`, `/mode llm`, `/mode status` chat commands; resets on pod restart).
  - `keyword`: deterministic `string.includes()` chain in `routers/keywordToolRouter.js`. Result flows through `agui/keywordRunHandler.js` → `agui/chatExecutor.executeChat()` → `dispatch()` → `callMcpTool()`.
  - `llm`: ReAct loop in `agui/llmRunHandler.js` against Ollama's OpenAI-compatible `/v1/chat/completions` endpoint with `stream: true`. Token deltas are emitted as `TEXT_MESSAGE_CONTENT`; tool calls flow through the same `dispatch()`.
- **Shared dispatch()**: Both modes feed into `dispatch(toolName, toolArgs, serverKey, ...)` in `agui/chatExecutor.js`, which calls `callMcpTool()` and formats the per-tool response.
- **State.results view names**: `agui/chatExecutor.viewForTool()` maps `toolUsed` → the `view` field in `state.results[]` entries (canonical view names below). The portal renders cards based on `view`.
- **Auth error signaling**: Authorization errors (insufficient_scope, CIBA) appear as `CUSTOM { name: "ciba.consent_pending", value }` events plus a `STATE_DELTA` setting `state.error.type = "authorization_error"`.
- **Inbound ext_proc**: Authn sidecar rewrites headers (subject → X-Subject-Token, inject actor SVID) via Envoy ext_proc filter — agent receives JWT-SVID + subject token.
- **Outbound Envoy routing**: Agent's outbound connections intercepted by iptables → Envoy; CIBA-capable host (`pinggateway.localhost`) routed to CIBA proxy; all other hosts (including `host.k3d.internal:11434` for Ollama) pass through via `ORIGINAL_DST`.

## state.results[].view names

| Downstream Tool | view |
|----------------|------|
| `list_expenses` | `expense_list` |
| `list_pending_approvals` | `approval_list` |
| `get_expense_status` | `expense_detail` |
| `approve_expense` / `submit_expense` | `expense_action` |
| `get_budget_summary` | `budget_summary` |
| `search_flights` | `flight_results` |
| `book_flight` / `book_hotel` | `booking_confirmation` |
| `get_booking` | `booking_detail` |
| `search_hotels` | `hotel_results` |
| `get_itinerary` | `itinerary` |
| `get_financial_report` | `financial_report` |

## Ollama / LLM Mode

- **Model**: `auto` by default — resolves to the first model from `GET /api/tags` at startup (configurable via `OLLAMA_MODEL` env var / configmap).
- **Startup behavior**: `config.js` resolves `OLLAMA_MODEL=auto` and runs a non-blocking tool-calling probe at startup. Warnings only — Ollama is never required and never blocks startup.
- **Streaming**: `agui/llmRunHandler.js` uses `stream: true` on `/v1/chat/completions` and parses the SSE-style `data: {...}\n\n` chunks. Text deltas → `TEXT_MESSAGE_CONTENT`; tool-call fragments are accumulated and emitted as a single `TOOL_CALL_ARGS` per call.
- **ReAct loop cap**: `LLM_MAX_ITERATIONS` (default 5) prevents infinite loops; exceeding it surfaces as `RUN_ERROR`.
- **Ollama runs on the Mac host** via Homebrew (`brew services start ollama`), NOT inside k3d (no GPU in Docker).
- **URL from inside k3d pods**: `http://host.k3d.internal:11434` (k3d injects this hostname automatically).
- **Tool list**: fetched live from each MCP server via `listMcpTools()`, converted to OpenAI tool format. The `_source` tag on each tool routes the dispatch.
- **Configmap keys**: `OLLAMA_URL`, `OLLAMA_MODEL` (default: `auto`), `LLM_TIMEOUT_MS`, `LLM_MAX_ITERATIONS`.

## Deployment

| Property | Value |
|----------|-------|
| Namespace | `ai-agents` |
| Image | `acp-workforce-ai-agent:latest` |
| Port | 3002 (behind Envoy on 10000, K8s Service on 3001) |
| Ingress host | `workforce-ai-agent.localhost` |
| ServiceAccount | `workforce-ai-agent` |
| SPIFFE ID | `spiffe://demo.spiffe.io/ns/ai-agents/sa/workforce-ai-agent` |
| Envoy Sidecar | `envoyproxy/envoy:v1.32-latest` (inbound: 10000, outbound: 15001, admin: 9901) |
| Authn Sidecar | `acp-identity-sidecar` (ext_proc gRPC: 9010, HTTP proxy: 15002) |
| Init Container | `iptables-init` (redirects outbound to Envoy, excludes UID 1337 + 10002) |
