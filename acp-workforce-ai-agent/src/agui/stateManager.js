/**
 * AG-UI State Manager.
 *
 * Maintains the per-run shared state object emitted via STATE_SNAPSHOT and
 * mutated via RFC 6902 JSON Patch operations emitted as STATE_DELTA.
 *
 * State shape:
 *   {
 *     results: [{ runId, view, data }, ...],
 *     error: { type, message, ... } | null
 *   }
 *
 * `results[]` is an append-only history of card-renderable tool results.
 * `error` is set on authorization errors and cleared on the next run.
 *
 * Patch generation is plain JS — no JSON Patch dependency. Patches are
 * applied to the internal state synchronously so future deltas observe the
 * latest values.
 */

function emptyState() {
    return {
        results: [],
        error: null
    };
}

export class AguiStateManager {
    /**
     * @param {object} [initialState] — optional state to hydrate from prior runs
     */
    constructor(initialState) {
        this.state = initialState ? { ...emptyState(), ...initialState } : emptyState();
        // Defensive copy of nested arrays/objects so callers can't mutate ours.
        this.state.results = Array.isArray(this.state.results) ? [...this.state.results] : [];
        // Always clear error at the start of a new run — error is run-scoped.
        this.state.error = null;
    }

    /**
     * Return the full state snapshot for STATE_SNAPSHOT.
     */
    snapshot() {
        return JSON.parse(JSON.stringify(this.state));
    }

    /**
     * Append a tool result to results[] and return the RFC 6902 patch.
     *
     * @param {string} runId
     * @param {string} view  — structuredContent.type from the tool dispatch
     * @param {object} data  — raw tool result payload
     * @returns {Array<object>} JSON Patch operations
     */
    appendResult(runId, view, data) {
        const entry = { runId, view, data };
        this.state.results.push(entry);
        return [{ op: 'add', path: '/results/-', value: entry }];
    }

    /**
     * Set state.error (authorization error, run failure, etc.).
     * @param {string} type
     * @param {string} message
     * @param {object} [extra] — additional fields merged into the error object
     */
    setError(type, message, extra = {}) {
        const value = { type, message, ...extra };
        this.state.error = value;
        return [{ op: 'replace', path: '/error', value }];
    }

    clearError() {
        this.state.error = null;
        return [{ op: 'replace', path: '/error', value: null }];
    }
}
