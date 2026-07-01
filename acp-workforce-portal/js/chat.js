/**
 * Chat Module for Workforce Assistant
 *
 * Handles communication with the Workforce AI Agent backend via the AG-UI
 * SSE protocol. The browser posts to /api/agent/run (proxied by PingAccess,
 * which injects the PA-signed JWT) and receives a stream of typed AG-UI events.
 *
 * Authentication is handled by PingAccess (BFF pattern):
 *   - PA session cookie is sent automatically (same-origin, credentials: 'same-origin')
 *   - PA injects the user's access_token into the upstream request to the agent
 *   - No manual Authorization header needed from the browser
 *
 * Response flow:
 *   1. agentClient.runAgent(message, threadId, callbacks)
 *   2. Callbacks stream TEXT_MESSAGE_CONTENT deltas and STATE_SNAPSHOT/STATE_DELTA
 *   3. Chat UI updated incrementally; final state rendered on RUN_FINISHED
 */

// ─────────────────────────────────────────────────────────────────────────────
// MCP App (iframe) Support
// Renders interactive MCP App UIs using the sandbox proxy pattern and manages
// the postMessage JSON-RPC bridge (host side) per the MCP Apps specification
// (2026-01-26). See: https://github.com/modelcontextprotocol/ext-apps
//
// Architecture:
//   Host ↔ Sandbox Proxy (srcdoc iframe, allow-scripts allow-same-origin)
//                ↔ Inner View (srcdoc iframe with CSP, allow-scripts only)
//
// The Sandbox Proxy has a different origin from the host (enforced by sandbox).
// It loads the View HTML into an inner iframe and forwards postMessage between
// the Host and the View (except sandbox-* messages).
//
// Protocol sequence (per spec):
//   1. Host creates sandbox iframe (proxy HTML)
//   2. Sandbox sends ui/notifications/sandbox-proxy-ready
//   3. Host sends ui/notifications/sandbox-resource-ready with HTML
//   4. Sandbox creates inner iframe with the View HTML + CSP
//   5. View sends ui/initialize (request) → Host responds with McpUiInitializeResult
//   6. View sends ui/notifications/initialized
//   7. Host sends ui/notifications/tool-input (tool arguments)
//   8. Host sends ui/notifications/tool-result (full CallToolResult)
//   9. View may send ui/notifications/size-changed → Host resizes iframe
// ─────────────────────────────────────────────────────────────────────────────

let _mcpAppCounter = 0;
const _pendingMcpApps = []; // { iframeId, toolResult, toolArguments, resourceUri }

// ─── AG-UI conversation state ────────────────────────────────────────────────
let _threadId = crypto.randomUUID();

function getThreadId() { return _threadId; }

/**
 * Render a full-width conversation boundary in the chat log. This is the
 * canonical "this thread ended, a new one began" marker — NOT a chat bubble.
 * Shows the agent label and the full new threadId (read-only here; the
 * copyable surface is the header chip).
 *
 * @param {{ label: string, threadId: string }} args
 */
function renderConversationBoundary({ label, threadId }) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;
    const sep = document.createElement('div');
    sep.setAttribute('role', 'separator');
    sep.setAttribute('aria-label', 'New conversation');
    sep.className = 'flex flex-col items-center gap-1 py-2';
    sep.innerHTML = `
        <div class="flex items-center gap-3 w-full">
            <hr class="flex-1 border-t border-indigo-200">
            <span class="text-xs uppercase tracking-wide text-gray-400 whitespace-nowrap">New conversation · ${escapeHtml(label)}</span>
            <hr class="flex-1 border-t border-indigo-200">
        </div>
        <span class="font-mono text-xs text-gray-400 break-all">${escapeHtml(threadId)}</span>
    `;
    chatMessages.appendChild(sep);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Start a genuinely new conversation. Rotates the threadId so the next run
 * propagates a fresh `session.id` baggage value (re-stamped by
 * agentClient.runAgent) into every backend span, tears down any in-flight
 * stream, resets render state, updates the header chip, and draws a visible
 * boundary in the chat log. Single source of truth for both `/new` and
 * agent-switch — keep all reset logic here so the two paths cannot drift.
 *
 * @param {{ agentLabel: string }} args
 */
function startNewConversation({ agentLabel }) {
    // Tear down any live SSE stream first so its events can't bleed past the
    // boundary attributed to the new thread.
    if (typeof agentClient !== 'undefined' && agentClient.abortRun) {
        agentClient.abortRun();
    }
    _threadId = crypto.randomUUID();
    resetRenderedResults();
    // Unconditional: a missing updateSessionStatus is a load-order bug we want
    // surfaced, not silently swallowed behind a typeof guard.
    updateSessionStatus('initialized', _threadId);
    renderConversationBoundary({ label: agentLabel, threadId: _threadId });
    window.dispatchEvent(new CustomEvent('agui:session-reset'));
}

/**
 * Reset the conversation thread when the user switches active agents.
 * Thin wrapper over startNewConversation (the unified reset routine).
 */
function resetThreadForAgentSwitch(newAgentLabel) {
    startNewConversation({ agentLabel: newAgentLabel });
}
let _activeStreamBubble = null;  // { messageId, p } — current streaming text element
let _toolProgressDiv = null;     // ephemeral "Calling X..." indicator
let _renderedResultCount = 0;    // how many state.results have been rendered
let _runIndicatorRemoved = false;
let _lastRenderedError = null;   // deduplicate authorization error cards

/**
 * Reset the per-TURN/thread card high-water mark. Call this ONLY at the start
 * of a genuinely new turn (fresh runAgent, where agentClient resets
 * _currentState to {results:[]} with no echo) and on thread rotation. Do NOT
 * call it before a resume run: the resume echoes the accumulated results[]
 * back, so a zeroed mark would re-render every prior card (the duplicate-card
 * bug). Kept module-scope (not inside resetRunState) precisely to keep that
 * per-run vs per-turn distinction enforceable from both call sites.
 */
function resetRenderedResults() { _renderedResultCount = 0; }

/**
 * Escape a string for use in an HTML attribute (double-quoted).
 */
function escapeAttr(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Generate the sandbox proxy HTML.
 *
 * The sandbox proxy is loaded into the outer iframe (which has sandbox
 * "allow-scripts allow-same-origin" — giving it a different origin from the
 * host page). It:
 *   1. Sends ui/notifications/sandbox-proxy-ready to the host
 *   2. Waits for ui/notifications/sandbox-resource-ready with the View HTML
 *   3. Creates an inner iframe with the View HTML and appropriate CSP
 *   4. Forwards all non-sandbox-* messages between Host and View
 */
function buildSandboxProxyHtml() {
    return `<!DOCTYPE html>
<html style="height:100%;margin:0;padding:0;"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;overflow:hidden;height:100%;">
<script>
(function() {
    var innerFrame = null;

    // Forward messages between host and inner view
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (!msg || typeof msg !== 'object' || !msg.jsonrpc) return;

        // From Host (parent) → forward to inner View
        if (event.source === window.parent) {
            console.log('[SandboxProxy] From Host:', msg.method || ('response:' + msg.id) || 'unknown');
            // Intercept sandbox-resource-ready to create the inner iframe
            if (msg.method === 'ui/notifications/sandbox-resource-ready') {
                console.log('[SandboxProxy] Creating inner frame, html length:', (msg.params && msg.params.html) ? msg.params.html.length : 0);
                createInnerFrame(msg.params);
                return;
            }
            // Forward all other messages to the inner view
            if (innerFrame && innerFrame.contentWindow) {
                console.log('[SandboxProxy] Forwarding to inner view:', msg.method || ('response:' + msg.id));
                innerFrame.contentWindow.postMessage(msg, '*');
            } else {
                console.warn('[SandboxProxy] Cannot forward — innerFrame not ready');
            }
            return;
        }

        // From inner View → forward to Host (except sandbox-* messages)
        if (innerFrame && event.source === innerFrame.contentWindow) {
            if (typeof msg.method === 'string' && msg.method.startsWith('ui/notifications/sandbox-')) {
                return; // Block sandbox-* from reaching host
            }
            // Intercept size-changed to resize the inner iframe within the sandbox
            if (msg.method === 'ui/notifications/size-changed' && msg.params && msg.params.height > 0) {
                innerFrame.style.height = msg.params.height + 'px';
                console.log('[SandboxProxy] Resized inner frame to', msg.params.height, 'px');
            }
            console.log('[SandboxProxy] From View to Host:', msg.method || ('response:' + msg.id));
            window.parent.postMessage(msg, '*');
            return;
        }
    });

    function createInnerFrame(params) {
        var html = params.html || '';
        var csp = params.csp || {};

        // Build CSP meta tag
        var cspParts = [
            "default-src 'none'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "media-src 'self' data:",
            "object-src 'none'"
        ];
        if (csp.connectDomains && csp.connectDomains.length) {
            cspParts.push("connect-src " + csp.connectDomains.join(" "));
        } else {
            cspParts.push("connect-src 'none'");
        }
        if (csp.resourceDomains && csp.resourceDomains.length) {
            var rd = csp.resourceDomains.join(" ");
            cspParts[1] = "script-src 'self' 'unsafe-inline' " + rd;
            cspParts[2] = "style-src 'self' 'unsafe-inline' " + rd;
            cspParts[3] = "img-src 'self' data: " + rd;
            cspParts.push("font-src 'self' " + rd);
        }
        if (csp.frameDomains && csp.frameDomains.length) {
            cspParts.push("frame-src " + csp.frameDomains.join(" "));
        } else {
            cspParts.push("frame-src 'none'");
        }
        if (csp.baseUriDomains && csp.baseUriDomains.length) {
            cspParts.push("base-uri " + csp.baseUriDomains.join(" "));
        } else {
            cspParts.push("base-uri 'self'");
        }

        innerFrame = document.createElement('iframe');
        innerFrame.sandbox = 'allow-scripts';
        innerFrame.style.cssText = 'width:100%;height:100%;border:none;min-height:80px;display:block;';
        // Inject CSP meta tag into the HTML head
        var cspMeta = '<meta http-equiv="Content-Security-Policy" content="' + cspParts.join("; ") + '">';
        var injectedHtml = html.replace(/<head([^>]*)>/i, '<head$1>' + cspMeta);
        innerFrame.srcdoc = injectedHtml;
        document.body.appendChild(innerFrame);
    }

    // Signal that the sandbox proxy is ready
    window.parent.postMessage({
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-proxy-ready',
        params: {}
    }, '*');
})();
</script>
</body></html>`;
}

/**
 * Set up the MCP App postMessage bridge for a pending iframe.
 * Called after the sandbox iframe element is in the DOM.
 *
 * The protocol (per MCP Apps spec 2026-01-26):
 *   1. Sandbox sends ui/notifications/sandbox-proxy-ready
 *   2. Host sends ui/notifications/sandbox-resource-ready (View HTML)
 *   3. View (inside sandbox) sends ui/initialize (JSON-RPC request)
 *   4. Host responds with McpUiInitializeResult
 *   5. View sends ui/notifications/initialized
 *   6. Host sends ui/notifications/tool-input (tool arguments)
 *   7. Host sends ui/notifications/tool-result (full CallToolResult)
 *   8. View may send ui/notifications/size-changed → Host resizes iframe
 */
function setupMcpAppBridge(iframeId, toolResult, toolArguments) {
    const iframe = document.getElementById(iframeId);
    if (!iframe) return;

    let viewInitialized = false;
    let sandboxReady = false;
    let pendingResourceHtml = null;

    function handleMessage(event) {
        // Only accept messages from the sandbox iframe
        if (event.source !== iframe.contentWindow) return;

        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;

        console.log(`[MCPApp:bridge:${iframeId}] Received:`, msg.method || (msg.id ? `response:${msg.id}` : 'unknown'), JSON.stringify(msg).substring(0, 200));

        // ui/notifications/sandbox-proxy-ready — sandbox is ready, send the View HTML
        if (msg.method === 'ui/notifications/sandbox-proxy-ready') {
            sandboxReady = true;
            console.log(`[MCPApp:bridge:${iframeId}] Sandbox ready, pendingResourceHtml=${pendingResourceHtml !== null ? pendingResourceHtml.length + ' chars' : 'null'}`);
            if (pendingResourceHtml !== null) {
                iframe.contentWindow.postMessage({
                    jsonrpc: '2.0',
                    method: 'ui/notifications/sandbox-resource-ready',
                    params: {
                        html: pendingResourceHtml,
                        csp: {} // Default restrictive CSP
                    }
                }, '*');
                pendingResourceHtml = null;
            }
            return;
        }

        // ui/initialize — respond with full McpUiInitializeResult
        if (msg.method === 'ui/initialize') {
            iframe.contentWindow.postMessage({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                    protocolVersion: '2026-01-26',
                    hostCapabilities: {
                        logging: {},
                        serverTools: {},
                        serverResources: {}
                    },
                    hostInfo: {
                        name: 'workforce-portal',
                        version: '1.0.0'
                    },
                    hostContext: {
                        theme: 'light',
                        displayMode: 'inline',
                        containerDimensions: {
                            maxWidth: 800,
                            maxHeight: 600
                        },
                        platform: 'web'
                    }
                }
            }, '*');
            return;
        }

        // ui/notifications/initialized — View is ready, send tool-input then tool-result
        if (msg.method === 'ui/notifications/initialized') {
            viewInitialized = true;
            console.log(`[MCPApp:bridge:${iframeId}] View initialized! Sending tool-input and tool-result`);
            console.log(`[MCPApp:bridge:${iframeId}] toolResult keys:`, Object.keys(toolResult || {}));
            console.log(`[MCPApp:bridge:${iframeId}] structuredContent:`, JSON.stringify(toolResult?.structuredContent)?.substring(0, 300));

            // Per spec: MUST send tool-input before tool-result
            if (toolArguments) {
                iframe.contentWindow.postMessage({
                    jsonrpc: '2.0',
                    method: 'ui/notifications/tool-input',
                    params: {
                        arguments: toolArguments
                    }
                }, '*');
            }

            // Send tool-result with the full CallToolResult as-is (Gap 1 fix)
            iframe.contentWindow.postMessage({
                jsonrpc: '2.0',
                method: 'ui/notifications/tool-result',
                params: toolResult
            }, '*');
            return;
        }

        // ui/notifications/size-changed — auto-resize iframe
        if (msg.method === 'ui/notifications/size-changed') {
            const height = msg.params?.height;
            if (height && typeof height === 'number' && height > 0) {
                iframe.style.height = Math.min(height + 2, 800) + 'px';
            }
            return;
        }

        // ui/open-link — open external URL in new tab
        if (msg.method === 'ui/open-link' && msg.params?.url) {
            try {
                window.open(msg.params.url, '_blank', 'noopener,noreferrer');
                iframe.contentWindow.postMessage({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {}
                }, '*');
            } catch (e) {
                iframe.contentWindow.postMessage({
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: { code: -32000, message: 'Failed to open link' }
                }, '*');
            }
            return;
        }

        // notifications/message — log messages from the View
        if (msg.method === 'notifications/message') {
            const level = msg.params?.level || 'info';
            const text = msg.params?.data || msg.params?.message || '';
            console[level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'log'](
                `[MCPApp:${iframeId}]`, text
            );
            return;
        }
    }

    window.addEventListener('message', handleMessage);

    /**
     * Load the View HTML into the sandbox.
     * Called asynchronously after the HTML is fetched via resources/read.
     */
    iframe._loadViewHtml = function(html) {
        if (sandboxReady) {
            iframe.contentWindow.postMessage({
                jsonrpc: '2.0',
                method: 'ui/notifications/sandbox-resource-ready',
                params: {
                    html: html,
                    csp: {}
                }
            }, '*');
        } else {
            // Sandbox not ready yet — queue the HTML for when it is
            pendingResourceHtml = html;
        }
    };

    // Fallback: if the handshake hasn't completed in 3 seconds, something went wrong
    setTimeout(() => {
        if (!viewInitialized && iframe.contentWindow) {
            console.warn(`[MCPApp:${iframeId}] View initialization timeout — sending tool-result anyway`);
            try {
                if (toolArguments) {
                    iframe.contentWindow.postMessage({
                        jsonrpc: '2.0',
                        method: 'ui/notifications/tool-input',
                        params: { arguments: toolArguments }
                    }, '*');
                }
                iframe.contentWindow.postMessage({
                    jsonrpc: '2.0',
                    method: 'ui/notifications/tool-result',
                    params: toolResult
                }, '*');
            } catch (e) { /* iframe may have been removed */ }
        }
    }, 3000);
}

/**
 * Flush any pending MCP App iframe bridges.
 * Should be called after new chat DOM content is appended.
 *
 * For each pending app:
 *   1. Set up the bridge (handles sandbox-proxy-ready, ui/initialize, etc.)
 *   2. Fetch the MCP App HTML via resources/read
 *   3. Load the HTML into the sandbox iframe
 */
function flushPendingMcpApps() {
    while (_pendingMcpApps.length > 0) {
        const { iframeId, toolResult, toolArguments, resourceUri } = _pendingMcpApps.shift();
        setupMcpAppBridge(iframeId, toolResult, toolArguments);

        // Fetch the MCP App HTML asynchronously via agent resource proxy
        if (resourceUri) {
            console.log(`[MCPApp:flush:${iframeId}] Fetching resource: ${resourceUri}`);
            agentClient.readResource(resourceUri)
                .then(result => {
                    console.log(`[MCPApp:flush:${iframeId}] readResource returned:`, JSON.stringify(result)?.substring(0, 200));
                    const contents = result?.contents || [];
                    const htmlItem = contents.find(c => c.mimeType?.startsWith('text/html'));
                    const html = htmlItem?.text || (contents[0] && contents[0].text);
                    console.log(`[MCPApp:flush:${iframeId}] HTML found=${!!html}, length=${html?.length ?? 0}`);
                    if (html) {
                        const iframe = document.getElementById(iframeId);
                        if (iframe && iframe._loadViewHtml) {
                            iframe._loadViewHtml(html);
                        }
                    } else {
                        console.error(`[MCPApp:${iframeId}] No HTML content in resources/read response`);
                    }
                })
                .catch(err => {
                    console.error(`[MCPApp:${iframeId}] Failed to fetch MCP App resource:`, err);
                });
        }
    }
}

/**
 * Send a chat message to the agent via AG-UI SSE transport.
 *
 * Returns { _agui: true, traceId, finalState } on success.
 * Special cases (/new, /reset) return early with a synthetic shape.
 */
async function sendChatMessage(message) {
    // /new — reset conversation thread (same routine as agent-switch)
    if (message.trim().toLowerCase() === '/new') {
        const activeKey = (typeof agentClient !== 'undefined' && agentClient.getCurrentAgent)
            ? agentClient.getCurrentAgent()
            : (CONFIG && CONFIG.defaultAgent);
        const label = (CONFIG.agents && CONFIG.agents[activeKey] && CONFIG.agents[activeKey].label) || 'Assistant';
        startNewConversation({ agentLabel: label });
        return {
            _agui: true,
            traceId: null,
            finalState: { results: [], error: null }
        };
    }

    // /reset — reset demo data directly
    if (message.trim().toLowerCase() === '/reset') {
        const res = await fetch('/workforce-portal/reset', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        const text = res.ok
            ? 'Demo data reset successfully (' + data.count + ' expenses restored).'
            : (data.error || 'Reset failed (' + res.status + ')');
        addAssistantMessage(text, !res.ok);
        return { _agui: true, traceId: null, finalState: null };
    }

    const buildCallbacks = () => ({
        onRunStarted: () => {
            _removeIndicatorOnce();
        },
        onStepStarted: ({ stepName }) => {
            _removeIndicatorOnce();
            if (stepName && stepName.startsWith('call ')) {
                _showToolProgress(stepName.slice(5), 'calling');
            }
        },
        onStepFinished: ({ stepName }) => {
            if (stepName && stepName.startsWith('call ') && _toolProgressDiv) {
                const label = _toolProgressDiv.querySelector('.tool-progress-label');
                if (label) label.textContent = 'Called ' + stepName.slice(5) + ' ✓';
            }
        },
        onTextMessageStart: ({ messageId }) => {
            _removeIndicatorOnce();
            if (_synthesisIndicatorEl) { _synthesisIndicatorEl.remove(); _synthesisIndicatorEl = null; }
            _startStreamBubble(messageId);
        },
        onTextMessageContent: ({ messageId, delta }) => {
            _appendStreamDelta(messageId, delta);
        },
        onTextMessageEnd: ({ messageId }) => {
            _finalizeStreamBubble(messageId);
        },
        onToolCallStart: ({ toolName }) => {
            _removeIndicatorOnce();
            _showToolProgress(toolName, 'calling');
        },
        onToolCallEnd: () => {
            // step handler updates label
        },
        onToolCallResult: ({ result: resultJson }) => {
            let parsed;
            try { parsed = typeof resultJson === 'string' ? JSON.parse(resultJson) : resultJson; }
            catch { return; }
            if (!parsed.isError) return;
            const html = formatCallToolResult(parsed);
            if (!html) return;
            const chatMessages = document.getElementById('chat-messages');
            const div = document.createElement('div');
            div.className = 'flex items-start space-x-3';
            div.innerHTML = '<div class="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">' +
                '<i class="fa-solid fa-robot text-indigo-600"></i>' +
                '</div>' +
                '<div class="bg-gray-100 rounded-lg p-3 max-w-[80%]">' + html + '</div>';
            chatMessages.appendChild(div);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        },
        onStateSnapshot: ({ snapshot }) => {
            _renderStateResults(snapshot);
            _handleStateError(snapshot);
        },
        onStateDelta: ({ state }) => {
            _renderStateResults(state);
            _handleStateError(state);
        },
        onCustomEvent: ({ name, value }) => {
            _handleCustomEvent(name, value);
        },
        onRunFinished: () => {
            if (_toolProgressDiv) { _toolProgressDiv.remove(); _toolProgressDiv = null; }
            if (_synthesisIndicatorEl) { _synthesisIndicatorEl.remove(); _synthesisIndicatorEl = null; }
            // Safety net: never let a "Deciding…" spinner outlive the run.
            _collapseDelegationCardIfUndecided();
        },
        onRunError: ({ message: errMsg }) => {
            if (_toolProgressDiv) { _toolProgressDiv.remove(); _toolProgressDiv = null; }
            if (_synthesisIndicatorEl) { _synthesisIndicatorEl.remove(); _synthesisIndicatorEl = null; }
            _collapseDelegationCardIfUndecided();
            addAssistantMessage(errMsg || 'Agent run failed', true);
        },
    });

    // Reset per-RUN UI state. Runs before the first run AND before each
    // interrupt-resume run — these elements (streaming bubble, tool spinner,
    // delegation card) belong to a single run and must not bleed across the
    // interrupt boundary. NOTE: _renderedResultCount is deliberately NOT reset
    // here — it is per-TURN/thread, not per-run (see below).
    const resetRunState = () => {
        _runIndicatorRemoved = false;
        _activeStreamBubble = null;
        _resetDelegationCard();
        if (_toolProgressDiv) { _toolProgressDiv.remove(); _toolProgressDiv = null; }
    };

    // Per-TURN reset (see resetRenderedResults): NOT called before resume runs.
    resetRenderedResults();

    resetRunState();
    let runResult = await agentClient.runAgent(message, _threadId, buildCallbacks());

    // Drive interrupt outcomes. Each interrupt is rendered via the existing
    // elicitation card, then the user's response is fed back via a follow-up
    // run carrying `resume: [...]`. Loop because the follow-up may yield
    // another interrupt (e.g. gather-args → confirm-destructive).
    let safety = 8;
    while (
        runResult && runResult.outcome &&
        runResult.outcome.type === 'interrupt' &&
        Array.isArray(runResult.outcome.interrupts) &&
        runResult.outcome.interrupts.length > 0 &&
        safety-- > 0
    ) {
        const resumeEntries = await _resolveInterruptsViaElicitation(runResult.outcome.interrupts);
        // If every interrupt was cancelled/declined, stop — the agent already
        // emitted a decline marker on the prior run.
        if (!resumeEntries.some(e => e.status === 'resolved')) break;
        // Per-RUN reset only — NOT _renderedResultCount. The resume run echoes
        // the accumulated results[] back; preserving the high-water mark means
        // already-rendered cards are skipped and only new entries draw.
        resetRunState();
        runResult = await agentClient.runAgent(null, _threadId, buildCallbacks(), { resume: resumeEntries });
    }

    return runResult;
}

/**
 * Render each interrupt via the existing elicitation card and collect resume
 * entries. Returns `[{ interruptId, status, payload? }]` shaped for the AG-UI
 * RunAgentInput.resume[] field.
 */
async function _resolveInterruptsViaElicitation(interrupts) {
    const out = [];
    for (const interrupt of interrupts) {
        const meta = interrupt.metadata || {};
        // For URL-mode elicitations, the postMessage filter must match the
        // MCP server's elicitation_id (echoed back by its OAuth callback) —
        // not the AG-UI interrupt.id, which is a separate UUID generated by
        // the agent. Form-mode elicitations don't use postMessage, so the
        // AG-UI id is fine as a fallback.
        const filterId = meta.mcpElicitationId || interrupt.id;
        // gather-args interrupts (Trip Planner slot-gather) render the blue
        // "Additional Information Needed" card; everything else defaults to the
        // amber confirmation card. The renderer keys off _meta.elicitationType.
        const isGatherArgs = meta.elicitationType === 'gather-args';
        const defaultServer = isGatherArgs
            ? { name: 'Trip Planner Agent' }
            : { name: 'workforce-ai-agent' };
        const params = {
            mode: meta.mode || (meta.url ? 'url' : 'form'),
            message: interrupt.message || '',
            url: meta.url || null,
            requestedSchema: meta.schema || interrupt.responseSchema || null,
            elicitationId: filterId,
            _meta: {
                requestingServer: meta.requestingServer || defaultServer,
                elicitationType: meta.elicitationType,
            },
        };
        let result;
        try {
            result = await elicitation.handle(params);
        } catch (err) {
            console.error('[AgentClient] elicitation.handle failed:', err);
            result = { action: 'cancel' };
        }
        const status = result.action === 'accept' ? 'resolved' : 'cancelled';
        const entry = { interruptId: interrupt.id, status };
        if (status === 'resolved' && result.content) entry.payload = result.content;
        out.push(entry);
    }
    return out;
}

// ─── AG-UI streaming helpers ─────────────────────────────────────────────────

function _removeIndicatorOnce() {
    if (_runIndicatorRemoved) return;
    _runIndicatorRemoved = true;
    removeTypingIndicator();
}

function _showToolProgress(toolName, phase) {
    if (!_toolProgressDiv) {
        const chatMessages = document.getElementById('chat-messages');
        _toolProgressDiv = document.createElement('div');
        _toolProgressDiv.className = 'flex items-start space-x-3 ml-11';
        chatMessages.appendChild(_toolProgressDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    _toolProgressDiv.innerHTML = '<span class="tool-progress-label text-xs text-gray-500 italic">' +
        (phase === 'calling' ? 'Calling' : 'Called') + ' ' + escapeHtml(toolName) +
        (phase === 'calling' ? '...' : ' ✓') + '</span>';
}

function _startStreamBubble(messageId) {
    const chatMessages = document.getElementById('chat-messages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'flex items-start space-x-3';
    messageDiv.id = 'stream-msg-' + messageId;
    messageDiv.innerHTML = '<div class="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">' +
        '<i class="fa-solid fa-robot text-indigo-600"></i>' +
        '</div>' +
        '<div class="bg-gray-100 rounded-lg p-3 max-w-[80%]">' +
        '<p id="stream-bubble-' + messageId + '" class="text-gray-800 whitespace-pre-wrap"></p>' +
        '</div>';
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    _activeStreamBubble = {
        messageId,
        p: document.getElementById('stream-bubble-' + messageId),
        raw: '',
    };
}

function _appendStreamDelta(messageId, delta) {
    if (_activeStreamBubble && _activeStreamBubble.messageId === messageId && _activeStreamBubble.p) {
        _activeStreamBubble.raw += delta;
        _activeStreamBubble.p.appendChild(document.createTextNode(delta));
        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

// Section heading → icon map for trip summary cards.
// Keys are lowercase words matched anywhere in a heading line.
const _TRIP_SECTION_ICONS = {
    weather:   'fa-cloud-sun',
    flight:    'fa-plane',
    flights:   'fa-plane',
    hotel:     'fa-hotel',
    hotels:    'fa-hotel',
    packing:   'fa-suitcase-rolling',
    tip:       'fa-suitcase-rolling',
    tips:      'fa-suitcase-rolling',
    summary:   'fa-map-location-dot',
    itinerary: 'fa-map-location-dot',
    transport: 'fa-train',
    train:     'fa-train',
};

function _iconForHeading(text) {
    const lower = text.toLowerCase();
    for (const [word, icon] of Object.entries(_TRIP_SECTION_ICONS)) {
        if (lower.includes(word)) return icon;
    }
    return 'fa-circle-dot';
}

/**
 * Post-process a rendered prose container: replace <h1>–<h3> headings with
 * icon-prefixed rows that match the delegation card style.
 */
function _injectSectionIcons(container) {
    container.querySelectorAll('h1, h2, h3').forEach(h => {
        const text = h.textContent.trim();
        const icon = _iconForHeading(text);
        const isSummary = /summary|itinerary/i.test(text);

        if (isSummary) {
            // Top-level header — already rendered in card chrome; suppress the <h>
            h.remove();
        } else {
            const div = document.createElement('div');
            div.className = 'flex items-center gap-2 mt-3 mb-1';
            div.innerHTML =
                `<i class="fa-solid ${icon} text-indigo-400 w-4 text-center flex-shrink-0"></i>` +
                `<span class="font-semibold text-gray-700 text-sm">${escapeHtml(text)}</span>`;
            h.replaceWith(div);
        }
    });
}

function _finalizeStreamBubble(messageId) {
    if (!_activeStreamBubble || _activeStreamBubble.messageId !== messageId) return;
    const { p, raw } = _activeStreamBubble;
    _activeStreamBubble = null;

    if (!p || !raw || typeof marked === 'undefined') return;

    const hasMarkdown = /#{1,6} |[*_`]|\n[-*] /.test(raw);
    const isTripTurn  = _delegationCardEl !== null;  // set by a2a.delegation.plan earlier this turn

    if (hasMarkdown && isTripTurn) {
        // Replace the entire message bubble with a styled trip summary card
        // that mirrors the delegation card chrome.
        const outerRow = p.closest('.flex.items-start') || p.closest('[id^="stream-msg-"]');
        if (!outerRow) return;

        const prose = document.createElement('div');
        prose.className = 'prose-trip text-gray-800 text-sm leading-relaxed';
        prose.innerHTML = marked.parse(raw, { breaks: true, gfm: true });
        _injectSectionIcons(prose);

        const card = document.createElement('div');
        card.className = 'flex items-start space-x-3';
        card.innerHTML =
            '<div class="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">' +
            '<i class="fa-solid fa-robot text-indigo-600"></i>' +
            '</div>' +
            '<div class="bg-gray-100 rounded-lg p-3 w-80">' +
            '<p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">' +
            '<i class="fa-solid fa-map-location-dot mr-1 text-indigo-400"></i>Trip Summary' +
            '</p>' +
            '<hr class="border-gray-200 mb-2">' +
            '</div>';

        card.querySelector('.bg-gray-100').appendChild(prose);
        outerRow.replaceWith(card);

    } else if (hasMarkdown) {
        // Workforce agent or non-trip markdown — plain prose render
        const wrapper = p.closest('.bg-gray-100') || p.parentElement;
        if (wrapper) {
            const prose = document.createElement('div');
            prose.className = 'prose prose-sm max-w-none text-gray-800';
            prose.innerHTML = marked.parse(raw, { breaks: true, gfm: true });
            wrapper.replaceChild(prose, p);
        }
    }
}

function _renderStateResults(state) {
    if (!state || !Array.isArray(state.results)) return;
    const results = state.results;
    while (_renderedResultCount < results.length) {
        const entry = results[_renderedResultCount];
        _renderedResultCount++;
        _renderResultEntry(entry);
    }
}

function _renderResultEntry(entry) {
    if (!entry || !entry.data) return;
    const data = entry.data;
    // Skip pure text results — those are rendered via text streaming
    if (entry.view === 'text') return;

    // Build a synthetic result object compatible with formatCallToolResult.
    // The view name (e.g. 'expense_list') lives on entry.view; renderStructuredContent
    // dispatches on structuredContent.type, so propagate the view if the raw tool
    // payload didn't already supply one.
    // data.toolResult: MCP tool result shape (workforce-ai-agent)
    // plain data object: Trip Planner STATE_DELTA shape — spread it directly
    const structuredContent = data.toolResult
        ? Object.assign({}, data.toolResult)
        : Object.assign({}, data);
    if (!structuredContent.type && entry.view) {
        structuredContent.type = entry.view;
    }
    const syntheticResult = {
        content: data.message ? [{ type: 'text', text: data.message }] : [],
        structuredContent,
        isError: false,
        _toolArguments: {},
        _meta: (data.toolResult && data.toolResult._meta)
            ? data.toolResult._meta
            : (data.mcpApp?.resourceUri
                ? { ui: { resourceUri: data.mcpApp.resourceUri } }
                : null),
    };

    const pendingBefore = _pendingMcpApps.length;
    const content = formatCallToolResult(syntheticResult);
    if (!content) return;

    const hasMcpApp = _pendingMcpApps.length > pendingBefore;
    const hasStructuredContent = Object.keys(syntheticResult.structuredContent).length > 0;
    const widthClass = (hasMcpApp || hasStructuredContent) ? 'w-1/2 max-w-[80%]' : 'max-w-[80%]';

    const chatMessages = document.getElementById('chat-messages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'flex items-start space-x-3';
    messageDiv.innerHTML = '<div class="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">' +
        '<i class="fa-solid fa-robot text-indigo-600"></i>' +
        '</div>' +
        '<div class="bg-gray-100 rounded-lg p-3 ' + widthClass + '">' +
        content +
        '</div>';
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    flushPendingMcpApps();
}

function _handleStateError(state) {
    // Rendering is now handled by onToolCallResult (spec-native TOOL_CALL_RESULT
    // with isError:true). This function only tracks _lastRenderedError so that
    // dedup guards elsewhere stay consistent with state.
    if (state && state.error && state.error.type === 'authorization_error') {
        _lastRenderedError = state.error.message;
    }
}

// ─── A2A Delegation Card ──────────────────────────────────────────────────────
// Tracks the active per-turn delegation card DOM node and synthesis indicator.
// Both are reset at the start of each run via _resetDelegationCard().
let _delegationCardEl = null;
let _synthesisIndicatorEl = null;

function _resetDelegationCard() {
    _delegationCardEl = null;
    _synthesisIndicatorEl = null;
}

/**
 * Collapse the "Deciding which agents to consult…" placeholder to a calm
 * terminal line when a turn ends without ever delegating. Only acts while the
 * card is still showing the spinner placeholder (`.a2a-deciding-row`) — once
 * real agent rows have been swapped in by _handleDelegationPlan, this is a
 * no-op so it never clobbers a live delegation view.
 *
 * Driven by the backend `planner.declined` event and, as a safety net,
 * by onRunFinished/onRunError so an orphaned spinner can never outlive the run
 * (e.g. against a stale backend image that doesn't emit the terminal event).
 *
 * @param {string} [reason] - out_of_scope | empty_registry | unreachable
 */
function _collapseDelegationCardIfUndecided(reason) {
    if (!_delegationCardEl) return;
    const decidingRow = _delegationCardEl.querySelector('.a2a-deciding-row');
    if (!decidingRow) return;  // real agent rows present — leave the live view alone
    const text = reason === 'empty_registry' || reason === 'unreachable'
        ? 'No sub-agents reachable — handled directly.'
        : 'No sub-agents needed — handled directly.';
    decidingRow.className = 'a2a-deciding-row flex items-center gap-2 py-1 text-sm text-gray-500';
    decidingRow.innerHTML =
        '<i class="fa-solid fa-check text-gray-400 w-4 text-center flex-shrink-0"></i>' +
        `<span>${escapeHtml(text)}</span>`;
}

/**
 * Handle the `planner.gathering` event — the Trip Planner has paused to ask for
 * missing trip details (the blue gather-args elicitation card follows on the
 * run's interrupt outcome). This only annotates the delegation card so the user
 * understands why the run paused mid-flight:
 *
 *   - Pre-gate: the planner never emitted `planner.deciding` (it short-circuits
 *     before routing), so there's no delegation card at all — nothing to park,
 *     the gather card stands alone. No-op here.
 *   - Post-gate: real agent rows are already on screen from `a2a.delegation.plan`.
 *     They're accurate (those agents WILL run after the answer), so leave them
 *     and add a calm waiting sub-line keyed to the first missing slot.
 *
 * value: { round: number, missing: string[] }
 */
function _handlePlannerGathering(value) {
    if (!_delegationCardEl) return;  // pre-gate: no card was ever drawn
    const rowsContainer = _delegationCardEl.querySelector('.a2a-agent-rows');
    if (!rowsContainer) return;

    // If only the "Deciding…" spinner is showing (no real rows yet), collapse it
    // to a waiting line rather than leaving a spinner that implies active work.
    const hasAgentRows = rowsContainer.querySelector('.a2a-agent-row');
    const waiting = _gatherWaitingLabel(value && value.missing);
    if (!hasAgentRows) {
        const decidingRow = rowsContainer.querySelector('.a2a-deciding-row');
        if (decidingRow) {
            decidingRow.className = 'a2a-deciding-row flex items-center gap-2 py-1 text-sm text-gray-500';
            decidingRow.innerHTML =
                '<i class="fa-solid fa-circle-question text-blue-400 w-4 text-center flex-shrink-0"></i>' +
                `<span>${escapeHtml(waiting)}</span>`;
        }
        return;
    }

    // Post-gate: park the live agent rows with a shared waiting sub-line.
    if (_delegationCardEl.querySelector('.a2a-gather-waiting')) return;  // idempotent
    const note = document.createElement('div');
    note.className = 'a2a-gather-waiting flex items-center gap-2 py-1 mt-1 text-xs text-blue-500 border-t border-gray-200 pt-2';
    note.innerHTML =
        '<i class="fa-solid fa-circle-question w-4 text-center flex-shrink-0"></i>' +
        `<span>${escapeHtml(waiting)}</span>`;
    rowsContainer.appendChild(note);
    const chatMessages = document.getElementById('chat-messages');
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Human-readable "waiting on …" label for the gather pause, keyed to the
// missing slots. Mirrors the slot names the planner sends in planner.gathering.
const _GATHER_SLOT_PHRASES = {
    destination: 'your destination',
    origin: 'your departure city',
    departDate: 'your travel dates',
    returnDate: 'your travel dates',
};
function _gatherWaitingLabel(missing) {
    const slots = Array.isArray(missing) ? missing : [];
    for (const key of ['origin', 'destination', 'departDate', 'returnDate']) {
        if (slots.includes(key)) return `Waiting for ${_GATHER_SLOT_PHRASES[key]}…`;
    }
    return 'Need a few details before I can route this…';
}

const _A2A_AGENT_ICONS = {
    weather:  'fa-cloud-sun',
    flights:  'fa-plane',
    hotels:   'fa-hotel',
};
const _A2A_AGENT_LABELS = {
    weather:  'Weather',
    flights:  'Flights',
    hotels:   'Hotels',
};
const _A2A_TERMINAL_STATES = new Set([
    'TASK_STATE_COMPLETED', 'completed',
    'TASK_STATE_FAILED',    'failed',
    'TASK_STATE_REJECTED',  'rejected',
    'TASK_STATE_CANCELED',  'canceled',
]);

/**
 * Build the delegation card chrome (avatar + bubble) with an empty agent-row
 * container. Used by both the placeholder tile and the resolved plan tile.
 * Returns the outer card element; the caller appends rows to `.a2a-agent-rows`.
 */
function _buildDelegationCardShell() {
    const card = document.createElement('div');
    card.className = 'flex items-start space-x-3';
    card.innerHTML =
        '<div class="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">' +
        '<i class="fa-solid fa-robot text-indigo-600"></i>' +
        '</div>' +
        '<div class="bg-gray-100 rounded-lg p-3 w-64">' +
        '<p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">' +
        '<i class="fa-solid fa-arrow-right-arrow-left mr-1 text-indigo-400"></i>Delegating to sub-agents</p>' +
        '<div class="a2a-agent-rows space-y-1"></div>' +
        '</div>';
    return card;
}

/**
 * Inject a placeholder delegation card with a single "deciding" subtitle row.
 * The agent-row container is left empty until `a2a.delegation.plan` arrives,
 * at which point _handleDelegationPlan() swaps the placeholder out.
 */
function _handlePlannerDeciding() {
    if (_delegationCardEl) return;  // plan may have arrived first; don't double up
    const card = _buildDelegationCardShell();
    const rowsContainer = card.querySelector('.a2a-agent-rows');
    rowsContainer.innerHTML =
        '<div class="a2a-deciding-row flex items-center gap-2 py-1 text-sm text-gray-500">' +
        '<i class="fa-solid fa-circle-notch fa-spin text-indigo-400 w-4 text-center flex-shrink-0"></i>' +
        '<span>Deciding which agents to consult…</span>' +
        '</div>';

    const chatMessages = document.getElementById('chat-messages');
    chatMessages.appendChild(card);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    _delegationCardEl = card;
}

/**
 * Inject the delegation tracker card into chat when the plan is known.
 * value: { agents: string[], unreachable: string[] }
 *
 * If a placeholder card was already injected on `planner.deciding`, reuse it
 * and just replace the row container so the user sees an in-place transition
 * from "Deciding…" to the per-agent status rows.
 */
function _handleDelegationPlan(value) {
    const agents   = Array.isArray(value.agents)      ? value.agents      : [];
    const dead     = new Set(Array.isArray(value.unreachable) ? value.unreachable : []);
    const allKeys  = [...agents, ...dead];

    if (allKeys.length === 0) return;

    const rows = allKeys.map(key => {
        const icon    = _A2A_AGENT_ICONS[key]  || 'fa-robot';
        const label   = _A2A_AGENT_LABELS[key] || key;
        const isDead  = dead.has(key);
        const statusHtml = isDead
            ? '<span class="text-red-400 text-xs">unreachable</span>'
            : '<span class="a2a-status text-gray-400 text-xs flex items-center gap-1">' +
              '<i class="fa-solid fa-circle-notch fa-spin text-indigo-400"></i>waiting…</span>';
        return `<div class="a2a-agent-row flex items-start gap-2 py-1" data-agent-key="${escapeHtml(key)}">` +
               `<i class="fa-solid ${icon} text-indigo-400 mt-0.5 w-4 text-center flex-shrink-0"></i>` +
               `<div class="flex-1 min-w-0">` +
               `<span class="font-medium text-gray-700 text-sm">${escapeHtml(label)}</span>` +
               `<div class="a2a-agent-text text-xs text-gray-500 mt-0.5 leading-snug"></div>` +
               `</div>` +
               `<div class="a2a-agent-status flex-shrink-0">${statusHtml}</div>` +
               `</div>`;
    }).join('');

    if (_delegationCardEl) {
        const rowsContainer = _delegationCardEl.querySelector('.a2a-agent-rows');
        if (rowsContainer) {
            rowsContainer.innerHTML = rows;
            const chatMessages = document.getElementById('chat-messages');
            chatMessages.scrollTop = chatMessages.scrollHeight;
            return;
        }
    }

    const card = _buildDelegationCardShell();
    card.querySelector('.a2a-agent-rows').innerHTML = rows;

    const chatMessages = document.getElementById('chat-messages');
    chatMessages.appendChild(card);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    _delegationCardEl = card;
}

/**
 * Update the matching agent row in the delegation card.
 * value: { agent, agentKey, taskId, frame }
 */
function _handleDelegationUpdate(value) {
    if (!_delegationCardEl) return;

    const key   = value.agentKey;
    const frame = value.frame || {};
    const row   = _delegationCardEl.querySelector(`[data-agent-key="${CSS.escape(key)}"]`);
    if (!row) return;

    // Extract display text from artifact updates
    const artifact = frame.artifactUpdate && frame.artifactUpdate.artifact;
    if (artifact) {
        const parts = Array.isArray(artifact.parts) ? artifact.parts : [];
        const text  = parts.map(p => p.text || '').join('').trim();
        if (text) {
            const textEl = row.querySelector('.a2a-agent-text');
            if (textEl) textEl.textContent = text.length > 120 ? text.slice(0, 120) + '…' : text;
        }
    }

    // Detect terminal state
    const state = ((frame.statusUpdate || {}).status || {}).state || '';
    if (!state) return;

    const statusEl = row.querySelector('.a2a-agent-status');
    if (!statusEl) return;

    if (state === 'TASK_STATE_COMPLETED' || state === 'completed') {
        statusEl.innerHTML = '<i class="fa-solid fa-circle-check text-green-500 text-sm"></i>';
    } else if (_A2A_TERMINAL_STATES.has(state)) {
        const label = state.replace('TASK_STATE_', '').toLowerCase();
        statusEl.innerHTML = `<span class="text-red-400 text-xs flex items-center gap-1">` +
            `<i class="fa-solid fa-circle-xmark"></i>${escapeHtml(label)}</span>`;
    } else if (state === 'TASK_STATE_WORKING' || state === 'working') {
        statusEl.innerHTML = '<span class="a2a-status text-gray-400 text-xs flex items-center gap-1">' +
            '<i class="fa-solid fa-circle-notch fa-spin text-indigo-400"></i>working…</span>';
    }

    const chatMessages = document.getElementById('chat-messages');
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Mark the matching agent row as failed with the PAZ decision label.
 * value: { agent, agentKey, message, pazDecision }
 *   pazDecision: 'DENY' → orange icon, 'ERROR'/'UNAVAILABLE'/other → red icon
 */
function _handleDelegationError(value) {
    if (!_delegationCardEl) return;
    const key = value.agentKey;
    const row = _delegationCardEl.querySelector(`[data-agent-key="${CSS.escape(key)}"]`);
    if (!row) return;

    const decision = (value.pazDecision || 'ERROR').toUpperCase();
    const isDeny   = decision === 'DENY';
    const color    = isDeny ? 'text-orange-400' : 'text-red-400';

    const statusEl = row.querySelector('.a2a-agent-status');
    if (statusEl) {
        statusEl.innerHTML =
            `<span class="${color} text-xs flex items-center gap-1">` +
            `<i class="fa-solid fa-circle-xmark"></i>${escapeHtml(decision)}</span>`;
    }

    const chatMessages = document.getElementById('chat-messages');
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function _handleCustomEvent(name, value) {
    if (name === 'planner.deciding') {
        _handlePlannerDeciding();
    } else if (name === 'planner.declined') {
        _collapseDelegationCardIfUndecided(value && value.reason);
    } else if (name === 'planner.gathering') {
        _handlePlannerGathering(value);
    } else if (name === 'a2a.delegation.plan') {
        _handleDelegationPlan(value);
    } else if (name === 'a2a.delegation.update') {
        _handleDelegationUpdate(value);
    } else if (name === 'a2a.delegation.error') {
        _handleDelegationError(value);
    } else if (name === 'a2a.synthesis.started') {
        const chatMessages = document.getElementById('chat-messages');
        const el = document.createElement('div');
        el.className = 'flex items-start space-x-3 ml-11';
        el.innerHTML =
            '<span class="text-xs text-gray-500 italic flex items-center gap-1">' +
            '<i class="fa-solid fa-circle-notch fa-spin text-indigo-400"></i>' +
            'Compiling trip summary…</span>';
        chatMessages.appendChild(el);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        _synthesisIndicatorEl = el;
    } else if (name === 'elicitation.declined') {
        const html = renderElicitationDeclined({ toolName: value.toolName, action: value.action });
        if (html) {
            const chatMessages = document.getElementById('chat-messages');
            const div = document.createElement('div');
            div.className = 'flex items-start space-x-3';
            div.innerHTML = '<div class="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">' +
                '<i class="fa-solid fa-robot text-indigo-600"></i>' +
                '</div>' +
                '<div class="bg-gray-100 rounded-lg p-3 max-w-[80%]">' + html + '</div>';
            chatMessages.appendChild(div);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    } else if (name === 'ciba.consent_pending') {
        console.log('[AgentClient] CIBA consent pending:', value);
    } else if (name === 'oauth.token_exchange') {
        // Trip Planner surfaces the inbound RFC 8693 delegation proof
        // (X-Tx-Token) so it renders in the OAuth Token Flow panel — mirrors
        // the MCP path's _exchangedToken feed (app.js).
        if (value && value.token) {
            addToken(value.token, TOKEN_TYPES.EXCHANGE);
            updateTokenPanel();
        }
    }
}

/**
 * Add a user message to the chat UI
 */
function addUserMessage(message) {
    const chatMessages = document.getElementById('chat-messages');
    const user = getCurrentUser();
    const initials = user?.name ? user.name.split(' ').map(n => n[0]).join('').toUpperCase() : 'U';
    
    const messageDiv = document.createElement('div');
    messageDiv.className = 'flex items-start space-x-3 justify-end';
    messageDiv.innerHTML = `
        <div class="bg-indigo-400 text-white rounded-lg p-3 max-w-[80%]">
            <p>${escapeHtml(message)}</p>
        </div>
        <div class="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center flex-shrink-0 text-white font-semibold text-sm">
            ${initials}
        </div>
    `;
    
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Add an assistant message to the chat UI
 */
function addAssistantMessage(message, isError = false, traceId = null) {
    const chatMessages = document.getElementById('chat-messages');

    // Auto-detect isError from CallToolResult shape — but NOT for authorization
    // errors, which render their own amber-styled card inside a neutral bubble.
    // Only flag the outer bubble red for generic isError (agent errors) or when
    // the caller explicitly sets isError (caught exceptions).
    if (!isError && typeof message === 'object' && message.isError) {
        const sc = message.structuredContent || {};
        // Authorization errors get amber cards inside a neutral bubble
        if (sc.type !== 'authorization_error') {
            isError = true;
        }
    }

    const pendingBefore = _pendingMcpApps.length;
    const content = formatAssistantMessage(message);
    if (!content) return; // Nothing to display (e.g. CIBA timeout/denied updated card in-place)

    // Use a wider bubble when the response contains an MCP App iframe or structured content
    const hasMcpApp = _pendingMcpApps.length > pendingBefore;
    const hasStructuredContent = typeof message === 'object' && message.structuredContent;
    // For structured content / MCP Apps use a fixed w-[95%] so the bubble always
    // occupies 95% of the flex row regardless of inner content width.
    // max-w-[95%] alone only sets an upper bound — the bubble still shrinks to
    // content width inside the flex container, leaving structured cards narrow.
    // For plain text, max-w-[80%] is correct (bubble naturally wraps to content).
    const widthClass = (hasMcpApp || hasStructuredContent) ? 'w-1/2 max-w-[80%]' : 'max-w-[80%]';

    const messageDiv = document.createElement('div');
    messageDiv.className = 'flex items-start space-x-3';
    messageDiv.innerHTML = `
        <div class="w-8 h-8 rounded-full ${isError ? 'bg-red-100' : 'bg-indigo-100'} flex items-center justify-center flex-shrink-0">
            <i class="fa-solid ${isError ? 'fa-exclamation-triangle text-red-600' : 'fa-robot text-indigo-600'}"></i>
        </div>
        <div class="${isError ? 'bg-red-50 border border-red-200' : 'bg-gray-100'} rounded-lg p-3 ${widthClass}">
            ${content}
        </div>
    `;
    
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Initialize any MCP App iframes that were just added to the DOM
    flushPendingMcpApps();

}

/**
 * Add typing indicator
 */
function addTypingIndicator() {
    const chatMessages = document.getElementById('chat-messages');
    
    const typingDiv = document.createElement('div');
    typingDiv.id = 'typing-indicator';
    typingDiv.className = 'flex items-start space-x-3';
    typingDiv.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
            <i class="fa-solid fa-robot text-indigo-600"></i>
        </div>
        <div class="bg-gray-100 rounded-lg p-3">
            <div class="flex space-x-1">
                <span class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0ms"></span>
                <span class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 150ms"></span>
                <span class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 300ms"></span>
            </div>
        </div>
    `;
    
    chatMessages.appendChild(typingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Remove typing indicator
 */
function removeTypingIndicator() {
    const typingDiv = document.getElementById('typing-indicator');
    if (typingDiv) {
        typingDiv.remove();
    }
}

/**
 * Format assistant message with rich content.
 *
 * Accepts either:
 *   - A CallToolResult object (from MCP):  { content[], structuredContent?, isError? }
 *   - A plain string (legacy / simple text)
 */
function formatAssistantMessage(message) {
    if (typeof message === 'string') {
        return `<p class="text-gray-800">${escapeHtml(message)}</p>`;
    }

    if (typeof message === 'object' && Array.isArray(message.content)) {
        return formatCallToolResult(message);
    }

    // Fallback: unknown shape — stringify
    return `<p class="text-gray-800">${escapeHtml(JSON.stringify(message))}</p>`;
}

// =============================================================================
// CallToolResult rendering
// =============================================================================

/**
 * Render an MCP CallToolResult into chat HTML.
 *
 * CallToolResult shape (from agent mcpServer.js):
 *   content[]          - text items, resource items (MCP Apps)
 *   structuredContent  - typed data (expenses, budgets, flights, etc.)
 *   isError            - true for authorization / agent errors
 */
function formatCallToolResult(result) {
    const sc = result.structuredContent || {};
    let html = '';

    // ── Authorization errors ─────────────────────────────────────────────
    if (result.isError && sc.type === 'authorization_error') {
        return formatAuthorizationError(sc);
    }

    // ── Generic errors (isError without authorization_error) ─────────────
    if (result.isError) {
        const errorText = extractText(result.content);
        html += `
            <div class="flex items-start space-x-3">
                <div class="flex-shrink-0">
                    <i class="fa-solid fa-circle-xmark text-red-500 text-xl"></i>
                </div>
                <div class="flex-1 min-w-0">
                    <h4 class="text-red-800 font-semibold mb-1">Agent Error</h4>
                    <p class="text-red-700 text-sm break-words">${escapeHtml(errorText)}</p>
                </div>
            </div>
        `;
        return html;
    }

    // ── MCP App via _meta.ui.resourceUri ────────────────────────────
    // Per MCP Apps spec (2026-01-26): the tool declares _meta.ui.resourceUri,
    // the host fetches the HTML via resources/read and renders it in a
    // sandboxed iframe. The CallToolResult carries data (not HTML) in
    // structuredContent, which is passed to the View via tool-result.
    // When a resourceUri is present, the iframe IS the canonical rendering;
    // content[].text is a fallback for hosts that don't support MCP Apps.
    const resourceUri = result._meta?.ui?.resourceUri;
    console.log('[MCPApp:debug] _meta check:', JSON.stringify(result._meta), 'resourceUri:', resourceUri);
    if (resourceUri) {
        const iframeId = 'mcp-app-' + (++_mcpAppCounter);
        const sandboxHtml = buildSandboxProxyHtml();
        html += `
            <div class="mt-2 mb-3 rounded-lg overflow-hidden border border-gray-200" style="background:#fafbfc;">
                <iframe id="${iframeId}"
                    sandbox="allow-scripts allow-same-origin"
                    style="width:100%;border:none;min-height:80px;display:block;"
                    srcdoc="${escapeAttr(sandboxHtml)}"
                ></iframe>
            </div>
        `;
        // Queue bridge setup with the full CallToolResult and tool arguments.
        // The tool arguments are extracted from the chat message context.
        _pendingMcpApps.push({
            iframeId,
            toolResult: result,          // Full CallToolResult as-is (Gap 1)
            toolArguments: result._toolArguments || {},  // For tool-input (Gap 2)
            resourceUri                  // For resources/read fetch (Gap 5)
        });
    } else {
        // ── Text content items (fallback when no MCP App iframe) ─────────
        const textParts = result.content.filter(c => c.type === 'text');
        if (textParts.length > 0) {
            const text = textParts.map(c => c.text).join('\n');
            html += `<p class="text-gray-800 mb-3">${escapeHtml(text)}</p>`;
        }
    }

    // ── Render structuredContent based on type ───────────────────────────
    html += renderStructuredContent(sc);

    return html || '<p class="text-gray-800">Response received.</p>';
}

/**
 * Extract the first text string from a content[] array.
 */
function extractText(content) {
    if (!Array.isArray(content)) return 'Unknown error';
    const textItem = content.find(c => c.type === 'text');
    return textItem ? textItem.text : 'Unknown error';
}

/**
 * Render authorization error as a styled card.
 * Handles CIBA consent timeout/denied (updates existing consent card in-place),
 * insufficient_scope, and generic access denied.
 */
function formatAuthorizationError(sc) {
    const errCode = sc.error || '';

    // CIBA consent timeout — update existing card if present, otherwise fall through
    if (errCode === 'ciba_consent_timeout') {
        const card = sc.ciba_txn_id ? document.getElementById(`ciba-request-${sc.ciba_txn_id}`) : null;
        if (card) { expireCibaConsentCard(sc.ciba_txn_id, 'EXPIRED'); return ''; }
        // No card in DOM (in-chat disabled) — fall through to generic error render
    }

    // CIBA consent denied — update existing card if present, otherwise fall through
    if (errCode === 'ciba_consent_denied') {
        const card = sc.ciba_txn_id ? document.getElementById(`ciba-request-${sc.ciba_txn_id}`) : null;
        if (card) { expireCibaConsentCard(sc.ciba_txn_id, 'DENIED'); return ''; }
        // No card in DOM (in-chat disabled) — fall through to generic error render
    }

    // CIBA flow initiated — silent, the consent card will appear from polling
    if (errCode === 'ciba_pending') {
        return '';
    }

    // Insufficient scope — PAZ denied due to missing permission
    if (errCode === 'insufficient_scope') {
        const scope = sc.scope ? `<strong>${escapeHtml(sc.scope)}</strong>` : 'the required permission';
        return `
            <div class="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <div class="flex items-start space-x-3">
                    <div class="flex-shrink-0">
                        <i class="fa-solid fa-lock text-amber-600 text-xl"></i>
                    </div>
                    <div class="flex-1">
                        <h4 class="text-amber-800 font-semibold mb-2">Insufficient Permissions</h4>
                        <p class="text-amber-700 text-sm mb-3">The agent does not have ${scope} to perform this action.</p>
                        <p class="text-amber-600 text-xs mt-2">
                            <i class="fa-solid fa-circle-info mr-1"></i>
                            Contact your administrator to request access.
                        </p>
                    </div>
                </div>
            </div>
        `;
    }

    // Generic access denied
    const detail = sc.message || 'This operation requires additional privileges.';
    const isCibaDenied = errCode === 'ciba_consent_denied';
    const isCibaTimeout = errCode === 'ciba_consent_timeout';
    const hint = isCibaDenied
        ? 'You can try the request again if you change your mind.'
        : isCibaTimeout
        ? 'Please try your request again.'
        : 'Contact your administrator to request access.';
    const icon = isCibaDenied ? 'fa-hand' : isCibaTimeout ? 'fa-clock' : 'fa-shield-exclamation';
    const title = isCibaDenied ? 'Authorization Denied' : isCibaTimeout ? 'Authorization Expired' : 'Access Denied';
    return `
        <div class="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <div class="flex items-start space-x-3">
                <div class="flex-shrink-0">
                    <i class="fa-solid fa-${icon} text-amber-600 text-xl"></i>
                </div>
                <div class="flex-1">
                    <h4 class="text-amber-800 font-semibold mb-2">${title}</h4>
                    <p class="text-amber-700 text-sm mb-3">${escapeHtml(detail)}</p>
                    <p class="text-amber-600 text-xs mt-2">
                        <i class="fa-solid fa-circle-info mr-1"></i>
                        ${hint}
                    </p>
                </div>
            </div>
        </div>
    `;
}

// =============================================================================
// structuredContent renderers — keyed by sc.type
// =============================================================================

/**
 * Render structuredContent into HTML cards/tables.
 * Returns empty string if no structured data or unknown type.
 */
function renderStructuredContent(sc) {
    if (!sc || !sc.type) return '';

    switch (sc.type) {
        case 'expense_list':
        case 'approval_list':
            return renderExpenseList(sc.expenses || []);

        case 'expense_detail':
            return renderExpenseDetail(sc);

        case 'expense_action':
            // The text content already describes the action; nothing extra to render
            return '';

        case 'budget_summary':
            return renderBudgetSummary(sc);

        case 'flight_results':
            return renderFlightResults(sc);

        case 'booking_confirmation':
            return renderBookingConfirmation(sc);

        case 'booking_detail':
            return renderBookingDetail(sc);

        case 'hotel_results':
            // Hotels are rendered via MCP App iframe — no additional structured rendering
            return '';

        case 'itinerary':
            return renderItinerary(sc);

        case 'trip_summary':
            return renderTripSummary(sc);

        case 'financial_report':
            // Rendered by MCP App iframe — return minimal fallback
            return `<div class="text-sm text-gray-500">Financial report loaded in view.</div>`;

        case 'elicitation_declined':
            return renderElicitationDeclined(sc);

        default:
            return '';
    }
}

/**
 * Render a list of expenses as cards.
 */
function renderExpenseList(expenses) {
    if (!expenses.length) return '';

    let html = '<div class="space-y-2 mt-2">';
    for (const expense of expenses) {
        const statusBadge = getStatusBadge(expense.status);
        const isDraft = expense.status === 'draft';
        const amount = typeof expense.amount === 'number' ? expense.amount.toFixed(2) : expense.amount;
        const id = expense.expense_id || expense.id || '';
        html += `
            <div class="bg-white border rounded-lg p-3">
                <div class="flex justify-between items-center">
                    <div class="flex items-center space-x-2">
                        <span class="font-medium text-gray-800">${escapeHtml(id)}</span>
                        ${statusBadge}
                    </div>
                    <span class="text-green-600 font-semibold">$${escapeHtml(String(amount))}</span>
                </div>
                <div class="text-sm text-gray-500 mt-1">
                    ${expense.description ? escapeHtml(expense.description) + ' &bull; ' : ''}${escapeHtml(expense.category || '')}
                </div>
                ${isDraft ? `
                <div class="mt-2 pt-2 border-t text-right">
                    <button onclick="sendSuggestion('Submit expense ${escapeHtml(id)}')" 
                        class="text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1 rounded-md transition-colors">
                        <i class="fa-solid fa-paper-plane mr-1"></i>Submit
                    </button>
                </div>` : ''}
            </div>
        `;
    }
    html += '</div>';
    return html;
}

/**
 * Render a single expense detail.
 */
function renderExpenseDetail(sc) {
    const statusBadge = getStatusBadge(sc.status);
    const amount = typeof sc.amount === 'number' ? sc.amount.toFixed(2) : sc.amount;
    return `
        <div class="bg-white border rounded-lg p-3 mt-2">
            <div class="flex justify-between items-center mb-2">
                <div class="flex items-center space-x-2">
                    <span class="font-medium text-gray-800">${escapeHtml(sc.expense_id || '')}</span>
                    ${statusBadge}
                </div>
                <span class="text-green-600 font-semibold">$${escapeHtml(String(amount || ''))}</span>
            </div>
            ${sc.description ? `<div class="text-sm text-gray-500">${escapeHtml(sc.description)}</div>` : ''}
            ${sc.category ? `<div class="text-sm text-gray-500">${escapeHtml(sc.category)}</div>` : ''}
        </div>
    `;
}

/**
 * Render a budget summary as a key-value grid.
 */
function renderBudgetSummary(sc) {
    const rows = [];
    if (sc.cost_center) rows.push(['Cost Center', sc.cost_center]);
    if (sc.allocated != null) rows.push(['Allocated', '$' + Number(sc.allocated).toLocaleString()]);
    if (sc.spent != null) rows.push(['Spent', '$' + Number(sc.spent).toLocaleString()]);
    if (sc.remaining != null) rows.push(['Remaining', '$' + Number(sc.remaining).toLocaleString()]);
    if (sc.utilization_pct != null) rows.push(['Utilization', sc.utilization_pct + '%']);

    if (rows.length === 0) return '';

    return `
        <div class="bg-white border rounded-lg p-3 mt-2">
            <div class="grid grid-cols-2 gap-2 text-sm">
                ${rows.map(([key, value]) => `
                    <div class="text-gray-500">${escapeHtml(key)}:</div>
                    <div class="font-medium">${escapeHtml(String(value))}</div>
                `).join('')}
            </div>
        </div>
    `;
}

/**
 * Render flight search results.
 */
function renderFlightResults(sc) {
    const flights = sc.flights || [];
    if (!flights.length) return '';

    let html = '<div class="space-y-2 mt-2">';
    for (const f of flights) {
        html += `
            <div class="bg-white border rounded-lg p-3">
                <div class="flex justify-between items-center">
                    <div>
                        <span class="font-medium text-gray-800">${escapeHtml(f.airline || '')} ${escapeHtml(f.flight_number || f.flight_id || '')}</span>
                    </div>
                    <span class="text-green-600 font-semibold">${f.price != null ? '$' + Number(f.price).toFixed(2) : ''}</span>
                </div>
                <div class="text-sm text-gray-500 mt-1">
                    ${escapeHtml(f.origin || sc.origin || '')} &rarr; ${escapeHtml(f.destination || sc.destination || '')}
                    ${f.departure ? ' &bull; ' + escapeHtml(f.departure) : ''}
                </div>
            </div>
        `;
    }
    html += '</div>';
    return html;
}

/**
 * Render a booking confirmation card.
 */
function renderBookingConfirmation(sc) {
    const rows = [];
    if (sc.booking_type) rows.push(['Type', sc.booking_type]);
    if (sc.booking_id) rows.push(['Booking ID', sc.booking_id]);
    if (sc.flight_id) rows.push(['Flight', sc.flight_id]);
    if (sc.hotel_id) rows.push(['Hotel', sc.hotel_id]);
    if (sc.status) rows.push(['Status', sc.status]);

    if (rows.length === 0) return '';

    return `
        <div class="bg-green-50 border border-green-200 rounded-lg p-3 mt-2">
            <div class="flex items-center mb-2">
                <i class="fa-solid fa-check-circle text-green-600 mr-2"></i>
                <span class="font-semibold text-green-800">Booking Confirmed</span>
            </div>
            <div class="grid grid-cols-2 gap-2 text-sm">
                ${rows.map(([key, value]) => `
                    <div class="text-gray-500">${escapeHtml(key)}:</div>
                    <div class="font-medium">${escapeHtml(String(value))}</div>
                `).join('')}
            </div>
        </div>
    `;
}

/**
 * Render a booking detail card.
 */
function renderBookingDetail(sc) {
    const rows = [];
    if (sc.booking_id) rows.push(['Booking ID', sc.booking_id]);
    if (sc.status) rows.push(['Status', sc.status]);
    if (sc.flight_id) rows.push(['Flight', sc.flight_id]);
    if (sc.hotel_id) rows.push(['Hotel', sc.hotel_id]);
    if (sc.check_in) rows.push(['Check-in', sc.check_in]);
    if (sc.check_out) rows.push(['Check-out', sc.check_out]);

    if (rows.length === 0) return '';

    return `
        <div class="bg-white border rounded-lg p-3 mt-2">
            <div class="grid grid-cols-2 gap-2 text-sm">
                ${rows.map(([key, value]) => `
                    <div class="text-gray-500">${escapeHtml(key)}:</div>
                    <div class="font-medium">${escapeHtml(String(value))}</div>
                `).join('')}
            </div>
        </div>
    `;
}

/**
 * Render a travel itinerary.
 */
function renderItinerary(sc) {
    const bookings = sc.bookings || [];
    if (!bookings.length) return '';

    let html = '<div class="space-y-2 mt-2">';
    for (const b of bookings) {
        const label = b.type === 'hotel' ? 'Hotel' : 'Flight';
        const icon = b.type === 'hotel' ? 'fa-hotel' : 'fa-plane';
        html += `
            <div class="bg-white border rounded-lg p-3">
                <div class="flex items-center space-x-2 mb-1">
                    <i class="fa-solid ${icon} text-indigo-500"></i>
                    <span class="font-medium text-gray-800">${escapeHtml(label)}: ${escapeHtml(b.booking_id || b.id || '')}</span>
                </div>
                <div class="text-sm text-gray-500">
                    ${b.description ? escapeHtml(b.description) : ''}
                    ${b.status ? ' &bull; ' + escapeHtml(b.status) : ''}
                </div>
            </div>
        `;
    }
    html += '</div>';
    return html;
}

/**
 * Render a structured Trip Summary card from STATE_DELTA data.
 *
 * The Trip Planner emits a generic, agent-agnostic payload:
 *   sc = { domains: [{ domain, agent, data, summary, packing? }, ...] }
 * one entry per responding sub-agent, keyed by its card-derived domain token.
 * `data` is the agent's raw structured payload (verbatim); `summary` its text;
 * `packing` (weather only) the synthesized packing advice. The router knows no
 * domain names — THIS renderer is the single domain-aware layer (the one
 * accepted hardcode, since the visual card is genuinely UI-specific): each
 * entry is dispatched via TRIP_DOMAIN_RENDERERS to a bespoke per-domain
 * renderer, falling back to renderGenericDomain() for any unknown domain.
 */
const TRIP_DOMAIN_RENDERERS = {
    flights: renderFlightsDomain,
    hotels: renderHotelsDomain,
    weather: renderWeatherDomain,
};

function renderTripSummary(sc) {
    // Generic shape: { domains: [...] }. Tolerate a missing/empty list.
    const domains = (sc && Array.isArray(sc.domains)) ? sc.domains : [];

    let html = '<div class="space-y-3 mt-1">';
    for (const entry of domains) {
        const domain = (entry && entry.domain) || '';
        const renderer = TRIP_DOMAIN_RENDERERS[domain] || renderGenericDomain;
        html += renderer(entry);
        // Packing tips ride along on whichever domain carries them (weather
        // today). Rendered generically off entry.packing so the renderer does
        // not assume which domain it came from.
        if (entry && entry.packing) {
            html += renderPackingTips(entry.packing);
        }
    }
    html += '</div>';
    return html;
}

function renderFlightsDomain(entry) {
    const data = (entry && entry.data) || {};
    const flights = data.flights || [];
    let html = '<div>';
    html += '<div class="flex items-center gap-2 mb-1">' +
        '<i class="fa-solid fa-plane text-indigo-400 w-4 text-center flex-shrink-0"></i>' +
        '<span class="font-semibold text-gray-700 text-sm">Flights</span>' +
        (data.origin && data.destination
            ? `<span class="text-xs text-gray-400 ml-1">${escapeHtml(data.origin)} → ${escapeHtml(data.destination)}</span>`
            : '') +
        '</div>';

    if (flights.length === 0) {
        html += '<p class="text-sm text-gray-500 ml-6">No flights found.</p>';
    } else {
        html += '<div class="space-y-1 ml-6">';
        for (const f of flights) {
            const dep = (f.departure || '').replace('T', ' ').replace(':00Z', '').replace('Z', '');
            const cabin = (f.class || f.cabin_class || 'economy').toUpperCase().slice(0, 3);
            const price = f.price != null ? `$${Number(f.price).toLocaleString()}` : '';
            html += `
                <div class="bg-white border rounded-md px-3 py-2 flex items-center justify-between text-sm">
                    <div class="flex items-center gap-2">
                        <span class="font-medium text-gray-800">${escapeHtml(f.airline || '')}</span>
                        <span class="text-gray-400 text-xs">${escapeHtml(f.flight_id || '')}</span>
                        ${dep ? `<span class="text-gray-500 text-xs">${escapeHtml(dep)}</span>` : ''}
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">${escapeHtml(cabin)}</span>
                        <span class="text-green-600 font-semibold">${escapeHtml(price)}</span>
                    </div>
                </div>`;
        }
        html += '</div>';
    }
    html += '</div>';
    return html;
}

function renderHotelsDomain(entry) {
    const data = (entry && entry.data) || {};
    const hotels = data.hotels || [];
    let html = '<div>';
    html += '<div class="flex items-center gap-2 mb-1">' +
        '<i class="fa-solid fa-hotel text-indigo-400 w-4 text-center flex-shrink-0"></i>' +
        '<span class="font-semibold text-gray-700 text-sm">Hotels</span>' +
        (data.city ? `<span class="text-xs text-gray-400 ml-1">${escapeHtml(data.city)}</span>` : '') +
        '</div>';

    if (hotels.length === 0) {
        html += `<p class="text-sm text-gray-500 ml-6">No hotels found${data.city ? ' in ' + escapeHtml(data.city) : ''}.</p>`;
    } else {
        html += '<div class="space-y-1 ml-6">';
        for (const h of hotels) {
            const stars = '★'.repeat(Math.min(Number(h.stars) || 0, 5));
            const rate = h.rate_per_night != null
                ? `$${Number(h.rate_per_night).toLocaleString()}/${h.currency || 'night'}`
                : '';
            html += `
                <div class="bg-white border rounded-md px-3 py-2 flex items-center justify-between text-sm">
                    <div>
                        <span class="font-medium text-gray-800">${escapeHtml(h.name || '')}</span>
                        ${stars ? `<span class="text-yellow-400 text-xs ml-1">${stars}</span>` : ''}
                    </div>
                    <span class="text-green-600 font-semibold">${escapeHtml(rate)}</span>
                </div>`;
        }
        html += '</div>';
    }
    html += '</div>';
    return html;
}

function renderWeatherDomain(entry) {
    const data = (entry && entry.data) || {};
    const summary = entry && entry.summary;
    const cityLabel = [data.city, data.country].filter(Boolean).join(', ');
    const bits = [];
    if (data.condition) bits.push(escapeHtml(data.condition));
    if (data.temperature_c != null) bits.push(escapeHtml(`${data.temperature_c}°C`));
    if (data.wind_kmh != null) bits.push(escapeHtml(`wind ${data.wind_kmh} km/h`));
    const conditionsLine = bits.join(' · ');

    let html = '<div>';
    html += '<div class="flex items-center gap-2 mb-1">' +
        '<i class="fa-solid fa-cloud-sun text-indigo-400 w-4 text-center flex-shrink-0"></i>' +
        '<span class="font-semibold text-gray-700 text-sm">Weather</span>' +
        (cityLabel ? `<span class="text-xs text-gray-400 ml-1">${escapeHtml(cityLabel)}</span>` : '') +
        '</div>';
    html += '<div class="ml-6 space-y-1">';
    if (conditionsLine) {
        html += `<div class="bg-white border rounded-md px-3 py-2 text-sm text-gray-700">${conditionsLine}</div>`;
    } else if (summary) {
        html += `<div class="bg-white border rounded-md px-3 py-2 text-sm text-gray-700">${escapeHtml(summary)}</div>`;
    }
    html += '</div>';
    html += '</div>';
    return html;
}

function renderPackingTips(packing) {
    let html = '<div>';
    html += '<div class="flex items-center gap-2 mb-1">' +
        '<i class="fa-solid fa-suitcase-rolling text-indigo-400 w-4 text-center flex-shrink-0"></i>' +
        '<span class="font-semibold text-gray-700 text-sm">Packing Tips</span>' +
        '</div>';
    html += '<div class="ml-6">';
    html += `<div class="bg-white border rounded-md px-3 py-2 text-sm text-gray-700">${escapeHtml(packing)}</div>`;
    html += '</div>';
    html += '</div>';
    return html;
}

// Fallback for an unknown domain: show the agent identity and its summary text
// (or a compact JSON dump of the payload) so a newly added travel agent still
// surfaces something useful without a bespoke renderer.
function renderGenericDomain(entry) {
    const domain = (entry && entry.domain) || 'result';
    const agent = (entry && entry.agent) || domain;
    const label = domain.charAt(0).toUpperCase() + domain.slice(1);
    let body = entry && entry.summary;
    if (!body && entry && entry.data) {
        try {
            body = JSON.stringify(entry.data, null, 2);
        } catch (e) {
            body = '';
        }
    }
    let html = '<div>';
    html += '<div class="flex items-center gap-2 mb-1">' +
        '<i class="fa-solid fa-robot text-indigo-400 w-4 text-center flex-shrink-0"></i>' +
        `<span class="font-semibold text-gray-700 text-sm">${escapeHtml(label)}</span>` +
        `<span class="text-xs text-gray-400 ml-1">${escapeHtml(agent)}</span>` +
        '</div>';
    html += '<div class="ml-6">';
    html += `<div class="bg-white border rounded-md px-3 py-2 text-sm text-gray-700 whitespace-pre-wrap">${escapeHtml(body || '(no details)')}</div>`;
    html += '</div>';
    html += '</div>';
    return html;
}

/**
 * Render a card indicating the user declined or cancelled an elicitation
 * (e.g., chose not to confirm a booking). Surfaces the action verb so the
 * demo audience can see what was prompted.
 */
function renderElicitationDeclined(sc) {
    const tool = sc.toolName || 'action';
    const verb = sc.action === 'decline' ? 'declined' : 'cancelled';
    const argsLine = sc.args && Object.keys(sc.args).length
        ? Object.entries(sc.args)
            .filter(([k]) => !k.startsWith('_'))
            .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
            .join(', ')
        : '';
    return `
        <div class="bg-slate-50 border border-slate-200 rounded-lg p-4 mt-2">
            <div class="flex items-start space-x-3">
                <div class="flex-shrink-0">
                    <i class="fa-solid fa-circle-xmark text-slate-500 text-xl"></i>
                </div>
                <div class="flex-1">
                    <h4 class="text-slate-800 font-semibold mb-1">Action ${escapeHtml(verb)}</h4>
                    <p class="text-sm text-slate-600">
                        You ${escapeHtml(verb)} the request to run <code class="px-1 py-0.5 rounded bg-slate-200 text-xs">${escapeHtml(tool)}</code>${argsLine ? ` (${argsLine})` : ''}.
                    </p>
                </div>
            </div>
        </div>
    `;
}

/**
 * Get a colored status badge for an expense status
 */
function getStatusBadge(status) {
    const badges = {
        draft:    '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">Draft</span>',
        pending:  '<span class="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700">Pending</span>',
        approved: '<span class="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">Approved</span>',
        paid:     '<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">Paid</span>',
    };
    return badges[status] || `<span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">${escapeHtml(status || 'Unknown')}</span>`;
}

/**
 * Escape HTML entities
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Check the active agent's health status.
 * Returns true if agent is reachable, false otherwise.
 */
async function checkAgentHealth() {
    const activeKey = (typeof agentClient !== 'undefined' && agentClient.getCurrentAgent)
        ? agentClient.getCurrentAgent()
        : (CONFIG.defaultAgent || 'workforce');
    const endpoints = (CONFIG.agents && CONFIG.agents[activeKey] && CONFIG.agents[activeKey].endpoints) || {};
    const url = endpoints.health || '/api/health';
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(url, {
            method: 'GET',
            credentials: 'same-origin',
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response.ok;
    } catch (e) {
        return false;
    }
}

/**
 * Update the agent status LED in the UI
 */
function updateAgentStatusLed(isOnline) {
    const led = document.getElementById('agent-status-led');
    const label = document.getElementById('agent-status-label');
    const container = document.getElementById('agent-status');
    if (!led || !label || !container) return;

    if (isOnline) {
        led.className = 'w-2.5 h-2.5 rounded-full bg-green-400 inline-block';
        label.textContent = 'Online';
        container.title = 'Agent is online';
    } else {
        led.className = 'w-2.5 h-2.5 rounded-full bg-red-400 inline-block';
        label.textContent = 'Offline';
        container.title = 'Agent is offline';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CIBA Consent Request UI
// Polls for pending CIBA requests and displays them as consent cards in the chat
// ─────────────────────────────────────────────────────────────────────────────

// Track which CIBA requests we've already shown (by id) to avoid duplicates
const knownCibaRequestIds = new Set();

async function pollCibaRequests() {
    if (!isCibaInChatEnabled()) return;

    const user = getCurrentUser();
    if (!user) return;

    try {
        const [pendingRes, resolvedRes] = await Promise.all([
            fetch('/workforce-portal/ciba/pending', { credentials: 'same-origin' }),
            fetch('/workforce-portal/ciba/resolved', { credentials: 'same-origin' }),
        ]);

        const pending  = pendingRes.ok  ? await pendingRes.json()  : [];
        const resolved = resolvedRes.ok ? await resolvedRes.json() : [];

        const filterForUser = (list) => list.filter(r =>
            r.user_hint === user.sub || r.user_hint === user.email
        );

        renderCibaRequests(filterForUser(pending), filterForUser(resolved));
    } catch (e) {
        console.warn('Failed to poll CIBA requests:', e);
    }
}

function renderCibaRequests(pending, resolved) {
    const pendingIds  = new Set(pending.map(r => r.id));
    const resolvedIds = new Set(resolved.map(r => r.id));
    const allIds      = new Set([...pendingIds, ...resolvedIds]);

    // Add new pending cards
    for (const req of pending) {
        if (knownCibaRequestIds.has(req.id)) continue;
        knownCibaRequestIds.add(req.id);
        buildCibaConsentCard(req);
    }

    // Update displayed pending cards that are now resolved/expired
    for (const req of resolved) {
        if (knownCibaRequestIds.has(req.id)) {
            updateCibaConsentCard(req.id, req.status, req.source);
        }
    }

    // Prune stale IDs no longer in either list
    for (const id of knownCibaRequestIds) {
        if (!allIds.has(id)) knownCibaRequestIds.delete(id);
    }
}

function buildCibaConsentCard(request) {
    const chatMessages = document.getElementById('chat-messages');
    
    const messageDiv = document.createElement('div');
    messageDiv.className = 'flex items-start space-x-3';
    messageDiv.id = `ciba-request-${request.id}`;
    // Stash request data so updateCibaConsentCard can rebuild the details block
    messageDiv.dataset.authzDetails = JSON.stringify(request.authorization_details || null);
    messageDiv.dataset.bindingMessage = request.binding_message || '';

    // Build the authorization details section if present
    const authzDetailsHtml = buildAuthzDetailsHtml(request.authorization_details);

    messageDiv.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
            <i class="fa-solid fa-shield-halved text-amber-600"></i>
        </div>
        <div class="bg-amber-50 border border-amber-200 rounded-lg p-4 max-w-[80%] shadow-sm">
            <div class="flex items-center justify-between mb-3">
                <div class="flex items-center">
                    <i class="fa-solid fa-robot text-indigo-600 mr-2"></i>
                    <span class="font-semibold text-gray-800">Agent Authorization Request</span>
                </div>
                <span class="bg-cyan-100 text-cyan-700 px-2 py-0.5 rounded text-xs font-medium ml-2">CIBA</span>
            </div>
            <p class="text-gray-700 mb-3">
                An AI agent is requesting permission to act on your behalf:
            </p>
            ${authzDetailsHtml || `
            <div class="bg-white border border-amber-100 rounded-lg p-3 mb-4">
                <div class="flex items-center mb-2">
                    <i class="fa-solid fa-comment-dots text-amber-500 mr-2"></i>
                    <span class="text-sm text-gray-500">Binding Message:</span>
                </div>
                <p class="text-gray-800 font-medium">${escapeHtml(request.binding_message || 'No message provided')}</p>
            </div>
            `}
            <div class="flex space-x-3">
                <button onclick="handleCibaConsent('${request.id}', 'APPROVED')" 
                    class="flex-1 bg-green-600 hover:bg-green-700 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center justify-center">
                    <i class="fa-solid fa-check mr-2"></i>Allow
                </button>
                <button onclick="handleCibaConsent('${request.id}', 'DENIED')"
                    class="flex-1 bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center justify-center">
                    <i class="fa-solid fa-xmark mr-2"></i>Deny
                </button>
            </div>
        </div>
    `;
    
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Build HTML for authorization_details section in the consent card.
 * Returns HTML string or empty string if no details.
 */
function buildAuthzDetailsHtml(authorizationDetails, muted = false) {
    if (!authorizationDetails || !Array.isArray(authorizationDetails) || authorizationDetails.length === 0) {
        return '';
    }

    return authorizationDetails.map(detail => {
        const toolName = detail.identifier || detail.type || 'Unknown tool';
        const locations = detail.locations || [];
        const args = detail.arguments || {};
        const argEntries = Object.entries(args);

        const boxBorder = muted ? 'border-gray-100' : 'border-amber-100';
        const iconColor = muted ? 'text-gray-400'   : 'text-indigo-500';
        const nameColor = muted ? 'text-gray-500'   : 'text-gray-800';

        let html = `
            <div class="bg-white border ${boxBorder} rounded-xl p-4 mb-4">
                <div class="flex items-center mb-2">
                    <i class="fa-solid fa-wrench ${iconColor} mr-2"></i>
                    <span class="font-mono text-sm font-semibold ${nameColor}">${escapeHtml(toolName)}</span>
                </div>`;

        if (locations.length > 0) {
            const target = locations.map(l => {
                try { return new URL(l).hostname; } catch { return l; }
            }).join(', ');
            html += `
                <div class="flex items-center text-xs text-gray-500 mb-2 ml-7">
                    <i class="fa-solid fa-server mr-1.5"></i>
                    <span>${escapeHtml(target)}</span>
                </div>`;
        }

        if (argEntries.length > 0) {
            html += `<div class="ml-7 mt-2 bg-gray-50 rounded-lg border border-gray-100 divide-y divide-gray-100 overflow-hidden">`;
            for (const [key, value] of argEntries) {
                const displayValue = typeof value === 'number'
                    ? value.toLocaleString()
                    : String(value);
                html += `
                    <div class="flex justify-between gap-4 px-3 py-2 text-sm">
                        <span class="text-gray-500 font-medium shrink-0">${escapeHtml(key)}</span>
                        <span class="text-gray-800 text-right">${escapeHtml(displayValue)}</span>
                    </div>`;
            }
            html += `</div>`;
        }

        html += `
            </div>`;
        return html;
    }).join('');
}

/**
 * Handle CIBA consent action (APPROVED or DENIED)
 */
async function handleCibaConsent(authReqId, action) {
    try {
        const response = await fetch('/workforce-portal/ciba/action', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ auth_req_id: authReqId, action: action, source: 'portal' })
        });

        if (!response.ok) {
            throw new Error('Failed to submit consent');
        }

        updateCibaConsentCard(authReqId, action, 'portal');

    } catch (e) {
        console.error('Failed to handle CIBA consent:', e);
        addAssistantMessage(`Failed to process your consent: ${e.message}`, true);
    }
}

/**
 * Add message to chat when CIBA token is received
 */
function addCibaTokenReceivedMessage() {
    const chatMessages = document.getElementById('chat-messages');
    
    const messageDiv = document.createElement('div');
    messageDiv.className = 'flex items-start space-x-3';
    messageDiv.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
            <i class="fa-solid fa-key text-purple-600"></i>
        </div>
        <div class="bg-purple-50 border border-purple-200 rounded-lg p-3 max-w-[80%]">
            <div class="flex items-center">
                <i class="fa-solid fa-check-circle text-purple-600 mr-2"></i>
                <span class="font-medium text-purple-700">Token Issued</span>
            </div>
            <p class="text-gray-600 text-sm mt-1">
                A delegation token has been issued and is displayed in the OAuth Token Flow panel.
            </p>
        </div>
    `;
    
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function expireCibaConsentCard(cibaTxnId, reason) {
    updateCibaConsentCard(cibaTxnId, reason === 'EXPIRED' ? 'EXPIRED' : 'DENIED', null);
}

function updateCibaConsentCard(authReqId, action, source) {
    const cardDiv = document.getElementById(`ciba-request-${authReqId}`);
    if (!cardDiv) return;
    if (cardDiv.dataset.resolved === 'true') return;
    cardDiv.dataset.resolved = 'true';

    const authzDetails = (() => {
        try { return JSON.parse(cardDiv.dataset.authzDetails); } catch { return null; }
    })();
    const bindingMessage = cardDiv.dataset.bindingMessage || '';
    const detailsHtml = buildAuthzDetailsHtml(authzDetails, true) || (bindingMessage ? `
        <div class="bg-white border border-gray-100 rounded-xl p-4 mb-0">
            <div class="flex items-center mb-2">
                <i class="fa-solid fa-comment-dots text-gray-400 mr-2"></i>
                <span class="text-sm text-gray-400">Binding Message:</span>
            </div>
            <p class="text-gray-500 font-medium">${escapeHtml(bindingMessage)}</p>
        </div>` : '');

    const isExpired  = action === 'EXPIRED';
    const isApproved = action === 'APPROVED';

    const dotBg     = isExpired ? 'bg-gray-100'  : isApproved ? 'bg-green-100' : 'bg-red-100';
    const iconClass = isExpired ? 'fa-clock text-gray-400' : isApproved ? 'fa-check-circle text-green-600' : 'fa-times-circle text-red-600';
    const bgClass   = isExpired ? 'bg-gray-50 border-gray-200' : isApproved ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200';
    const statusText  = isExpired ? 'Request Expired'  : isApproved ? 'Access Granted' : 'Access Denied';
    const statusColor = isExpired ? 'text-gray-700' : isApproved ? 'text-green-700' : 'text-red-700';

    const verb = isApproved ? 'Approved' : 'Denied';
    const attribution = isExpired ? 'No response before timeout'
        : source === 'authenticator' ? `${verb} from Authenticator App`
        : source === 'portal'        ? `${verb} in chat`
        : null;

    cardDiv.innerHTML = `
        <div class="w-8 h-8 rounded-full ${dotBg} flex items-center justify-center flex-shrink-0">
            <i class="fa-solid ${iconClass}"></i>
        </div>
        <div class="${bgClass} border rounded-lg p-4 max-w-[80%]">
            <div class="flex items-center">
                <i class="fa-solid ${iconClass} mr-2"></i>
                <span class="font-semibold ${statusColor}">${statusText}</span>
            </div>
            ${attribution ? `<p class="text-gray-400 text-xs mt-1 mb-3">${attribution}</p>` : '<div class="mb-3"></div>'}
            ${detailsHtml}
        </div>
    `;
}
