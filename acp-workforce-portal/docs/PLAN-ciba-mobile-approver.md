# Plan: Acme Corp Authenticator App (CIBA Mobile Approver PWA)

## Goal

Build a Progressive Web App (PWA) served by the existing Workforce Portal that provides a native-feel iOS mobile experience for approving/denying CIBA consent requests. Named **"Authenticator App"** with full Acme Corp branding matching the Workforce Portal.

## Architecture Decision

**Option B: PWA client reusing portal APIs** — zero new backend services, zero new PA configuration.

The PWA is a different frontend skin on the same PA-protected CIBA endpoints. It reuses the existing `/app/ciba/pending` and `/app/ciba/action` routes with the PA session cookie (`credentials: 'same-origin'`).

### Why This Works

- `/app/*` is already routed by PingAccess to the portal backend
- The PA session cookie covers any page served under `portal-external.localhost`
- The user logs in via the portal (or is redirected to PF OIDC) before using the app
- No new API routes, no new auth mechanism, no PA config changes

### Flow Diagram

```
iOS Simulator (Safari / Add to Home Screen)
  → https://portal-external.localhost/mobile     (public static files, served by Express)
  → User has existing PA session cookie from portal login
  → polls GET /app/ciba/pending                   (PA-protected, session cookie)
  → posts POST /app/ciba/action                   (PA-protected, session cookie)
```

### CIBA Flow (end-to-end)

```
1. Agent calls MCP tool → 403 insufficient_scope
2. Authn sidecar → POST /as/bc-auth.ciba (PingFederate)
3. PF webhook plugin → POST /api/ciba/initiate (portal internal)
4. Portal stores request in in-memory Map
5. Both UIs poll simultaneously:
   - Portal chat: GET /app/ciba/pending (3s interval)
   - Mobile PWA:  GET /app/ciba/pending (3s interval)
6. User approves from EITHER UI → POST /app/ciba/action
7. PF polls GET /api/ciba/status/:id → APPROVED
8. PF issues CIBA token → sidecar retries MCP call → success
```

## Branding

| Element | Value |
|---------|-------|
| App name | **Authenticator App** |
| Title | `Acme Corp - Authenticator` |
| Primary color | `indigo-600` (`#4f46e5`) |
| Gradient | `linear-gradient(135deg, #667eea, #764ba2)` |
| Icon | Same indigo building SVG as portal favicon |
| Libraries | Tailwind CSS (CDN), Font Awesome 6.4 (CDN) |
| Consent card style | Amber-50 bg, amber-200 border, shield icon, tool details table — matches `addCibaConsentCard()` in `js/chat.js` |

## Files to Create

### `acp-workforce-portal/mobile/index.html`

Single-page PWA shell:
- iOS meta tags: `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style: black-translucent`, `viewport-fit=cover`
- Tailwind CSS CDN + Font Awesome 6.4 CDN (same versions as portal)
- Nav bar: indigo building icon + "Acme Corp" wordmark (identical to portal)
- App header: "Authenticator App"
- Idle state: "No pending requests" with subtle shield icon animation
- Consent card container (populated by app.js)
- PWA manifest link + service worker registration

### `acp-workforce-portal/mobile/manifest.json`

```json
{
  "name": "Acme Corp Authenticator",
  "short_name": "Authenticator",
  "display": "standalone",
  "start_url": "/mobile/",
  "scope": "/mobile/",
  "theme_color": "#4f46e5",
  "background_color": "#f3f4f6",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

### `acp-workforce-portal/mobile/sw.js`

Minimal service worker:
- Cache app shell (index.html, CSS, JS) for offline startup
- Network-first strategy for API calls (`/app/ciba/*`)

### `acp-workforce-portal/mobile/app.js`

Core application logic:
- 3-second polling loop: `GET /app/ciba/pending` with `credentials: 'same-origin'`
- Renders consent cards matching portal's amber style exactly
- Approve/Deny handlers: `POST /app/ciba/action` with `credentials: 'same-origin'`
- On action: card animates out, green/red toast confirmation
- Web Audio API chime on new request arrival (requires user gesture to unlock)
- Connection status indicator (online/offline)

### `acp-workforce-portal/mobile/icon-192.png` / `icon-512.png`

Generated from the same indigo building SVG used as the portal favicon.

## Files to Modify

### `acp-workforce-portal/server.js`

Add 1 line to serve the mobile PWA as a public static directory:

```javascript
// Serve mobile PWA (public — PA session required for API calls, not static files)
app.use('/mobile', express.static(join(__dirname, 'mobile')));
```

This goes in the PUBLIC zone (alongside `/` landing page serving).

## What Does NOT Change

- PF webhook plugin config (still POSTs to portal at `/api/ciba/initiate`)
- Portal's existing `/api/ciba/*` and `/app/ciba/*` routes (untouched)
- PingAccess configuration (no new apps, sites, or virtual hosts)
- k3d deployment manifests (portal image just gains new static files)
- Sidecar/gateway CIBA flow
- Dockerfile (static files are included via existing `COPY . .`)

## UX Flow on iOS Simulator

### First launch (Safari)

1. User navigates to `https://portal-external.localhost/mobile`
2. If no PA session: redirected to PF login → returns to `/mobile` after OIDC
3. Sees Acme Corp branded idle screen: "No pending requests"

### On CIBA request

1. Card slides in — identical amber style to portal consent cards
2. Shows: "Agent Authorization Request" header, CIBA badge, tool name, target server, arguments table
3. Large **Allow** (green) / **Deny** (red) buttons — full-width, thumb-friendly
4. On tap: card animates out, brief toast confirmation

### Add to Home Screen

1. Safari Share → "Add to Home Screen"
2. App name: "Authenticator" (from `short_name`)
3. Launches in standalone mode (no browser chrome)
4. Indigo status bar, safe area insets for notch

## iOS PWA Considerations

- Background polling pauses when app is backgrounded (expected iOS behavior)
- Web Audio chime requires user gesture to unlock AudioContext
- Service worker requires HTTPS — platform CA must be trusted in simulator
- `viewport-fit=cover` + `env(safe-area-inset-*)` for notch handling

## Testing

1. Trigger a CIBA flow from the portal chat (e.g., "submit expense EXP-2026-001237")
2. Verify the consent card appears on **both** the portal chat AND the mobile PWA simultaneously
3. Approve from the mobile PWA — verify portal chat sees the request disappear
4. Approve from the portal chat — verify mobile PWA sees the request disappear
5. Deny from the mobile PWA — verify the CIBA flow returns `access_denied`
6. Verify the 30s TTL expiration cleans up stale requests on both UIs

## Review Notes

Plan was reviewed by `acp-reviewer`. Key findings and resolutions:

1. **Routing**: Original plan used `/api/ciba/mobile/*` which would be misrouted by PA (PA sends `/api/*` to the AI agent). Resolved by reusing existing `/app/ciba/*` endpoints.
2. **Auth**: Original plan used a shared Bearer token. Resolved by using the existing PA session cookie — same auth model as the portal chat.
3. **Cross-user visibility**: `getPendingRequests()` returns all users' pending requests; filtering happens client-side. This is inherited behavior from the existing portal — not a new risk. Server-side scoping would be a separate enhancement.
