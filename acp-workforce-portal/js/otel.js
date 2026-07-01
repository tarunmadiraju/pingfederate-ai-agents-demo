/**
 * OTel Browser Initialization
 *
 * Initializes the OTel browser SDK (bundled in otel-bundle.js) and exposes
 * tracing helpers for agentClient.js to create AG-UI spans with
 * automatic W3C traceparent propagation.
 *
 * Load order: config.js → otel-bundle.js → otel.js → agentClient.js
 *
 * OTel semantic conventions for MCP:
 *   https://opentelemetry.io/docs/specs/semconv/registry/attributes/mcp/
 */

const otel = (() => {
    let _tracer = null;
    let _ready = false;

    // Identity baggage applied to every outbound span context (MCP + agent.run),
    // so it propagates as W3C `baggage` to every backend hop. Keys are OTel
    // semconv span-attribute names verbatim (user.id, session.id) — each backend
    // SpanProcessor copies them 1:1 onto spans. NOTE: the demo carries the
    // cleartext email as user.id for legibility; production should use an opaque
    // subject identifier (the PA-signed `sub`) and resolve to email in the UI.
    let _identityBaggage = {};

    /**
     * Set the identity baggage propagated on subsequent spans.
     * @param {{ 'user.id'?: string, 'session.id'?: string }} items
     */
    function setIdentityBaggage(items) {
        if (!items) return;
        Object.entries(items).forEach(([k, v]) => {
            if (v != null && v !== '') _identityBaggage[k] = String(v);
        });
    }

    // Apply the stored identity baggage onto a context so propagation.inject
    // emits the W3C `baggage` header. No-op when the SDK isn't ready or there
    // are no items. Returns the (possibly unchanged) context.
    function _withIdentityBaggage(ctx) {
        const keys = Object.keys(_identityBaggage);
        if (!keys.length || !window.otelApi) return ctx;
        const { propagation } = window.otelApi;
        let bag = propagation.getBaggage(ctx) || propagation.createBaggage();
        for (const k of keys) {
            bag = bag.setEntry(k, { value: _identityBaggage[k] });
        }
        return propagation.setBaggage(ctx, bag);
    }

    // Initialize on load — OtelBrowser global is set by otel-bundle.js (IIFE)
    if (typeof OtelBrowser !== 'undefined' && OtelBrowser.init) {
        try {
            _tracer = OtelBrowser.init('/workforce-portal/traces');
            _ready = true;
        } catch (e) {
            console.warn('[OTel] Browser SDK init failed:', e.message);
        }
    } else {
        console.warn('[OTel] otel-bundle.js not loaded — tracing disabled');
    }

    /**
     * Create a span for an MCP request, inject traceparent into headers, and
     * return a handle to end the span when the response arrives.
     *
     * @param {string} method  JSON-RPC method (e.g. 'tools/call', 'initialize')
     * @param {object} headers Mutable headers object — traceparent is injected
     * @param {object} [attrs] Extra span attributes (e.g. mcp.session.id)
     * @returns {{ end(ok?: boolean): void, spanContext: { traceId, spanId } | null }}
     */
    function startMcpSpan(method, headers, attrs) {
        if (!_ready) {
            // Fallback: no SDK — generate traceparent manually (same as before)
            return _fallbackSpan(headers);
        }

        const { trace, SpanKind, SpanStatusCode, context, propagation } = window.otelApi;
        const span = _tracer.startSpan(`MCP ${method}`, {
            kind: SpanKind.CLIENT,
            attributes: {
                'mcp.method.name': method,
                ...(attrs || {}),
            },
        });

        // Inject W3C traceparent + baggage into headers from the span context
        const ctx = _withIdentityBaggage(trace.setSpan(context.active(), span));
        propagation.inject(ctx, headers);

        const spanCtx = span.spanContext();

        return {
            spanContext: { traceId: spanCtx.traceId, spanId: spanCtx.spanId },
            setAttributes(attrs) {
                if (attrs) Object.entries(attrs).forEach(([k, v]) => span.setAttribute(k, v));
            },
            end(ok = true) {
                if (!ok) span.setStatus({ code: SpanStatusCode.ERROR });
                span.end();
            },
        };
    }

    // Manual traceparent generation — identical to the old mcpClient.js logic.
    // Used as fallback when the OTel SDK fails to initialize.
    let _fallbackTraceId = null;

    function _fallbackSpan(headers) {
        if (!_fallbackTraceId) {
            const arr = new Uint8Array(16);
            crypto.getRandomValues(arr);
            _fallbackTraceId = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
        }
        const spanArr = new Uint8Array(8);
        crypto.getRandomValues(spanArr);
        const spanId = Array.from(spanArr, b => b.toString(16).padStart(2, '0')).join('');
        headers['traceparent'] = `00-${_fallbackTraceId}-${spanId}-01`;
        return {
            spanContext: { traceId: _fallbackTraceId, spanId },
            end() {},
        };
    }

    /**
     * Create a span for an AG-UI agent run, inject traceparent into headers,
     * and return a handle to end the span when the run finishes.
     *
     * @param {object} headers Mutable headers object — traceparent is injected
     * @param {object} [attrs] Extra span attributes (e.g. agui.thread.id, agui.run.id)
     * @returns {{ end(ok?: boolean): void, spanContext: { traceId, spanId } | null, setAttributes(attrs): void }}
     */
    function startAgentRunSpan(headers, attrs) {
        if (!_ready) {
            return _fallbackSpan(headers);
        }

        const { trace, SpanKind, SpanStatusCode, context, propagation } = window.otelApi;
        const span = _tracer.startSpan('agent.run', {
            kind: SpanKind.CLIENT,
            attributes: {
                ...(attrs || {}),
            },
        });

        const ctx = _withIdentityBaggage(trace.setSpan(context.active(), span));
        propagation.inject(ctx, headers);

        const spanCtx = span.spanContext();

        return {
            spanContext: { traceId: spanCtx.traceId, spanId: spanCtx.spanId },
            setAttributes(newAttrs) {
                if (newAttrs) Object.entries(newAttrs).forEach(([k, v]) => span.setAttribute(k, v));
            },
            end(ok = true) {
                if (!ok) span.setStatus({ code: SpanStatusCode.ERROR });
                span.end();
            },
        };
    }

    /** Reset fallback trace-id (called on session invalidation). */
    function resetTrace() {
        _fallbackTraceId = null;
    }

    /** Whether the SDK initialized successfully. */
    function isReady() {
        return _ready;
    }

    /** Return the traceId for the currently active (or most recent fallback) span. */
    function getActiveTraceId() {
        if (_ready && window.otelApi) {
            return window.otelApi.trace?.getActiveSpan?.()?.spanContext?.().traceId ?? _fallbackTraceId;
        }
        return _fallbackTraceId;
    }

    return { startMcpSpan, startAgentRunSpan, resetTrace, isReady, getActiveTraceId, setIdentityBaggage };
})();
