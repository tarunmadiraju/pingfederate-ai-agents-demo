/**
 * Shared instrumentation for the unified `agent.reasoning` span.
 *
 * Both routing paths — LLM (agui/llmRunHandler.js) and keyword
 * (routers/keywordToolRouter.js) — open an `agent.reasoning` span under one
 * shared contract (also emitted by the Trip Planner; rendered by
 * acp-workforce-portal/lib/traceProjector.js). These helpers keep the
 * cross-path attributes and the originating-agent baggage seed in ONE place so
 * the two paths cannot drift.
 */

import { context, propagation } from '@opentelemetry/api';
import config from './config.js';

/**
 * Stamp the path-independent governance attributes on a freshly-opened
 * `agent.reasoning` span:
 *   - gen_ai.operation.name = "invoke_agent"  (OTel GenAI semconv handle; the
 *     operation name itself stays the ACP-local "agent.reasoning" for the portal
 *     trace projection)
 *   - gen_ai.agent.id / gen_ai.agent.name     (stable agent identity, span-local;
 *     joins to the origin_agent.id baggage value)
 *
 * Path-specific attributes (reasoning.mode, reasoning.model, reasoning.candidates,
 * …) are set by the caller — only the shared ones live here.
 *
 * @param {import('@opentelemetry/api').Span} span
 */
export function stampAgentIdentity(span) {
    span.setAttribute('gen_ai.operation.name', 'invoke_agent');
    span.setAttribute('gen_ai.agent.id', config.agent.id);
    span.setAttribute('gen_ai.agent.name', config.agent.name);
}

/**
 * Seed the `origin_agent.id` baggage SET-ONCE on the given context: this agent is
 * the chain originator for portal-initiated runs, so it names the origin only if
 * no upstream already did. A downstream agent never overwrites it. The
 * baggage→attribute SpanProcessor (tracing.cjs) copies it onto every downstream
 * span.
 *
 * @param {import('@opentelemetry/api').Context} [ctx] - defaults to the active context
 * @returns {import('@opentelemetry/api').Context} the context carrying the baggage
 */
export function seedOriginAgentBaggage(ctx = context.active()) {
    let bag = propagation.getBaggage(ctx) || propagation.createBaggage();
    if (!bag.getEntry('origin_agent.id')) {
        bag = bag.setEntry('origin_agent.id', { value: config.agent.id });
        ctx = propagation.setBaggage(ctx, bag);
    }
    return ctx;
}
