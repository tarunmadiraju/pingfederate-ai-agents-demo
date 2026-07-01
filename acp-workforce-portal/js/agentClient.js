/**
 * AG-UI Agent Client for the Workforce Portal.
 *
 * Replaces mcpClient.js. Consumes the AG-UI SSE stream from
 * POST /api/agent/run (proxied by PA, which injects the PA-signed JWT)
 * and dispatches typed callbacks.
 *
 * Load order: config.js → otel-bundle.js → otel.js → agentClient.js
 */
const agentClient = (() => {
    let _lastTraceId = null;
    let _abortController = null;
    let _currentState = { results: [], error: null };

    // Active agent key (one of CONFIG.agents). Switching agents re-targets
    // runAgent()/readResource() — see js/app.js setActiveAgent() for the UX wiring.
    let _currentAgentKey = (typeof CONFIG !== 'undefined' && CONFIG.defaultAgent) || 'workforce';

    function _activeEndpoints() {
        if (typeof CONFIG !== 'undefined' && CONFIG.agents && CONFIG.agents[_currentAgentKey]) {
            return CONFIG.agents[_currentAgentKey].endpoints;
        }
        return { agentRun: '/api/agent/run', agentResource: '/api/agent/resource' };
    }

    function setCurrentAgent(key) {
        if (typeof CONFIG === 'undefined' || !CONFIG.agents || !CONFIG.agents[key]) {
            console.warn('[AgentClient] Unknown agent key:', key);
            return false;
        }
        _currentAgentKey = key;
        return true;
    }

    function getCurrentAgent() {
        return _currentAgentKey;
    }

    /**
     * Apply a single RFC 6902 patch operation to _currentState (in-place).
     * Only `add` (append to array via /results/-) and `replace` are used.
     */
    function _applyPatch(op) {
        if (op.op === 'replace') {
            const parts = op.path.split('/').filter(Boolean);
            let obj = _currentState;
            for (let i = 0; i < parts.length - 1; i++) {
                if (obj[parts[i]] == null) obj[parts[i]] = {};
                obj = obj[parts[i]];
            }
            obj[parts[parts.length - 1]] = op.value;
        } else if (op.op === 'add' && op.path.endsWith('/-')) {
            const parts = op.path.split('/').filter(p => p && p !== '-');
            let arr = _currentState;
            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                const isLast = i === parts.length - 1;
                if (isLast) {
                    if (!Array.isArray(arr[p])) arr[p] = [];
                    arr[p].push(op.value);
                } else {
                    if (arr[p] == null) arr[p] = {};
                    arr = arr[p];
                }
            }
        }
    }

    /**
     * Parse AG-UI SSE stream and dispatch events to callbacks.
     *
     * @param {string|null} message — user text. Pass null when resuming so an
     *   empty message slot doesn't appear in the conversation history.
     * @param {string} threadId
     * @param {object} callbacks
     * @param {object} [opts]
     * @param {Array<object>} [opts.resume] — RunAgentInput.resume entries.
     *   When provided, the body carries `resume[]` and the agent claims the
     *   matching continuation from interruptStore.
     * @returns {Promise<{ traceId, finalState, outcome }>}
     */
    async function runAgent(message, threadId, callbacks, opts) {
        const cb = callbacks || {};
        const options = opts || {};
        _abortController = new AbortController();
        const isResume = Array.isArray(options.resume) && options.resume.length > 0;

        // Generate a run ID
        const runId = crypto.randomUUID();
        // A resume is a new run on the SAME thread: preserve the accumulated
        // state (results[] + pendingTrip) so it can be echoed back to the agent
        // for stateless continuation. Only a genuinely fresh run starts from a
        // clean slate.
        if (!isResume) _currentState = { results: [], error: null };
        let _capturedOutcome = null;

        // Create OTel span and inject traceparent + baggage. session.id maps to
        // the AG-UI thread (one conversation = one session); it propagates to
        // every backend span alongside user.id (seeded at login).
        const headers = { 'Content-Type': 'application/json' };
        if (typeof otel !== 'undefined' && otel.setIdentityBaggage) {
            otel.setIdentityBaggage({ 'session.id': threadId });
        }
        // Stamp end-user identity span-local on the root span. user.id is also
        // propagated as baggage (seeded at login); stamping it here makes the
        // browser root span directly readable without resolving baggage.
        const _u = (typeof getCurrentUser === 'function') ? getCurrentUser() : null;
        const _runAttrs = { 'agui.thread.id': threadId, 'agui.run.id': runId };
        if (_u && _u.email) _runAttrs['user.id'] = _u.email;
        const span = (typeof otel !== 'undefined' && otel.startAgentRunSpan)
            ? otel.startAgentRunSpan(headers, _runAttrs)
            : null;
        if (span) _lastTraceId = span.spanContext ? span.spanContext.traceId || null : null;
        let _routerModeSet = false;

        // Build messages — when resuming we still need to send something (the
        // backend validates `messages` is an array). For pure resume, send the
        // last assistant or empty user turn; for new turns, send the user msg.
        // Each message needs an `id` because the AG-UI Python SDK (used by the
        // trip-planner agent) requires it; the Node.js workforce agent ignores
        // extras so this stays compatible with both backends.
        const messagesPayload = message != null
            ? [{ id: crypto.randomUUID(), role: 'user', content: message }]
            : [];

        // RunAgentInput shape per AG-UI spec. The Python SDK enforces the full
        // contract (state, tools, context, forwardedProps); the Node.js SDK is
        // lenient. Sending all fields keeps a single client compatible with
        // every orchestrator the portal targets.
        const requestBody = {
            threadId,
            runId,
            // Echo accumulated state on resume so the agent can recover its
            // continuation context (pendingTrip slots) statelessly; a fresh run
            // sends {} so the agent starts clean. The Node workforce agent
            // ignores inbound state on both paths, so this is a no-op there.
            state: isResume ? _currentState : {},
            messages: messagesPayload,
            tools: [],
            context: [],
            forwardedProps: {},
        };
        if (isResume) {
            requestBody.resume = options.resume;
        }

        return new Promise(async (resolve, reject) => {
            try {
                const res = await fetch(
                    _activeEndpoints().agentRun,
                    {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers,
                        body: JSON.stringify(requestBody),
                        signal: _abortController.signal,
                    }
                );

                if (res.status === 401 || res.status === 403 || res.redirected) {
                    if (span) span.end(false);
                    window.location.reload();
                    return;
                }

                if (!res.ok) {
                    const errText = await res.text().catch(() => res.statusText);
                    if (span) span.end(false);
                    reject(new Error(errText || 'Agent returned ' + res.status));
                    return;
                }

                // Parse SSE stream
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let settled = false;

                const dispatch = (event) => {
                    const type = event.type;
                    const v = event;
                    switch (type) {
                        case 'RUN_STARTED':
                            if (cb.onRunStarted) cb.onRunStarted({ runId: v.runId });
                            break;
                        case 'RUN_FINISHED':
                            if (v.outcome) _capturedOutcome = v.outcome;
                            if (cb.onRunFinished) cb.onRunFinished({ outcome: _capturedOutcome });
                            if (span) span.end(true);
                            if (!settled) {
                                settled = true;
                                resolve({ traceId: _lastTraceId, finalState: _currentState, outcome: _capturedOutcome });
                            }
                            break;
                        case 'RUN_ERROR':
                            if (cb.onRunError) cb.onRunError({ message: v.message });
                            if (span) span.end(false);
                            if (!settled) {
                                settled = true;
                                reject(new Error(v.message || 'Agent run failed'));
                            }
                            break;
                        case 'STEP_STARTED':
                            if (!_routerModeSet && span && v.stepName) {
                                // Infer router mode from the first step name:
                                // keyword mode starts with "routing"; LLM mode starts with "reasoning".
                                const mode = v.stepName === 'routing' ? 'keyword'
                                    : v.stepName === 'reasoning' ? 'llm'
                                    : null;
                                if (mode) {
                                    span.setAttributes({ 'agui.router.mode': mode });
                                    _routerModeSet = true;
                                }
                            }
                            if (cb.onStepStarted) cb.onStepStarted({ stepName: v.stepName });
                            break;
                        case 'STEP_FINISHED':
                            if (cb.onStepFinished) cb.onStepFinished({ stepName: v.stepName });
                            break;
                        case 'TEXT_MESSAGE_START':
                            if (cb.onTextMessageStart) cb.onTextMessageStart({ messageId: v.messageId });
                            break;
                        case 'TEXT_MESSAGE_CONTENT':
                            if (cb.onTextMessageContent) cb.onTextMessageContent({ messageId: v.messageId, delta: v.delta });
                            break;
                        case 'TEXT_MESSAGE_END':
                            if (cb.onTextMessageEnd) cb.onTextMessageEnd({ messageId: v.messageId });
                            break;
                        case 'TOOL_CALL_START':
                            if (cb.onToolCallStart) cb.onToolCallStart({ toolCallId: v.toolCallId, toolName: v.toolCallName });
                            break;
                        case 'TOOL_CALL_ARGS':
                            if (cb.onToolCallArgs) cb.onToolCallArgs({ toolCallId: v.toolCallId, args: v.delta });
                            break;
                        case 'TOOL_CALL_END':
                            if (cb.onToolCallEnd) cb.onToolCallEnd({ toolCallId: v.toolCallId });
                            break;
                        case 'TOOL_CALL_RESULT':
                            if (cb.onToolCallResult) cb.onToolCallResult({ messageId: v.messageId, toolCallId: v.toolCallId, result: v.content });
                            break;
                        case 'STATE_SNAPSHOT':
                            _currentState = v.snapshot || _currentState;
                            if (cb.onStateSnapshot) cb.onStateSnapshot({ snapshot: _currentState });
                            break;
                        case 'STATE_DELTA':
                            if (Array.isArray(v.delta)) v.delta.forEach(_applyPatch);
                            if (cb.onStateDelta) cb.onStateDelta({ delta: v.delta, state: _currentState });
                            break;
                        case 'CUSTOM':
                            if (cb.onCustomEvent) cb.onCustomEvent({ name: v.name, value: v.value });
                            break;
                        default:
                            break;
                    }
                };

                // Read SSE chunks
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let idx;
                    while ((idx = buffer.indexOf('\n\n')) !== -1) {
                        const block = buffer.slice(0, idx);
                        buffer = buffer.slice(idx + 2);
                        for (const line of block.split('\n')) {
                            if (!line.startsWith('data:')) continue;
                            const data = line.slice(5).trim();
                            if (!data || data === '[DONE]') continue;
                            try {
                                dispatch(JSON.parse(data));
                            } catch (e) {
                                console.warn('[AgentClient] Failed to parse SSE event:', data);
                            }
                        }
                    }
                }

                // Stream ended without RUN_FINISHED/RUN_ERROR — treat as error
                if (!settled) {
                    if (span) span.end(false);
                    reject(new Error('SSE stream closed unexpectedly'));
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    if (span) span.end(false);
                    reject(new Error('Run aborted'));
                    return;
                }
                if (span) span.end(false);
                reject(err);
            }
        });
    }

    function getLastTraceId() {
        return _lastTraceId;
    }

    function abortRun() {
        if (_abortController) _abortController.abort();
    }

    /**
     * Fetch an MCP App resource HTML via PA-proxied /api/agent/resource.
     * Returns { contents: [{ uri, mimeType, text }] } to match mcpClient.readResource shape.
     */
    async function readResource(uri) {
        const endpoint = _activeEndpoints().agentResource;

        const res = await fetch(endpoint + '?uri=' + encodeURIComponent(uri), {
            credentials: 'same-origin',
        });
        if (res.status === 401 || res.status === 403 || res.redirected) {
            window.location.reload();
            return null;
        }
        if (!res.ok) throw new Error('resource fetch failed: ' + res.status);
        const html = await res.text();
        return { contents: [{ uri, mimeType: 'text/html', text: html }] };
    }

    return { runAgent, getLastTraceId, abortRun, readResource, setCurrentAgent, getCurrentAgent };
})();
