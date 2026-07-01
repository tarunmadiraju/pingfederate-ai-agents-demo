/**
 * AG-UI run handler for LLM-routing mode.
 *
 * Implements a ReAct loop with token streaming against Ollama's
 * OpenAI-compatible `/v1/chat/completions` endpoint. Each iteration:
 *   1. STEP_STARTED("reasoning") + open POST stream=true
 *   2. As text-content deltas arrive → TEXT_MESSAGE_CONTENT events
 *   3. As tool_call deltas arrive → accumulate args (no streaming
 *      TOOL_CALL_ARGS — Ollama returns them in fragments that aren't
 *      always valid JSON until the call is complete)
 *   4. On finish_reason="tool_calls":
 *        STEP_FINISHED("reasoning")
 *        STEP_STARTED("call <tool>")
 *        TOOL_CALL_START → TOOL_CALL_ARGS (full JSON) → TOOL_CALL_END
 *        callMcpTool() (with optional elicitation suspend/resume)
 *        TOOL_CALL_RESULT
 *        STATE_DELTA appending {runId, view, data} to state.results
 *        STEP_FINISHED
 *      then loop back with assistant + tool messages appended.
 *   5. On finish_reason="stop": close any open text message and exit.
 *
 * Caps iterations at LLM_MAX_ITERATIONS (default 5) to prevent infinite
 * loops when the model can't converge.
 */

import { randomUUID } from 'node:crypto';
import fetch from 'node-fetch';
import { trace, SpanKind, SpanStatusCode, context } from '@opentelemetry/api';
import config from '../config.js';
import { stampAgentIdentity, seedOriginAgentBaggage } from '../agentReasoning.js';
import { dispatch, viewForTool, normalizeAuthError, parseMcpInitError } from './chatExecutor.js';
import { listMcpTools } from '../mcpClient.js';
import { save as saveContinuation, claim as claimContinuation } from './interruptStore.js';
import { InterruptError, isInterruptError } from './interruptError.js';

const tracer = trace.getTracer('acp-workforce-ai-agent');

/**
 * Emit the canonical authorization error event sequence:
 * TOOL_CALL_RESULT (isError:true) + STATE_DELTA /error + CUSTOM ciba.consent_pending
 * + STEP_FINISHED. Shared by both the RESUME PATH and the main LLM loop.
 */
function emitAuthError(emitter, stateManager, msgId, toolCallId, ae, stepName) {
    emitter.emitToolCallResult(msgId, toolCallId, JSON.stringify({
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
    emitter.emitStateDelta(stateManager.setError('authorization_error', ae.message, {
        status: ae.status,
        error: ae.error,
        scope: ae.scope,
        toolName: ae.toolName,
        ciba_txn_id: ae.ciba_txn_id
    }));
    emitter.emitCustom('ciba.consent_pending', ae);
    emitter.emitStepFinished(stepName);
}

const LLM_MAX_ITERATIONS = parseInt(process.env.LLM_MAX_ITERATIONS || '5', 10);

const SYSTEM_PROMPT = `You are a workforce management assistant for Acme Corp.
Given the user's message and available tools, decide whether to call a tool or reply conversationally.
Rules:
- If the user's message clearly maps to one of the available tools, call that tool with the appropriate arguments.
- IMPORTANT: If the user's intent maps to a tool but some required arguments are missing, STILL call the tool with whatever arguments you can extract. Leave missing arguments out — the system will ask the user to fill them in.
- Extract argument values from the user's message when possible.
- For expense IDs, look for patterns like "EXP-2026-001234".
- For cost centers, look for patterns like "FIN-2024-001" or "ENG-2026-001".
- For flight IDs, look for patterns like "FL-101".
- For hotel IDs, look for patterns like "HT-201".
- For booking IDs, look for patterns like "BK-123456".
- If the message does not match any tool (greetings, small talk), reply conversationally.`;

/**
 * Convert MCP tools to OpenAI tool-call schema, stripping the _source tag.
 */
function toOpenAITools(mcpTools) {
    return mcpTools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.inputSchema || { type: 'object', properties: {} }
        }
    }));
}

async function discoverTools(actorToken, subjectToken) {
    const serverKeys = Object.keys(config.mcpServers);
    const all = [];
    const settled = await Promise.allSettled(
        serverKeys.map(async (serverKey) => {
            const sc = config.mcpServers[serverKey];
            const tools = sc.auth
                ? await listMcpTools(serverKey, actorToken, subjectToken)
                : await listMcpTools(serverKey);
            return tools.map(t => ({ ...t, _source: serverKey }));
        })
    );
    for (const r of settled) {
        if (r.status === 'fulfilled') all.push(...r.value);
    }
    return all;
}

/**
 * Stream Ollama's chat completion response. Yields parsed delta objects.
 *
 * Ollama's OpenAI-compat endpoint emits SSE-style `data: {...}\n\n` chunks
 * terminated by `data: [DONE]`.
 */
async function* streamOllama(body, llmConfig) {
    const { ollamaUrl, timeoutMs } = llmConfig;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${ollamaUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, stream: true }),
            signal: controller.signal
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => response.statusText);
            throw new Error(`Ollama error ${response.status}: ${errText}`);
        }

        // node-fetch v3 returns a Web ReadableStream-compatible body.
        let buffer = '';
        for await (const chunk of response.body) {
            buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            let idx;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
                const event = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                for (const line of event.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    if (!data || data === '[DONE]') continue;
                    try {
                        yield JSON.parse(data);
                    } catch {
                        // Ignore malformed chunks.
                    }
                }
            }
        }
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Run the LLM ReAct loop.
 *
 * @param {object} args
 * @param {import('./eventEmitter.js').AguiEventEmitter} args.emitter
 * @param {import('./stateManager.js').AguiStateManager} args.stateManager
 * @param {string} args.threadId
 * @param {string} args.runId
 * @param {Array<object>} args.messages — full RunAgentInput.messages
 * @param {Array<object>} [args.resume] — AG-UI RunAgentInput.resume entries.
 *   When present, the first entry's continuation is claimed from
 *   `interruptStore` and the URL elicitation step that bailed on the previous
 *   run is replayed (dispatched once, then the loop continues).
 * @param {string} args.actorToken
 * @param {string|null} args.subjectToken
 * @returns {Promise<{outcome?: object}|void>}
 */
export async function handleLlmRun({
    emitter,
    stateManager,
    threadId,
    runId,
    messages,
    resume,
    actorToken,
    subjectToken
}) {
    // Open the unified agent.reasoning span (shared contract with the Trip
    // Planner; rendered by acp-workforce-portal/lib/traceProjector.js
    // projectAgentReasoning). reasoning.candidates (the live aggregated MCP
    // catalog) and reasoning.chosen (the tool(s) the LLM picked) are enriched
    // from inside _runLlmLoop via the active span, since they aren't known yet.
    const routerSpan = tracer.startSpan('agent.reasoning', { kind: SpanKind.INTERNAL });
    // Path-independent attributes (gen_ai.operation.name + agent identity) shared
    // with the keyword path; see agentReasoning.js.
    stampAgentIdentity(routerSpan);
    routerSpan.setAttribute('reasoning.mode', 'llm');
    routerSpan.setAttribute('reasoning.model', config.llm.model);

    // Seed origin_agent.id baggage SET-ONCE, then bind the reasoning span so both
    // propagate to the downstream MCP/gateway/API spans.
    let ctx = seedOriginAgentBaggage(context.active());
    ctx = trace.setSpan(ctx, routerSpan);

    try {
        const result = await context.with(ctx, () => _runLlmLoop({
            emitter, stateManager, threadId, runId, messages, resume, actorToken, subjectToken
        }));
        routerSpan.setStatus({ code: SpanStatusCode.OK });
        return result;
    } catch (err) {
        // Interrupts mode: bubble the URL elicitation up as a RUN_FINISHED
        // outcome. The thrown InterruptError is normal control flow, not
        // a span-level error.
        if (isInterruptError(err)) {
            routerSpan.setStatus({ code: SpanStatusCode.OK });
            const { interruptId, reason, message, responseSchema, metadata } = err.descriptor;
            const interrupt = { id: interruptId, reason };
            if (message) interrupt.message = message;
            if (responseSchema) interrupt.responseSchema = responseSchema;
            if (metadata) interrupt.metadata = metadata;
            return { outcome: { type: 'interrupt', interrupts: [interrupt] } };
        }
        routerSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        throw err;
    } finally {
        routerSpan.end();
    }
}

async function _runLlmLoop({
    emitter,
    stateManager,
    threadId,
    runId,
    messages,
    resume,
    actorToken,
    subjectToken
}) {
    // === RESUME PATH ===
    // Replay the URL-elicitation tool dispatch that bailed on the previous run
    // and emit a normal TOOL_CALL_* + STATE_DELTA card. We do not restart the
    // ReAct loop here — the user's next free-form message will trigger a fresh
    // loop. This matches the keyword path: resume yields one tool result.
    if (Array.isArray(resume) && resume.length > 0) {
        const entry = resume[0];
        if (!entry || typeof entry.interruptId !== 'string') {
            throw new Error('resume[0] must include interruptId');
        }
        const continuation = claimContinuation(entry.interruptId, { threadId });
        if (!continuation) {
            throw new Error(`No continuation found for interruptId ${entry.interruptId} (expired, unknown, or thread mismatch)`);
        }
        const status = entry.status || 'cancelled';
        const { toolName, toolArgs, serverKey } = continuation.routed || {};
        if (!toolName || !serverKey) {
            throw new Error(`Continuation for ${entry.interruptId} is missing routed.toolName/serverKey`);
        }

        if (status !== 'resolved') {
            emitter.emitCustom('elicitation.declined', {
                toolName,
                action: 'cancel'
            });
            return;
        }

        const stepName = `call ${toolName}`;
        emitter.emitStepStarted(stepName);
        const toolCallId = randomUUID();
        emitter.emitToolCallStart(toolCallId, toolName);
        emitter.emitToolCallArgs(toolCallId, JSON.stringify(toolArgs || {}));
        emitter.emitToolCallEnd(toolCallId);

        let dispatchResult;
        try {
            dispatchResult = await dispatch(toolName, toolArgs, serverKey, actorToken, subjectToken);
        } catch (err) {
            const ae = parseMcpInitError(err, { toolName }, null, 'llm');
            const msgId = randomUUID();
            if (ae) {
                emitAuthError(emitter, stateManager, msgId, toolCallId, ae.authorizationError, stepName);
            } else {
                emitter.emitToolCallResult(msgId, toolCallId, JSON.stringify({ isError: true, content: [{ type: 'text', text: err.message }] }));
                emitter.emitStepFinished(stepName);
            }
            return;
        }

        const msgId = randomUUID();
        const serverConf = config.mcpServers[serverKey];
        const ae = serverConf?.type === 'local' ? normalizeAuthError(dispatchResult.toolResult, toolName) : null;
        if (ae) {
            emitAuthError(emitter, stateManager, msgId, toolCallId, ae, stepName);
            return;
        }

        emitter.emitToolCallResult(msgId, toolCallId, JSON.stringify(dispatchResult.toolResult || {}));
        const view = viewForTool(toolName);
        emitter.emitStateDelta(stateManager.appendResult(runId, view, {
            message: dispatchResult.message,
            toolUsed: toolName,
            toolResult: dispatchResult.toolResult,
            mcpApp: dispatchResult.mcpApp || null,
            expenses: dispatchResult.expenses || null
        }));
        emitter.emitStepFinished(stepName);
        return;
    }

    const mcpTools = await discoverTools(actorToken, subjectToken);
    const openAITools = toOpenAITools(mcpTools);

    // Publish the selector-truthful candidate space onto the agent.reasoning
    // span: the live aggregated MCP catalog the LLM was actually offered.
    trace.getActiveSpan()?.setAttribute('reasoning.candidates', mcpTools.map(t => t.name));

    // Build the message history. Always prefix our system prompt; honor any
    // user/assistant/tool messages from the client (HttpAgent maintains them).
    const history = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages.map(m => ({
            role: m.role,
            content: m.content ?? '',
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
        }))
    ];

    // Tools the LLM chooses across all ReAct iterations — published onto the
    // agent.reasoning span as reasoning.chosen (the keyword path sets a 1-elem
    // list; the LLM path may pick several across the loop).
    const chosenTools = [];

    for (let iteration = 0; iteration < LLM_MAX_ITERATIONS; iteration++) {
        emitter.emitStepStarted('reasoning');

        const body = {
            model: config.llm.model,
            messages: history,
            tools: openAITools.length ? openAITools : undefined,
            tool_choice: openAITools.length ? 'auto' : undefined,
            temperature: 0,
            // REQUIRED for Ollama to report token usage on a streamed response —
            // without it no usage block is ever sent. Usage arrives in the final
            // SSE chunk, which has an empty choices[] (handled below).
            stream_options: { include_usage: true }
        };

        let activeMessageId = null;
        let assistantContent = '';
        const toolCallAccum = new Map(); // index → { id, name, argsBuf }
        let finishReason = null;

        // gen_ai.chat — one model-invocation span per Ollama call (per ReAct
        // iteration). Carries model identity + token usage (semconv gen_ai.*).
        const chatSpan = tracer.startSpan('gen_ai.chat', {
            kind: SpanKind.CLIENT,
            attributes: {
                'gen_ai.operation.name': 'chat',
                'gen_ai.request.model': config.llm.model
            }
        });
        let usage = null;
        let responseModel = null;

        try {
            for await (const chunk of streamOllama(body, config.llm)) {
                // The terminal usage chunk has an empty choices[]; capture usage
                // and the responding model before the no-choice guard.
                if (chunk.usage) usage = chunk.usage;
                if (chunk.model) responseModel = chunk.model;
                const choice = chunk.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta || {};

                // Text content streaming.
                if (typeof delta.content === 'string' && delta.content.length > 0) {
                    if (!activeMessageId) {
                        activeMessageId = randomUUID();
                        emitter.emitTextMessageStart(activeMessageId, 'assistant');
                    }
                    assistantContent += delta.content;
                    emitter.emitTextMessageContent(activeMessageId, delta.content);
                }

                // Tool call deltas — accumulate but don't emit per-fragment.
                if (Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        const cur = toolCallAccum.get(idx) || { id: null, name: '', argsBuf: '' };
                        if (tc.id) cur.id = tc.id;
                        if (tc.function?.name) cur.name += tc.function.name;
                        if (tc.function?.arguments) cur.argsBuf += tc.function.arguments;
                        toolCallAccum.set(idx, cur);
                    }
                }

                if (choice.finish_reason) {
                    finishReason = choice.finish_reason;
                }
            }
        } catch (err) {
            chatSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            chatSpan.end();
            // Close any open text message before propagating (keeps event sequence valid).
            if (activeMessageId) emitter.emitTextMessageEnd(activeMessageId);
            emitter.emitStepFinished('reasoning');
            throw err;
        }

        // Finalize the model-invocation span: stamp usage + responding model.
        if (responseModel) chatSpan.setAttribute('gen_ai.response.model', responseModel);
        if (usage) {
            if (typeof usage.prompt_tokens === 'number') {
                chatSpan.setAttribute('gen_ai.usage.input_tokens', usage.prompt_tokens);
            }
            if (typeof usage.completion_tokens === 'number') {
                chatSpan.setAttribute('gen_ai.usage.output_tokens', usage.completion_tokens);
            }
        }
        if (finishReason) chatSpan.setAttribute('gen_ai.response.finish_reasons', [finishReason]);
        chatSpan.setStatus({ code: SpanStatusCode.OK });
        chatSpan.end();

        // === finish_reason: stop → close out and exit ===
        if (finishReason === 'stop' || finishReason === 'length' || finishReason === null) {
            if (activeMessageId) {
                emitter.emitTextMessageEnd(activeMessageId);
            }
            emitter.emitStepFinished('reasoning');
            return;
        }

        // === finish_reason: tool_calls → execute each tool, observe, loop ===
        if (finishReason === 'tool_calls') {
            if (activeMessageId) {
                emitter.emitTextMessageEnd(activeMessageId);
            }
            emitter.emitStepFinished('reasoning');

            // Append the assistant turn so future iterations see it.
            const assistantToolCalls = Array.from(toolCallAccum.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([, v]) => ({
                    id: v.id || randomUUID(),
                    type: 'function',
                    function: { name: v.name, arguments: v.argsBuf || '{}' }
                }));
            history.push({
                role: 'assistant',
                content: assistantContent || null,
                tool_calls: assistantToolCalls
            });

            for (const c of assistantToolCalls) chosenTools.push(c.function.name);
            trace.getActiveSpan()?.setAttribute('reasoning.chosen', [...chosenTools]);

            for (const call of assistantToolCalls) {
                const toolName = call.function.name;
                let toolArgs = {};
                try {
                    toolArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
                } catch (err) {
                    console.warn(`[LLMRun] Failed to parse tool args for ${toolName}: ${err.message}`);
                }

                const matched = mcpTools.find(t => t.name === toolName);
                const serverKey = matched?._source || Object.keys(config.mcpServers)[0];

                const stepName = `call ${toolName}`;
                emitter.emitStepStarted(stepName);
                emitter.emitToolCallStart(call.id, toolName);
                emitter.emitToolCallArgs(call.id, call.function.arguments || '{}');
                emitter.emitToolCallEnd(call.id);

                // Execute via dispatch (handles tool-specific result formatting).
                let dispatchResult;
                try {
                    dispatchResult = await dispatch(toolName, toolArgs, serverKey, actorToken, subjectToken);
                } catch (err) {
                    const ae = parseMcpInitError(err, { toolName }, null, 'llm');
                    const msgId = randomUUID();
                    if (ae) {
                        emitAuthError(emitter, stateManager, msgId, call.id, ae.authorizationError, stepName);
                    } else {
                        emitter.emitToolCallResult(msgId, call.id, JSON.stringify({ isError: true, content: [{ type: 'text', text: err.message }] }));
                        emitter.emitStepFinished(stepName);
                        history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: err.message }) });
                    }
                    return;
                }

                // === URL elicitation (OAuth delegation) — surfaced as Interrupt.
                if (
                    dispatchResult.toolResult?.elicitation_required
                    && dispatchResult.toolResult?.connect_url
                ) {
                    const interruptId = randomUUID();
                    const mcpElicitationId = dispatchResult.toolResult.elicitation_id || null;
                    const descriptor = {
                        interruptId,
                        kind: 'url',
                        reason: 'mcp:elicitation:url',
                        message: dispatchResult.toolResult.message || 'Authorization required.',
                        metadata: {
                            mode: 'url',
                            url: dispatchResult.toolResult.connect_url,
                            requestingServer: { name: serverKey },
                            ...(mcpElicitationId ? { mcpElicitationId } : {})
                        }
                    };
                    const continuation = {
                        routed: { toolName, toolArgs, serverKey },
                        kind: 'url',
                        pendingToolResult: dispatchResult.toolResult
                    };
                    saveContinuation(interruptId, {
                        threadId,
                        routed: continuation.routed,
                        kind: continuation.kind,
                        pendingToolResult: continuation.pendingToolResult
                    });
                    emitter.emitStepFinished(stepName);
                    throw new InterruptError({ descriptor, continuation });
                }

                // === CIBA / authorization error path ===
                const msgId = randomUUID();
                const serverConf = config.mcpServers[serverKey];
                const ae = serverConf?.type === 'local' ? normalizeAuthError(dispatchResult.toolResult, toolName) : null;
                if (ae) {
                    emitAuthError(emitter, stateManager, msgId, call.id, ae, stepName);
                    return;
                }

                const view = viewForTool(toolName);
                const cardData = {
                    message: dispatchResult.message,
                    toolUsed: toolName,
                    toolResult: dispatchResult.toolResult,
                    mcpApp: dispatchResult.mcpApp || null,
                    expenses: dispatchResult.expenses || null
                };
                emitter.emitStateDelta(stateManager.appendResult(runId, view, cardData));
                emitter.emitStepFinished(stepName);

                history.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: JSON.stringify(dispatchResult.toolResult || {})
                });
            }

            // Continue to next iteration so the model can observe tool results.
            continue;
        }

        // Unknown finish reason — close out as a defensive measure.
        if (activeMessageId) {
            emitter.emitTextMessageEnd(activeMessageId);
        }
        emitter.emitStepFinished('reasoning');
        return;
    }

    // Iteration cap hit — surface as RUN_ERROR via thrown error.
    throw new Error(`LLM exceeded max iterations (${LLM_MAX_ITERATIONS})`);
}
