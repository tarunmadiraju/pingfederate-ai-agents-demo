/**
 * Chat executor (extracted from src/index.js).
 *
 * Owns the routing → dispatch → elicitation flow shared by the AG-UI run
 * handlers. Elicitation prompts (gather-args, confirm-destructive, URL OAuth
 * delegation) surface as AG-UI Interrupts: the `onElicitationRequest`
 * callback throws an `InterruptError`, which the run handler catches and
 * translates into `RUN_FINISHED { outcome: { type: 'interrupt', ... } }`.
 * The portal resumes by posting a follow-up run with `resume: [...]`.
 */

import config from '../config.js';
import { callMcpTool } from '../mcpClient.js';
import { routerState } from '../routerState.js';
import { route as keywordRoute } from '../routers/keywordToolRouter.js';
import { isInterruptError } from './interruptError.js';

// Note: LLM routing is handled directly by `agui/llmRunHandler.js` (ReAct loop
// with token streaming). `executeChat()` here is used only by the keyword run
// handler — its routing branch always resolves to keyword routing.

// =============================================================================
// dispatch — call an MCP tool and format the response for the portal
// =============================================================================

export async function dispatch(toolName, toolArgs, serverKey, actorToken, subjectToken) {
    if (toolName === 'submit_expense' && toolArgs._missingId) {
        return {
            message: 'Please specify which expense to submit. For example: "Submit expense EXP-2026-001237"',
            toolUsed: null
        };
    }

    const serverConfig = config.mcpServers[serverKey];
    const toolResult = serverConfig.auth
        ? await callMcpTool(serverKey, toolName, toolArgs, actorToken, subjectToken)
        : await callMcpTool(serverKey, toolName, toolArgs);

    switch (toolName) {
        case 'submit_expense':
            return {
                message: toolResult.error
                    ? toolResult.message
                    : (toolResult.message || `Expense ${toolArgs.expense_id} submitted for approval.`),
                toolUsed: 'submit_expense',
                toolResult
            };

        case 'list_expenses':
            return {
                message: toolResult.count
                    ? `Here are your ${toolResult.count} expense(s) (total: $${toolResult.total_amount?.toFixed(2) || '0.00'}).`
                    : 'You have no expenses.',
                toolUsed: 'list_expenses',
                expenses: toolResult.expenses || [],
                toolResult
            };

        case 'list_pending_approvals':
            return {
                message: toolResult.count
                    ? `There are ${toolResult.count} expense(s) pending approval (total: $${toolResult.total_amount?.toFixed(2) || '0.00'}).`
                    : 'No expenses are pending approval.',
                toolUsed: 'list_pending_approvals',
                expenses: toolResult.expenses || [],
                toolResult
            };

        case 'get_expense_status':
            return {
                message: toolResult.error
                    ? toolResult.message
                    : `Expense ${toolArgs.expense_id}: status is ${toolResult.status}, amount $${toolResult.amount?.toFixed(2) || 'N/A'}.`,
                toolUsed: 'get_expense_status',
                toolResult
            };

        case 'approve_expense':
            return {
                message: toolResult.error
                    ? toolResult.message
                    : (toolResult.message || `Expense ${toolArgs.expense_id} approved.`),
                toolUsed: 'approve_expense',
                toolResult
            };

        case 'get_budget_summary':
            return {
                message: `Budget for ${toolResult.cost_center || toolArgs.cost_center}:\n` +
                    `• Allocated: $${toolResult.allocated?.toLocaleString() || 'N/A'}\n` +
                    `• Spent: $${toolResult.spent?.toLocaleString() || 'N/A'}\n` +
                    `• Remaining: $${toolResult.remaining?.toLocaleString() || 'N/A'}\n` +
                    `• Utilization: ${toolResult.utilization_pct || 'N/A'}%`,
                toolUsed: 'get_budget_summary',
                toolResult
            };

        // === TRAVEL TOOLS ===

        case 'search_flights':
            return {
                message: toolResult.flights?.length
                    ? `Found ${toolResult.flights.length} flight(s) from ${toolArgs.origin || '?'} to ${toolArgs.destination || '?'}.`
                    : (toolResult.message || 'No flights found.'),
                toolUsed: 'search_flights',
                toolResult
            };

        case 'book_flight':
            return {
                message: toolResult.error
                    ? toolResult.message
                    : (toolResult.message || `Flight ${toolArgs.flight_id} booked successfully.`),
                toolUsed: 'book_flight',
                toolResult
            };

        case 'get_booking':
            return {
                message: toolResult.error
                    ? toolResult.message
                    : (toolResult.message || `Booking ${toolArgs.booking_id}: ${toolResult.status || 'confirmed'}.`),
                toolUsed: 'get_booking',
                toolResult
            };

        case 'search_hotels': {
            const baseResponse = {
                message: toolResult.hotels?.length
                    ? `Found ${toolResult.hotels.length} hotel(s) in ${toolArgs.city || '?'}.`
                    : (toolResult.message || 'No hotels found.'),
                toolUsed: 'search_hotels',
                toolResult
            };

            baseResponse.mcpApp = {
                resourceUri: 'ui://travel-mcp/hotel-search.html'
            };

            return baseResponse;
        }

        case 'book_hotel':
            return {
                message: toolResult.error
                    ? toolResult.message
                    : (toolResult.message || `Hotel ${toolArgs.hotel_id} booked successfully.`),
                toolUsed: 'book_hotel',
                toolResult
            };

        case 'get_itinerary': {
            const totalBookings = (toolResult.flights?.length || 0) + (toolResult.hotels?.length || 0);
            return {
                message: totalBookings
                    ? `Your travel itinerary has ${totalBookings} booking(s).`
                    : (toolResult.message || 'No travel bookings found.'),
                toolUsed: 'get_itinerary',
                toolResult
            };
        }

        // === FINANCIAL REPORT TOOLS ===

        case 'get_financial_report': {
            if (toolResult.elicitation_required) {
                return {
                    message: toolResult.message || 'Financial report authorization required.',
                    toolUsed: 'get_financial_report',
                    toolResult
                };
            }
            const financialReportResponse = {
                message: `Financial report for ${toolResult.cost_center || toolArgs.cost_center} (${toolResult.department || ''}):\n` +
                    `• Budget utilization: ${toolResult.budget?.utilization_pct || 'N/A'}%\n` +
                    `• Burn rate: $${toolResult.monthly_burn_rate?.toLocaleString() || 'N/A'}/month\n` +
                    `• Projected year-end: $${toolResult.projected_annual_spend?.toLocaleString() || 'N/A'}`,
                toolUsed: 'get_financial_report',
                toolResult
            };
            financialReportResponse.mcpApp = {
                resourceUri: 'ui://expense-mcp/financial-report.html'
            };
            return financialReportResponse;
        }

        default:
            return {
                message: toolResult.message || JSON.stringify(toolResult),
                toolUsed: toolName,
                toolResult
            };
    }
}

// =============================================================================
// Elicitation specs (gather-args, confirm-destructive)
// =============================================================================

const CONFIRM_REQUIRED_TOOLS = new Set(['book_flight', 'book_hotel']);

const GATHER_ARGS_SPECS = {
    search_flights(routed) {
        const args = routed.toolArgs || {};
        if (args.origin && args.destination) return null;
        return {
            message: "I can search flights for you — please provide the trip details.",
            requestedSchema: {
                type: 'object',
                properties: {
                    origin: { type: 'string', title: 'Origin airport', description: '3-letter IATA code (e.g. JFK, SFO, LHR)', minLength: 3, maxLength: 3 },
                    destination: { type: 'string', title: 'Destination airport', description: '3-letter IATA code (e.g. LAX, CDG, NRT)', minLength: 3, maxLength: 3 },
                    date: { type: 'string', title: 'Departure date (optional)', description: 'YYYY-MM-DD — leave blank to see all available dates', format: 'date' }
                },
                required: ['origin', 'destination']
            }
        };
    },
    search_hotels(routed) {
        const args = routed.toolArgs || {};
        if (args.city) return null;
        return {
            message: "I can search hotels for you — please provide the city.",
            requestedSchema: {
                type: 'object',
                properties: {
                    city: { type: 'string', title: 'City', description: 'City name (e.g. Paris, New York, Tokyo)' },
                    check_in: { type: 'string', title: 'Check-in date (optional)', description: 'YYYY-MM-DD', format: 'date' },
                    check_out: { type: 'string', title: 'Check-out date (optional)', description: 'YYYY-MM-DD', format: 'date' }
                },
                required: ['city']
            }
        };
    },
    book_flight(routed) {
        const args = routed.toolArgs || {};
        if (args.flight_id) return null;
        return {
            message: "Which flight would you like to book? Please provide the flight ID.",
            requestedSchema: {
                type: 'object',
                properties: {
                    flight_id: { type: 'string', title: 'Flight ID', description: 'Flight identifier (e.g. FL-1553)' }
                },
                required: ['flight_id']
            }
        };
    },
    book_hotel(routed) {
        const args = routed.toolArgs || {};
        if (args.hotel_id) return null;
        return {
            message: "Which hotel would you like to book? Please provide the hotel ID.",
            requestedSchema: {
                type: 'object',
                properties: {
                    hotel_id: { type: 'string', title: 'Hotel ID', description: 'Hotel identifier (e.g. HT-203)' }
                },
                required: ['hotel_id']
            }
        };
    }
};

function buildConfirmationMessage(routed) {
    const args = Object.entries(routed.toolArgs || {})
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
    switch (routed.toolName) {
        case 'book_flight':
            return `Confirm flight booking${args ? ` (${args})` : ''}? This action will charge the traveler's account.`;
        case 'book_hotel':
            return `Confirm hotel booking${args ? ` (${args})` : ''}? This action will reserve the room and charge the traveler's account.`;
        default:
            return `Confirm ${routed.toolName}${args ? ` (${args})` : ''}?`;
    }
}

// =============================================================================
// Shared authorization error helpers (used by keyword and LLM run handlers)
// =============================================================================

/**
 * Normalize a raw 4xx tool result into a canonical authorizationError descriptor.
 * Returns null if the status is not an authorization failure.
 *
 * @param {{ status: number, error?: string, message?: string, scope?: string,
 *           toolName?: string, ciba_txn_id?: string }} raw
 * @param {string} toolName
 * @returns {{ status, error, message, scope, toolName, ciba_txn_id } | null}
 */
export function normalizeAuthError(raw, toolName) {
    if (!raw || !(raw.status >= 400)) return null;
    let error = raw.error;
    let message = raw.message;
    let scope = raw.scope;
    if (!error && typeof message === 'string' && message.startsWith('insufficient_scope')) {
        error = 'insufficient_scope';
        const scopeMatch = message.match(/scope=([\w:]+)/);
        if (scopeMatch) scope = scopeMatch[1];
        message = `The agent does not have the required permission: ${scope || 'unknown'}`;
    }
    return {
        status: raw.status,
        error: error || null,
        message: message || 'Authorization error',
        scope: scope || null,
        toolName: raw.toolName || toolName || null,
        ciba_txn_id: raw.ciba_txn_id || null
    };
}

/**
 * If `err` was thrown by `initializeSession` due to a 403, extract the full
 * error message from the raw body and return a structured `authorizationError`
 * result so the portal renders the amber card (not a raw red error).
 * Returns null for any other error so the caller can re-throw.
 */
export function parseMcpInitError(err, routed, userInfo, routingMode) {
    const msg = err?.message || '';
    // initializeSession throws: `MCP initialize failed for "…": 403 - <body>`
    const match = msg.match(/MCP initialize failed for "[^"]+": 403 - ([\s\S]+)/);
    if (!match) return null;

    let errorMessage = match[1].trim();
    // Body is typically JSON: {"status":403,"message":"delegation_required: …"}
    try {
        const parsed = JSON.parse(errorMessage);
        errorMessage = parsed.message || errorMessage;
    } catch { /* body was plain text — use as-is */ }

    return {
        type: 'tool_response',
        message: 'Access Denied',
        toolUsed: routed?.toolName || null,
        toolResult: { status: 403, message: errorMessage },
        mcpApp: null,
        expenses: null,
        authorizationError: {
            status: 403,
            error: 'delegation_required',
            message: errorMessage,
            scope: null,
            toolName: routed?.toolName || null,
            ciba_txn_id: null
        },
        userInfo,
        routingMode,
        routed
    };
}

// =============================================================================
// executeChat — shared core chat execution logic
// =============================================================================

/**
 * Run the routing → dispatch → elicitation flow for a single user message.
 *
 * Elicitation prompts (form + url) are surfaced via `onElicitationRequest`,
 * an async callback supplied by the AG-UI run handler. The callback receives
 * `{ kind, params, routed, pendingToolResult? }` where `kind` is one of:
 *   - 'gather-args'        → form, missing required tool args
 *   - 'confirm-destructive'→ form, optional notes for book_flight/book_hotel
 *   - 'url'                → url, OAuth delegation flow
 * It must resolve to `{ action: 'accept'|'decline'|'cancel', content?: object }`.
 *
 * When `onElicitationRequest` is null, all elicitation paths are skipped
 * (destructive tools default to `decline` for safety; gather-args proceeds
 * with whatever args the router extracted; URL flows are aborted).
 *
 * Resume support:
 *   - `presentRouted` overrides keyword routing — pass the `routed` object
 *     from the saved continuation when resuming from an interrupt.
 *   - `resumeContext` is the resolved interrupt: `{ kind, content }`. The
 *     elicitation site whose `kind` matches consumes it (treats it as
 *     `{ action: 'accept', content }`) and clears it; subsequent sites then
 *     prompt normally via `onElicitationRequest`.
 *
 * @param {object} args
 * @param {string} args.message
 * @param {string|null} args.conversationId
 * @param {string} args.actorToken
 * @param {string|null} args.subjectToken
 * @param {Function|null} [args.onElicitationRequest]
 * @param {object|null} [args.presentRouted]
 * @param {{kind: string, content: object|null}|null} [args.resumeContext]
 */
export async function executeChat({
    message,
    conversationId,
    actorToken,
    subjectToken,
    onElicitationRequest = null,
    presentRouted = null,
    resumeContext = null
}) {
    let userInfo = { sub: 'unknown' };
    if (subjectToken) {
        try {
            const [, payload] = subjectToken.split('.');
            userInfo = JSON.parse(Buffer.from(payload, 'base64').toString());
            console.log(`[Chat] User: ${userInfo.sub}`);
        } catch {
            console.log(`[Chat] Could not decode subject token (may be opaque)`);
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Chat] New request - Conversation: ${conversationId || 'none'}`);
    console.log(`[Chat] User message: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`);

    // === ROUTE MESSAGE TO MCP TOOL ===
    console.log(`[Chat] Routing mode: ${routerState.mode}`);
    const routed = presentRouted ? { ...presentRouted, toolArgs: { ...(presentRouted.toolArgs || {}) } } : await keywordRoute(message);
    let pendingResume = resumeContext;
    const consumeResume = (kind) => {
        if (pendingResume && pendingResume.kind === kind) {
            const resolved = { action: 'accept', content: pendingResume.content || {} };
            pendingResume = null;
            return resolved;
        }
        return null;
    };

    // === DISPATCH OR DEFAULT GREETING ===
    let response;
    if (routed) {
        console.log(`[Chat] Routed to: ${routed.toolName}(${JSON.stringify(routed.toolArgs)}) on server "${routed.serverKey}"`);

        if (routed.toolName === '_redirect_trip_planner') {
            return {
                type: 'greeting',
                message: `To plan a trip, please switch to the **Trip Planner** agent using the agent picker at the top of the chat. The Trip Planner coordinates flights, hotels, and weather across multiple agents on your behalf.`,
                toolUsed: null,
                toolResult: null,
                mcpApp: null,
                expenses: null,
                authorizationError: null,
                userInfo,
                routingMode: routerState.mode,
                routed: null
            };
        }

        // === ELICIT MISSING TOOL ARGUMENTS ===
        const gatherSpec = onElicitationRequest && GATHER_ARGS_SPECS[routed.toolName]?.(routed);
        if (gatherSpec) {
            console.log(`[Chat] Eliciting missing args for ${routed.toolName}`);
            let elicitResult = consumeResume('gather-args');
            if (!elicitResult) {
                try {
                    // Timeout is owned by the portal's elicitation card — no outer race needed.
                    elicitResult = await onElicitationRequest({
                        kind: 'gather-args',
                        params: { mode: 'form', message: gatherSpec.message, requestedSchema: gatherSpec.requestedSchema },
                        routed
                    });
                } catch (err) {
                    // InterruptError is sentinel control flow used by the AG-UI
                    // run handler to bubble the prompt out as an Interrupt.
                    if (isInterruptError(err)) throw err;
                    console.warn(`[Chat] Gather-args elicitation failed (${err.message})`);
                    elicitResult = { action: 'cancel' };
                }
            }
            console.log(`[Chat] Gather-args result: action=${elicitResult.action}`);

            if (elicitResult.action !== 'accept') {
                const isDecline = elicitResult.action === 'decline';
                return {
                    type: 'elicitation_declined',
                    message: isDecline
                        ? `${routed.toolName} declined by user.`
                        : `${routed.toolName} cancelled by user. You can try again when ready.`,
                    toolUsed: routed.toolName,
                    toolResult: { cancelled: true, action: elicitResult.action, args: routed.toolArgs },
                    mcpApp: null,
                    expenses: null,
                    authorizationError: null,
                    elicitation: { action: elicitResult.action },
                    userInfo,
                    routingMode: routerState.mode,
                    routed
                };
            }

            const content = elicitResult.content || {};
            for (const [k, v] of Object.entries(content)) {
                if (v === undefined || v === null || v === '') continue;
                routed.toolArgs[k] = (k === 'origin' || k === 'destination') && typeof v === 'string'
                    ? v.toUpperCase()
                    : v;
            }
        }

        // === ELICIT USER CONFIRMATION FOR DESTRUCTIVE TOOLS ===
        if (onElicitationRequest && CONFIRM_REQUIRED_TOOLS.has(routed.toolName)) {
            console.log(`[Chat] Eliciting confirmation for ${routed.toolName}`);
            let elicitResult = consumeResume('confirm-destructive');
            if (!elicitResult) {
                try {
                    // Timeout is owned by the portal's elicitation card — no outer race needed.
                    elicitResult = await onElicitationRequest({
                        kind: 'confirm-destructive',
                        params: {
                            mode: 'form',
                            message: buildConfirmationMessage(routed),
                            requestedSchema: {
                                type: 'object',
                                properties: {
                                    notes: {
                                        type: 'string',
                                        title: 'Notes (optional)',
                                        description: 'Add an optional note that will be attached to the booking.'
                                    }
                                },
                                required: []
                            }
                        },
                        routed
                    });
                } catch (err) {
                    // InterruptError is sentinel control flow — let it bubble.
                    if (isInterruptError(err)) throw err;
                    // SECURITY: do NOT default to accept on failure for destructive tools.
                    console.warn(`[Chat] Elicitation failed (${err.message}); declining destructive action`);
                    elicitResult = { action: 'decline' };
                }
            }
            console.log(`[Chat] Elicitation result: action=${elicitResult.action}`);

            if (elicitResult.action !== 'accept') {
                const isDecline = elicitResult.action === 'decline';
                return {
                    type: 'elicitation_declined',
                    message: isDecline
                        ? `${routed.toolName} declined by user. The action will not be performed.`
                        : `${routed.toolName} cancelled by user. You can try again when ready.`,
                    toolUsed: routed.toolName,
                    toolResult: { cancelled: true, action: elicitResult.action, args: routed.toolArgs },
                    mcpApp: null,
                    expenses: null,
                    authorizationError: null,
                    elicitation: { action: elicitResult.action },
                    userInfo,
                    routingMode: routerState.mode,
                    routed
                };
            }

            if (elicitResult.content?.notes) {
                console.log(`[Chat] User note on ${routed.toolName}: "${elicitResult.content.notes}"`);
            }
        }

        // If a 'url' resume is pending, the OAuth dance already finished
        // out-of-band — dispatch once and skip the URL-elicitation block.
        const urlResume = consumeResume('url');
        try {
            response = await dispatch(routed.toolName, routed.toolArgs, routed.serverKey, actorToken, subjectToken);
        } catch (err) {
            const authErr = parseMcpInitError(err, routed, userInfo, routerState.mode);
            if (authErr) return authErr;
            throw err;
        }

        // === URL ELICITATION: OAuth delegation flow ===
        if (!urlResume && onElicitationRequest && response.toolResult?.elicitation_required && response.toolResult?.connect_url) {
            const tr = response.toolResult;
            console.log(`[Chat] Tool returned elicitation_required, connect_url=${tr.connect_url}`);

            let elicitResult;
            try {
                // Timeout is owned by the portal's elicitation card — no outer race needed.
                elicitResult = await onElicitationRequest({
                    kind: 'url',
                    params: {
                        mode: 'url',
                        url: tr.connect_url,
                        message: tr.message || 'Authorization required. Please connect your account.',
                        requestingServer: { name: routed.serverKey }
                    },
                    routed,
                    pendingToolResult: response.toolResult
                });
            } catch (err) {
                // InterruptError is sentinel control flow — let it bubble.
                if (isInterruptError(err)) throw err;
                console.warn(`[Chat] URL elicitation failed (${err.message})`);
                elicitResult = { action: 'cancel' };
            }

            console.log(`[Chat] URL elicitation result: action=${elicitResult.action}`);

            if (elicitResult.action === 'accept') {
                console.log(`[Chat] Retrying ${routed.toolName} after successful OAuth delegation`);
                try {
                    response = await dispatch(routed.toolName, routed.toolArgs, routed.serverKey, actorToken, subjectToken);
                } catch (err) {
                    const authErr = parseMcpInitError(err, routed, userInfo, routerState.mode);
                    if (authErr) return authErr;
                    throw err;
                }
            } else {
                return {
                    type: 'elicitation_declined',
                    message: elicitResult.action === 'decline'
                        ? 'Financial report authorization declined.'
                        : 'Financial report authorization cancelled. You can try again when ready.',
                    toolUsed: routed.toolName,
                    toolResult: { cancelled: true, action: elicitResult.action, args: routed.toolArgs },
                    mcpApp: null,
                    expenses: null,
                    authorizationError: null,
                    elicitation: { action: elicitResult.action },
                    userInfo,
                    routingMode: routerState.mode,
                    routed
                };
            }
        }
    } else {
        return {
            type: 'greeting',
            message: `I'm your Workforce Assistant. I can help you with expenses, budgets, approvals, flights, hotels, travel bookings, and more. What would you like to do?`,
            toolUsed: null,
            toolResult: null,
            mcpApp: null,
            expenses: null,
            authorizationError: null,
            userInfo,
            routingMode: routerState.mode,
            routed: null
        };
    }

    console.log(`[Chat] Response ready`);
    console.log(`${'='.repeat(60)}\n`);

    // === CHECK FOR AUTHORIZATION ERRORS ===
    const routedServerConfig = config.mcpServers[routed.serverKey];
    if (routedServerConfig?.type === 'local' && response.toolResult?.status >= 400) {
        console.log(`[Chat] Authorization error raw:`, JSON.stringify(response.toolResult));
        const ae = normalizeAuthError(response.toolResult, routed.toolName);
        return {
            type: 'tool_response',
            message: 'Access Denied',
            toolUsed: response.toolUsed,
            toolResult: response.toolResult,
            mcpApp: null,
            expenses: null,
            authorizationError: ae,
            userInfo,
            routingMode: routerState.mode,
            routed
        };
    }

    // === NORMAL TOOL RESPONSE ===
    return {
        type: 'tool_response',
        message: response.message,
        toolUsed: response.toolUsed,
        toolResult: response.toolResult,
        mcpApp: response.mcpApp || null,
        expenses: response.expenses || null,
        authorizationError: null,
        userInfo,
        routingMode: routerState.mode,
        routed
    };
}

// =============================================================================
// structuredContent type mapper — defines the canonical view names
// =============================================================================

/**
 * Map a ChatResult.toolUsed to the canonical AG-UI `view` string used in
 * `state.results[].view`. Mirrors the legacy MCP `structuredContent.type`
 * so the portal can keep its existing card renderer.
 *
 * @param {string} toolUsed
 * @returns {string}
 */
export function viewForTool(toolUsed) {
    switch (toolUsed) {
        case 'list_expenses': return 'expense_list';
        case 'list_pending_approvals': return 'approval_list';
        case 'get_expense_status': return 'expense_detail';
        case 'approve_expense':
        case 'submit_expense': return 'expense_action';
        case 'get_budget_summary': return 'budget_summary';
        case 'search_flights': return 'flight_results';
        case 'book_flight':
        case 'book_hotel': return 'booking_confirmation';
        case 'get_booking': return 'booking_detail';
        case 'search_hotels': return 'hotel_results';
        case 'get_itinerary': return 'itinerary';
        case 'get_financial_report': return 'financial_report';
        default: return 'tool_result';
    }
}
