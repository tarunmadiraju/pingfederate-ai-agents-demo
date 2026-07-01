/**
 * AG-UI run handler for keyword-routing mode.
 *
 * Wraps `executeChat()` from chatExecutor in AG-UI lifecycle events. No
 * `TEXT_MESSAGE_*` events are emitted in this mode — the keyword router
 * returns structured data only.
 *
 * MCP-server elicitations bubble out as AG-UI Interrupts: the callback
 * throws an `InterruptError`, which we catch and translate into
 * `RUN_FINISHED { outcome: { type: 'interrupt', interrupts: [...] } }`.
 * A continuation is saved keyed by the interruptId; the portal resumes
 * by POSTing `/api/agent/run` with `resume: [{ interruptId, status,
 * payload }]` on the next turn.
 *
 * Spec: https://docs.ag-ui.com/concepts/interrupts
 */

import { randomUUID } from 'node:crypto';
import { context } from '@opentelemetry/api';
import { executeChat, viewForTool } from './chatExecutor.js';
import { seedOriginAgentBaggage } from '../agentReasoning.js';
import { save as saveContinuation, claim as claimContinuation } from './interruptStore.js';
import { InterruptError, isInterruptError } from './interruptError.js';

/**
 * Build a portal-friendly `interrupts[]` descriptor from an elicitation
 * callback request. Field shape matches the AG-UI Interrupts spec:
 * `id`, `reason`, optional `message`, `responseSchema`, `metadata`.
 * `reason` is namespaced as `mcp:elicitation:<kind>`.
 */
function buildInterruptDescriptor({ kind, params, routed, pendingToolResult }) {
    const interruptId = randomUUID();
    const reason = `mcp:elicitation:${kind}`;
    const responseSchema = kind === 'url'
        ? null
        : (params.requestedSchema || { type: 'object', properties: {} });
    const message = params.message || params.url || '';
    const mcpElicitationId = pendingToolResult?.elicitation_id || null;
    return {
        interruptId,
        kind,
        reason,
        message,
        responseSchema,
        metadata: {
            mode: params.mode || (kind === 'url' ? 'url' : 'form'),
            url: params.url || null,
            schema: params.requestedSchema || null,
            requestingServer: params.requestingServer || { name: routed?.serverKey || 'workforce-ai-agent' },
            ...(mcpElicitationId ? { mcpElicitationId } : {})
        },
        // continuation context is internal — strip before emitting
        _continuation: {
            routed: routed ? { toolName: routed.toolName, toolArgs: routed.toolArgs, serverKey: routed.serverKey } : null,
            kind,
            pendingToolResult: pendingToolResult || null
        }
    };
}

/**
 * Translate a saved continuation + a single resume entry into the args
 * `executeChat` needs to skip ahead.
 */
function buildResumeArgs(continuation, resumeEntry) {
    const status = resumeEntry.status || 'cancelled';
    if (status !== 'resolved') {
        // The portal already declined/cancelled; surface that to executeChat
        // by feeding a non-accept resume so the elicitation site short-circuits
        // through its existing decline path. We do this by NOT setting
        // resumeContext (so the site re-prompts) — but if the user truly
        // cancelled we shouldn't re-prompt. Map decline/cancel by aborting
        // immediately in the handler instead.
        return null;
    }
    return {
        presentRouted: continuation.routed,
        resumeContext: {
            kind: continuation.kind,
            content: resumeEntry.payload || {}
        }
    };
}

/**
 * @param {object} args
 * @param {import('./eventEmitter.js').AguiEventEmitter} args.emitter
 * @param {import('./stateManager.js').AguiStateManager} args.stateManager
 * @param {string} args.threadId
 * @param {string} args.runId
 * @param {string} args.userMessage
 * @param {Array<object>} [args.resume] — AG-UI RunAgentInput.resume entries.
 * @param {string} args.actorToken
 * @param {string|null} args.subjectToken
 * @returns {Promise<{outcome?: object}|void>}
 */
export async function handleKeywordRun({
    emitter,
    stateManager,
    threadId,
    runId,
    userMessage,
    resume,
    actorToken,
    subjectToken
}) {
    emitter.emitStepStarted('routing');

    // === RESUME PATH ===
    let presentRouted = null;
    let resumeContext = null;
    if (Array.isArray(resume) && resume.length > 0) {
        // We only handle one outstanding interrupt per run.
        const entry = resume[0];
        if (!entry || typeof entry.interruptId !== 'string') {
            emitter.emitStepFinished('routing');
            throw new Error('resume[0] must include interruptId');
        }
        const continuation = claimContinuation(entry.interruptId, { threadId });
        if (!continuation) {
            emitter.emitStepFinished('routing');
            throw new Error(`No continuation found for interruptId ${entry.interruptId} (expired, unknown, or thread mismatch)`);
        }
        const status = entry.status || 'cancelled';
        if (status !== 'resolved') {
            // Portal explicitly cancelled/declined — finish the run cleanly.
            emitter.emitCustom('elicitation.declined', {
                toolName: continuation.routed?.toolName,
                action: 'cancel'
            });
            emitter.emitStepFinished('routing');
            return;
        }
        const resumed = buildResumeArgs(continuation, entry);
        presentRouted = resumed.presentRouted;
        resumeContext = resumed.resumeContext;
        console.log(`[KeywordRun] Resuming interrupt ${entry.interruptId} (kind=${continuation.kind}, tool=${presentRouted?.toolName})`);
    }

    const onElicitationRequest = async (req) => {
        const descriptor = buildInterruptDescriptor(req);
        const continuation = descriptor._continuation;
        const interruptId = descriptor.interruptId;
        saveContinuation(interruptId, {
            threadId,
            routed: continuation.routed,
            kind: continuation.kind,
            pendingToolResult: continuation.pendingToolResult
        });
        // Strip private hint before the descriptor is shaped for the wire.
        delete descriptor._continuation;
        throw new InterruptError({ descriptor, continuation });
    };

    let routingFinished = false;
    let toolStepName = null;
    try {
        // Seed origin_agent.id baggage SET-ONCE and run the whole keyword flow
        // under it, so the agent.reasoning span (opened inside executeChat) and
        // every downstream MCP/gateway/API span inherit it. Mirrors the LLM path.
        const ctx = seedOriginAgentBaggage(context.active());
        const result = await context.with(ctx, () => executeChat({
            message: userMessage,
            conversationId: threadId,
            actorToken,
            subjectToken,
            onElicitationRequest,
            presentRouted,
            resumeContext
        }));

        // STEP_FINISHED for routing as soon as we have a routing decision.
        emitter.emitStepFinished('routing');
        routingFinished = true;

        // === ELICITATION DECLINED ===
        if (result.type === 'elicitation_declined') {
            emitter.emitCustom('elicitation.declined', {
                toolName: result.toolUsed,
                action: result.elicitation?.action || 'cancel'
            });
            return;
        }

        // === GREETING / TEXT / MODE RESPONSE — no tool, no card ===
        if (!result.toolUsed) {
            const messageId = randomUUID();
            emitter.emitTextMessageStart(messageId, 'assistant');
            emitter.emitTextMessageContent(messageId, result.message || '');
            emitter.emitTextMessageEnd(messageId);
            return;
        }

        // === TOOL EXECUTION (already done inside executeChat) ===
        const toolCallId = randomUUID();
        const stepName = `call ${result.toolUsed}`;
        toolStepName = stepName;
        emitter.emitStepStarted(stepName);
        emitter.emitToolCallStart(toolCallId, result.toolUsed);
        emitter.emitToolCallArgs(toolCallId, JSON.stringify(result.routed?.toolArgs || {}));
        emitter.emitToolCallEnd(toolCallId);

        // === AUTHORIZATION ERROR (CIBA / insufficient_scope / delegation_required) ===
        if (result.authorizationError) {
            const messageId = randomUUID();
            const ae = result.authorizationError;
            // Emit a spec-native TOOL_CALL_RESULT with isError:true so the portal
            // can render via formatCallToolResult() rather than a custom STATE_DELTA path.
            emitter.emitToolCallResult(messageId, toolCallId, JSON.stringify({
                isError: true,
                content: [{ type: 'text', text: ae.message || 'Authorization error' }],
                structuredContent: {
                    type: 'authorization_error',
                    error: ae.error,
                    message: ae.message,
                    scope: ae.scope || null,
                    toolName: ae.toolName || null,
                    ciba_txn_id: ae.ciba_txn_id || null
                }
            }));
            // Keep STATE_DELTA for state persistence (other readers / page reload).
            emitter.emitStateDelta(stateManager.setError('authorization_error', ae.message, {
                status: ae.status,
                error: ae.error,
                scope: ae.scope,
                toolName: ae.toolName,
                ciba_txn_id: ae.ciba_txn_id
            }));
            emitter.emitCustom('ciba.consent_pending', ae);
            emitter.emitStepFinished(stepName);
            return;
        }

        // === NORMAL TOOL RESULT ===
        const messageId = randomUUID();
        emitter.emitToolCallResult(messageId, toolCallId, JSON.stringify(result.toolResult || {}));

        const view = viewForTool(result.toolUsed);
        const cardData = {
            message: result.message,
            toolUsed: result.toolUsed,
            toolResult: result.toolResult,
            mcpApp: result.mcpApp || null,
            expenses: result.expenses || null
        };
        emitter.emitStateDelta(stateManager.appendResult(runId, view, cardData));
        emitter.emitStepFinished(stepName);
    } catch (err) {
        // === Interrupts mode — surface as RUN_FINISHED.outcome ===
        if (isInterruptError(err)) {
            // routing step is still open; close it cleanly.
            if (!routingFinished) {
                try { emitter.emitStepFinished('routing'); } catch { /* swallow */ }
                routingFinished = true;
            }
            const { interruptId, reason, message, responseSchema, metadata } = err.descriptor;
            const interrupt = { id: interruptId, reason };
            if (message) interrupt.message = message;
            if (responseSchema) interrupt.responseSchema = responseSchema;
            if (metadata) interrupt.metadata = metadata;
            return { outcome: { type: 'interrupt', interrupts: [interrupt] } };
        }

        if (!routingFinished) {
            try { emitter.emitStepFinished('routing'); } catch { /* swallow */ }
        } else if (toolStepName) {
            try { emitter.emitStepFinished(toolStepName); } catch { /* swallow */ }
        }
        throw err;
    }
}
