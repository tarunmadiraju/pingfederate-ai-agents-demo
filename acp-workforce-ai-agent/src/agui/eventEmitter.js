/**
 * AG-UI Event Emitter.
 *
 * Wraps an Express `Response` and exposes typed `emitXxx()` methods that
 * write SSE-framed AG-UI events using `@ag-ui/encoder`'s `EventEncoder`.
 *
 * Headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`,
 * `Connection: keep-alive`, `X-Accel-Buffering: no`) are written on first
 * emission. A 15s `:keepalive` interval is started automatically so
 * intermediate proxies (PingAccess, Traefik) don't close idle connections
 * during long-running operations like elicitation prompts.
 */

import { EventType } from '@ag-ui/core';
import { EventEncoder } from '@ag-ui/encoder';

/**
 * Default SSE keep-alive interval, matched to the legacy MCP transport.
 */
export const SSE_KEEPALIVE_MS = parseInt(process.env.SSE_KEEPALIVE_MS || '15000', 10);

export class AguiEventEmitter {
    /**
     * @param {import('express').Response} res
     */
    constructor(res) {
        this.res = res;
        this.encoder = new EventEncoder();
        this.headersWritten = false;
        this.keepaliveTimer = null;
        this.closed = false;

        res.on('close', () => {
            this.closed = true;
            this._stopKeepalive();
        });
    }

    /**
     * Write the SSE response headers (idempotent) and start keep-alive.
     */
    _ensureHeaders() {
        if (this.headersWritten || this.closed) return;
        this.headersWritten = true;
        this.res.setHeader('Content-Type', 'text/event-stream');
        this.res.setHeader('Cache-Control', 'no-cache');
        this.res.setHeader('Connection', 'keep-alive');
        // Disable nginx-style proxy buffering so events flush immediately.
        this.res.setHeader('X-Accel-Buffering', 'no');
        if (typeof this.res.flushHeaders === 'function') {
            this.res.flushHeaders();
        }
        this._startKeepalive();
    }

    _startKeepalive() {
        if (this.keepaliveTimer) return;
        this.keepaliveTimer = setInterval(() => {
            if (this.closed || this.res.writableEnded || this.res.destroyed) {
                this._stopKeepalive();
                return;
            }
            try {
                this.res.write(':keepalive\n\n');
            } catch {
                this._stopKeepalive();
            }
        }, SSE_KEEPALIVE_MS);
        // Don't keep the event loop alive solely for this timer (matters in
        // tests / shutdown — the response close handler still clears it).
        if (typeof this.keepaliveTimer.unref === 'function') {
            this.keepaliveTimer.unref();
        }
    }

    _stopKeepalive() {
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
    }

    /**
     * Encode an event and write it to the response.
     * @param {object} event
     */
    _emit(event) {
        if (this.closed) return;
        this._ensureHeaders();
        try {
            this.res.write(this.encoder.encodeSSE(event));
        } catch (err) {
            this.closed = true;
            this._stopKeepalive();
            throw err;
        }
    }

    // ── Lifecycle events ────────────────────────────────────────────────

    emitRunStarted(threadId, runId) {
        this._emit({ type: EventType.RUN_STARTED, threadId, runId });
    }

    /**
     * Emit RUN_FINISHED. Accepts either the legacy positional `result` form
     * for backward compat, or an options object `{ result, outcome }`.
     *
     * `outcome` carries the AG-UI Interrupts payload, e.g.
     *   { type: 'interrupt', interrupts: [{ id, reason, responseSchema, ... }] }
     * See https://docs.ag-ui.com/concepts/interrupts.
     */
    emitRunFinished(threadId, runId, resultOrOptions) {
        const evt = { type: EventType.RUN_FINISHED, threadId, runId };
        if (resultOrOptions !== undefined) {
            if (
                resultOrOptions !== null
                && typeof resultOrOptions === 'object'
                && ('result' in resultOrOptions || 'outcome' in resultOrOptions)
            ) {
                if (resultOrOptions.result !== undefined) evt.result = resultOrOptions.result;
                if (resultOrOptions.outcome !== undefined) evt.outcome = resultOrOptions.outcome;
            } else {
                evt.result = resultOrOptions;
            }
        }
        this._emit(evt);
    }

    emitRunError(message, code) {
        const evt = { type: EventType.RUN_ERROR, message: String(message ?? 'Unknown error') };
        if (code) evt.code = code;
        this._emit(evt);
    }

    // ── Steps ───────────────────────────────────────────────────────────

    emitStepStarted(stepName) {
        this._emit({ type: EventType.STEP_STARTED, stepName });
    }

    emitStepFinished(stepName) {
        this._emit({ type: EventType.STEP_FINISHED, stepName });
    }

    // ── Tool calls ──────────────────────────────────────────────────────

    emitToolCallStart(toolCallId, toolCallName, parentMessageId) {
        const evt = { type: EventType.TOOL_CALL_START, toolCallId, toolCallName };
        if (parentMessageId) evt.parentMessageId = parentMessageId;
        this._emit(evt);
    }

    emitToolCallArgs(toolCallId, delta) {
        this._emit({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta });
    }

    emitToolCallEnd(toolCallId) {
        this._emit({ type: EventType.TOOL_CALL_END, toolCallId });
    }

    emitToolCallResult(messageId, toolCallId, content) {
        this._emit({
            type: EventType.TOOL_CALL_RESULT,
            messageId,
            toolCallId,
            content,
            role: 'tool'
        });
    }

    // ── Text streaming ──────────────────────────────────────────────────

    emitTextMessageStart(messageId, role = 'assistant') {
        this._emit({ type: EventType.TEXT_MESSAGE_START, messageId, role });
    }

    emitTextMessageContent(messageId, delta) {
        this._emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
    }

    emitTextMessageEnd(messageId) {
        this._emit({ type: EventType.TEXT_MESSAGE_END, messageId });
    }

    // ── State ───────────────────────────────────────────────────────────

    emitStateSnapshot(snapshot) {
        this._emit({ type: EventType.STATE_SNAPSHOT, snapshot });
    }

    emitStateDelta(patches) {
        this._emit({ type: EventType.STATE_DELTA, delta: patches });
    }

    // ── Custom ──────────────────────────────────────────────────────────

    emitCustom(name, value) {
        this._emit({ type: EventType.CUSTOM, name, value });
    }

    /**
     * Close the SSE stream cleanly. Safe to call multiple times.
     */
    end() {
        this._stopKeepalive();
        if (this.closed) return;
        this.closed = true;
        try {
            this.res.end();
        } catch {
            // Already closed — nothing to do.
        }
    }
}
