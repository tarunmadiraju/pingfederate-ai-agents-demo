/**
 * AG-UI run handler entry point.
 *
 * Mounted at `POST /api/agent/run`. Validates the inbound RunAgentInput,
 * extracts auth tokens, opens the AG-UI SSE stream, and delegates to the
 * keyword or LLM run handler based on the active routing mode.
 *
 * Active runs are tracked in `activeRuns` so the health endpoint can report
 * an in-flight count.
 */

import { randomUUID } from 'node:crypto';
import { AguiEventEmitter } from './eventEmitter.js';
import { AguiStateManager } from './stateManager.js';
import { extractAuth } from './auth.js';
import { handleKeywordRun } from './keywordRunHandler.js';
import { handleLlmRun } from './llmRunHandler.js';
import { handleModeCommand } from '../routerState.js';
import { routerState } from '../routerState.js';

/**
 * In-flight run counter (id → start ts). Used by /api/health.
 * @type {Map<string, number>}
 */
export const activeRuns = new Map();

/**
 * Pull the latest user message text from a list of AG-UI messages.
 * Returns the empty string if no user message is found.
 */
function latestUserMessage(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role === 'user' && typeof m.content === 'string') {
            return m.content;
        }
    }
    return '';
}

/**
 * Express handler for POST /api/agent/run.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function runHandler(req, res) {
    const body = req.body || {};
    const { threadId, runId, messages, state: priorState, resume } = body;

    if (typeof threadId !== 'string' || !threadId) {
        return res.status(400).json({ error: 'threadId is required' });
    }
    if (typeof runId !== 'string' || !runId) {
        return res.status(400).json({ error: 'runId is required' });
    }
    if (!Array.isArray(messages)) {
        return res.status(400).json({ error: 'messages must be an array' });
    }
    if (resume !== undefined && !Array.isArray(resume)) {
        return res.status(400).json({ error: 'resume must be an array when present' });
    }

    const auth = extractAuth(req);
    if (!auth) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const emitter = new AguiEventEmitter(res);
    const stateManager = new AguiStateManager(priorState);

    activeRuns.set(runId, Date.now());

    try {
        emitter.emitRunStarted(threadId, runId);
        emitter.emitStateSnapshot(stateManager.snapshot());

        const userMessage = latestUserMessage(messages);

        // /mode commands are intercepted here so they work regardless of which
        // handler is active (keyword or LLM).
        const modeResponse = handleModeCommand(userMessage);
        if (modeResponse) {
            const msgId = randomUUID();
            emitter.emitStepStarted('routing');
            emitter.emitStepFinished('routing');
            emitter.emitTextMessageStart(msgId, 'assistant');
            emitter.emitTextMessageContent(msgId, modeResponse.message);
            emitter.emitTextMessageEnd(msgId);
            emitter.emitRunFinished(threadId, runId);
            return;
        }

        let runResult;
        if (routerState.mode === 'llm') {
            runResult = await handleLlmRun({
                emitter,
                stateManager,
                threadId,
                runId,
                messages,
                resume,
                actorToken: auth.actorToken,
                subjectToken: auth.subjectToken
            });
        } else {
            runResult = await handleKeywordRun({
                emitter,
                stateManager,
                threadId,
                runId,
                userMessage,
                resume,
                actorToken: auth.actorToken,
                subjectToken: auth.subjectToken
            });
        }

        if (runResult && runResult.outcome) {
            emitter.emitRunFinished(threadId, runId, { outcome: runResult.outcome });
        } else {
            emitter.emitRunFinished(threadId, runId);
        }
    } catch (err) {
        console.error('[AG-UI] Run failed:', err);
        try {
            emitter.emitRunError(err.message || 'Run failed');
        } catch (emitErr) {
            console.error('[AG-UI] Failed to emit RUN_ERROR:', emitErr);
        }
    } finally {
        activeRuns.delete(runId);
        emitter.end();
    }
}
