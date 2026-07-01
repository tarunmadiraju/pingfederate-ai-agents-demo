/**
 * AG-UI Interrupt Continuation Store.
 *
 * In-process Map<interruptId, ContinuationCtx> capturing what the agent needs
 * to resume a run after the portal sends a `resume[{ interruptId, status,
 * payload }]` entry on the next RunAgentInput. Backs the Phase 2 migration of
 * MCP-server elicitations from custom events to the AG-UI Interrupts spec
 * (https://docs.ag-ui.com/concepts/interrupts).
 *
 * Entries are single-use: `claim(id)` removes the entry. A wall-clock TTL
 * (default 120s, override via INTERRUPT_TTL_MS) prevents leaks if the
 * portal never resumes — `claim` returns `null` for expired or unknown ids.
 *
 * Auth tokens are NOT cached here. The follow-up RunAgentInput carries fresh
 * tokens, so resume always uses the current bearer.
 *
 * Single-replica only — there is no cross-process persistence. That matches
 * the demo platform's deployment model.
 *
 * @typedef {object} ContinuationCtx
 * @property {string} threadId
 * @property {{ toolName: string, toolArgs: object, serverKey: string }} routed
 * @property {'gather-args' | 'confirm-destructive' | 'url'} kind
 * @property {object} [pendingToolResult]
 * @property {number} expiresAt — Date.now() ms when this entry should be
 *   considered expired. `claim` enforces it.
 */

export const INTERRUPT_TTL_MS = parseInt(process.env.INTERRUPT_TTL_MS || '120000', 10);

/** @type {Map<string, ContinuationCtx>} */
const continuations = new Map();

/**
 * Save a continuation. If `ctx.expiresAt` is missing, a default TTL is
 * applied. Overwrites any prior entry for the same id (callers should use
 * fresh ids per interrupt).
 *
 * @param {string} interruptId
 * @param {Omit<ContinuationCtx, 'expiresAt'> & { expiresAt?: number }} ctx
 */
export function save(interruptId, ctx) {
    if (typeof interruptId !== 'string' || !interruptId) {
        throw new Error('interruptId must be a non-empty string');
    }
    if (!ctx || typeof ctx !== 'object') {
        throw new Error('continuation ctx must be an object');
    }
    const expiresAt = typeof ctx.expiresAt === 'number'
        ? ctx.expiresAt
        : Date.now() + INTERRUPT_TTL_MS;
    continuations.set(interruptId, { ...ctx, expiresAt });
}

/**
 * Atomically take and remove a continuation by id. Returns `null` if the
 * entry is missing, expired, or (when `expectedThreadId` is supplied) the
 * stored threadId does not match. The entry is removed in all cases except
 * a thread mismatch — a mismatched claim is a signal of a misrouted resume,
 * so the entry is preserved for the legitimate thread to claim.
 *
 * @param {string} interruptId
 * @param {{ threadId?: string }} [opts]
 * @returns {ContinuationCtx | null}
 */
export function claim(interruptId, opts = {}) {
    const entry = continuations.get(interruptId);
    if (!entry) return null;
    if (opts.threadId && entry.threadId && entry.threadId !== opts.threadId) {
        // Thread mismatch — refuse the claim and leave the entry in place.
        return null;
    }
    continuations.delete(interruptId);
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
        return null;
    }
    return entry;
}

/**
 * Remove expired entries. Callers can run this opportunistically (e.g. on
 * resume requests) — no background timer is started here so the module has
 * no shutdown surface.
 *
 * @returns {number} count of entries evicted
 */
export function evictExpired() {
    const now = Date.now();
    let evicted = 0;
    for (const [id, entry] of continuations) {
        if (entry.expiresAt && now > entry.expiresAt) {
            continuations.delete(id);
            evicted++;
        }
    }
    return evicted;
}

/** For diagnostics / tests. */
export function size() {
    return continuations.size;
}

/** For tests — wipes all entries. */
export function _reset() {
    continuations.clear();
}
