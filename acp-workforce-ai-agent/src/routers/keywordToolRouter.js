/**
 * Keyword Tool Router
 *
 * Routes user messages to MCP tools using keyword matching.
 * This is the original routing strategy — simple, deterministic,
 * zero external dependencies.
 *
 * Interface: route(message) → { toolName, toolArgs, serverKey } | null
 *
 * Returns null when no keywords match (caller shows default greeting).
 * Does NOT call MCP tools — only resolves intent to { toolName, toolArgs, serverKey }.
 *
 * Keyword-matched tools are dispatched to either "expense-mcp" or "travel-mcp" server.
 */

import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { stampAgentIdentity } from '../agentReasoning.js';

// =============================================================================
// OTel tracer — initialized at module scope; SDK is loaded before this module
// runs via NODE_OPTIONS: "--require ./src/tracing.cjs"
// =============================================================================
const tracer = trace.getTracer('acp-workforce-ai-agent');

const EXPENSE_SERVER = 'expense-mcp';
const TRAVEL_SERVER = 'travel-mcp';

// Selector-truthful candidate space for the keyword path: the set of MCP tools
// the keyword rules below can actually emit. Unlike the LLM path (which weighs
// the live aggregated MCP catalog it fetched), the keyword router never queries
// a catalog — its choice space is exactly this fixed list, so we publish it as
// `reasoning.candidates` with no network round-trip. See the agent.reasoning
// span contract (mirrored by the Trip Planner and rendered by
// acp-workforce-portal/lib/traceProjector.js projectAgentReasoning).
const KEYWORD_TOOL_CATALOG = [
    'list_expenses',
    'submit_expense',
    'list_pending_approvals',
    'search_flights',
    'book_flight',
    'search_hotels',
    'book_hotel',
    'get_itinerary',
    'get_booking',
    'get_financial_report',
    'get_budget_summary',
];

/**
 * Extract an expense ID (e.g. "EXP-2026-001237") from a message.
 */
function extractExpenseId(message) {
    const match = message.match(/EXP-\d{4}-\d{4,}/i);
    return match ? match[0].toUpperCase() : null;
}

/**
 * Extract a cost center (e.g. "FIN-2026-001") from a message.
 */
function extractCostCenter(message) {
    const match = message.match(/([A-Z]{2,4}-\d{2,4}(?:-\d{1,4})?)/i);
    return match ? match[1].toUpperCase() : null;
}

/**
 * Extract a booking ID (e.g. "BK-123456") from a message.
 */
function extractBookingId(message) {
    const match = message.match(/BK-\d{4,}/i);
    return match ? match[0].toUpperCase() : null;
}

/**
 * Pure keyword-matching decision — no telemetry side effects.
 *
 * @param {string} message - The raw user message
 * @returns {{ routed: ({ toolName: string, toolArgs: object, serverKey: string } | null), rule: string }}
 *   `routed` is the matched tool (or null when nothing matched); `rule` is the
 *   matched rule name (the keyword path's "why" detail), 'no_match' when none.
 */
function _decide(message) {
    const lower = message.toLowerCase();

    // === EXPENSE TOOLS ===

    if (lower.includes('submit')) {
        const expenseId = extractExpenseId(message);
        if (!expenseId) {
            // Special case: we know the intent but lack a required argument.
            // Return a sentinel so the caller can prompt the user.
            return { routed: { toolName: 'submit_expense', toolArgs: { _missingId: true }, serverKey: EXPENSE_SERVER }, rule: 'submit' };
        }
        return { routed: { toolName: 'submit_expense', toolArgs: { expense_id: expenseId }, serverKey: EXPENSE_SERVER }, rule: 'submit' };
    }

    if (lower.includes('draft')) {
        return { routed: { toolName: 'list_expenses', toolArgs: { status: 'draft' }, serverKey: EXPENSE_SERVER }, rule: 'draft' };
    }

    if (lower.includes('recent')) {
        return { routed: { toolName: 'list_expenses', toolArgs: { status: 'submitted' }, serverKey: EXPENSE_SERVER }, rule: 'recent' };
    }

    if (lower.includes('approval')) {
        return { routed: { toolName: 'list_pending_approvals', toolArgs: {}, serverKey: EXPENSE_SERVER }, rule: 'approval' };
    }

    // === TRAVEL TOOLS ===

    if (lower.includes('flight') || lower.includes('fly')) {
        // "book flight FL-xxx" vs "search flights from X to Y"
        const flightIdMatch = message.match(/FL-\d{3,}/i);
        if (lower.includes('book') && flightIdMatch) {
            return { routed: { toolName: 'book_flight', toolArgs: { flight_id: flightIdMatch[0].toUpperCase() }, serverKey: TRAVEL_SERVER }, rule: 'flight_book' };
        }
        // Default: search flights — extract origin/destination from "from X to Y" pattern
        const routeMatch = message.match(/from\s+(\w+)\s+to\s+(\w+)/i);
        const origin = routeMatch ? routeMatch[1] : '';
        const destination = routeMatch ? routeMatch[2] : '';
        return { routed: { toolName: 'search_flights', toolArgs: { origin, destination }, serverKey: TRAVEL_SERVER }, rule: 'flight_search' };
    }

    if (lower.includes('hotel')) {
        // "book hotel HT-xxx" vs "search hotels in City"
        const hotelIdMatch = message.match(/HT-\d{3,}/i);
        if (lower.includes('book') && hotelIdMatch) {
            return { routed: { toolName: 'book_hotel', toolArgs: { hotel_id: hotelIdMatch[0].toUpperCase() }, serverKey: TRAVEL_SERVER }, rule: 'hotel_book' };
        }
        // Default: search hotels — extract city from "in City" pattern
        const cityMatch = message.match(/in\s+(\w+)/i);
        const city = cityMatch ? cityMatch[1] : '';
        return { routed: { toolName: 'search_hotels', toolArgs: { city }, serverKey: TRAVEL_SERVER }, rule: 'hotel_search' };
    }

    if (lower.includes('trip')) {
        return { routed: { toolName: '_redirect_trip_planner', toolArgs: {}, serverKey: null }, rule: 'trip_planner_redirect' };
    }

    if (lower.includes('itinerary')) {
        return { routed: { toolName: 'get_itinerary', toolArgs: {}, serverKey: TRAVEL_SERVER }, rule: 'itinerary' };
    }

    if (lower.includes('booking')) {
        const bookingId = extractBookingId(message);
        if (bookingId) {
            return { routed: { toolName: 'get_booking', toolArgs: { booking_id: bookingId }, serverKey: TRAVEL_SERVER }, rule: 'booking_id' };
        }
        // No booking ID — show itinerary (all bookings)
        return { routed: { toolName: 'get_itinerary', toolArgs: {}, serverKey: TRAVEL_SERVER }, rule: 'booking_generic' };
    }

    if (lower.includes('travel')) {
        // Generic "travel" keyword — show itinerary overview
        return { routed: { toolName: 'get_itinerary', toolArgs: {}, serverKey: TRAVEL_SERVER }, rule: 'travel_generic' };
    }

    // === FINANCIAL REPORT TOOLS (checked before broad expense keywords) ===

    if (lower.includes('financial report') || lower.includes('analytic') || lower.includes('burn rate') || lower.includes('projection')) {
        const costCenter = extractCostCenter(message) || 'FIN-2026-001';
        return { routed: { toolName: 'get_financial_report', toolArgs: { cost_center: costCenter }, serverKey: EXPENSE_SERVER }, rule: 'financial_report' };
    }

    // === BUDGET TOOLS (checked before broad expense keywords) ===

    if (lower.includes('budget') || lower.includes('department')) {
        return {
            routed: { toolName: 'get_budget_summary', toolArgs: { cost_center: extractCostCenter(message) || 'FIN-2026-001' }, serverKey: EXPENSE_SERVER },
            rule: 'budget'
        };
    }

    // === EXPENSE TOOLS (broad catch-all — checked last) ===

    if (lower.includes('pending') || lower.includes('show') || lower.includes('list') || lower.includes('expense')) {
        return { routed: { toolName: 'list_expenses', toolArgs: { department: 'all' }, serverKey: EXPENSE_SERVER }, rule: 'expense_broad' };
    }

    // No keyword match
    return { routed: null, rule: 'no_match' };
}

/**
 * Route a user message to an MCP tool using keyword matching.
 *
 * Emits the unified `agent.reasoning` span (shared contract with the Trip
 * Planner; rendered by acp-workforce-portal/lib/traceProjector.js
 * projectAgentReasoning). Attributes:
 *   reasoning.mode       = 'keyword'
 *   reasoning.candidates = KEYWORD_TOOL_CATALOG (selector-truthful choice space)
 *   reasoning.chosen     = the matched tool name (omitted when no match)
 *   reasoning.rule       = the matched rule name (keyword-only "why" detail)
 *
 * @param {string} message - The raw user message
 * @returns {{ toolName: string, toolArgs: object, serverKey: string } | null}
 */
export async function route(message) {
    const span = tracer.startSpan('agent.reasoning', { kind: SpanKind.INTERNAL });
    // Path-independent attributes (gen_ai.operation.name + agent identity) shared
    // with the LLM path; see agentReasoning.js.
    stampAgentIdentity(span);
    span.setAttribute('reasoning.mode', 'keyword');
    span.setAttribute('reasoning.candidates', KEYWORD_TOOL_CATALOG);

    try {
        const { routed, rule } = _decide(message);
        span.setAttribute('reasoning.rule', rule);
        if (routed?.toolName) {
            span.setAttribute('reasoning.chosen', [routed.toolName]);
        }
        return routed;
    } finally {
        span.end();
    }
}
