/**
 * Sentinel thrown by elicitation callbacks when running in AG-UI Interrupts
 * mode. Carries everything `runHandler` needs to:
 *   1. save a continuation to interruptStore, and
 *   2. emit RUN_FINISHED { outcome: { type: 'interrupt', interrupts: [...] } }
 *
 * Throwing instead of returning lets us bail out of `executeChat()` cleanly
 * without restructuring the elicitation control flow into explicit returns
 * at every site. The catch site re-shapes this into the wire payload.
 *
 * @typedef {object} InterruptDescriptor
 * @property {string} interruptId
 * @property {'gather-args'|'confirm-destructive'|'url'} kind
 * @property {string} reason — namespaced AG-UI `interrupts[].reason`
 *   (e.g. `mcp:elicitation:gather-args`)
 * @property {string} [message] — human-readable prompt for the user
 * @property {object} [responseSchema] — JSON Schema for the expected resume payload
 * @property {object} [metadata] — opaque hint payload
 *   (mode, url, requestingServer, mcpElicitationId, schema, …)
 *
 * @typedef {object} InterruptContinuation
 * @property {{ toolName: string, toolArgs: object, serverKey: string }} routed
 * @property {'gather-args'|'confirm-destructive'|'url'} kind
 * @property {object} [pendingToolResult]
 */

export class InterruptError extends Error {
    /**
     * @param {{ descriptor: InterruptDescriptor, continuation: InterruptContinuation }} args
     */
    constructor({ descriptor, continuation }) {
        super(`AG-UI interrupt: ${descriptor.kind} (${descriptor.interruptId})`);
        this.name = 'InterruptError';
        this.descriptor = descriptor;
        this.continuation = continuation;
    }
}

export function isInterruptError(err) {
    return !!(err && err.name === 'InterruptError' && err.descriptor && err.continuation);
}
