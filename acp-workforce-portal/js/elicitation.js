/**
 * Elicitation UI for the Workforce Portal — Inline Chat Flow
 *
 * Renders elicitation requests as inline cards within the chat flow
 * (same pattern as CIBA consent cards), rather than a modal overlay.
 *
 * Per the MCP spec (2025-11-25): "Implementations are free to expose
 * elicitation through any interface pattern that suits their needs."
 *
 * MCP spec requirements satisfied:
 *   - MUST identify which server is requesting input (_meta.requestingServer)
 *   - MUST provide decline/cancel options
 *   - MUST allow review before sending (form mode)
 *
 * The handler returns a Promise that resolves with:
 *   { action: 'accept', content: { ...formData } }
 *   { action: 'decline' }
 *   { action: 'cancel' }
 *
 * Schema rendering scope (intentionally minimal for the demo):
 *   - type: object with `properties` and optional `required`
 *   - Property types: string (text/email/date), number, integer, boolean, enum
 *   - Optional: title, description, default
 */

const elicitation = (() => {

    let _elicitCounter = 0;

    /**
     * Show an elicitation card inline in the chat and return the user's response.
     *
     * Wired to mcpClient via:
     *   mcpClient.setRequestHandler('elicitation/create', elicitation.handle);
     *
     * Supports two modes:
     *   - form: renders a schema-driven form inline (existing behavior)
     *   - url:  renders a "Connect" card that opens the URL in a popup;
     *           auto-resolves when the popup sends postMessage back
     *
     * @param {object} params - { mode, message, url?, requestedSchema?, _meta? }
     * @returns {Promise<{action: 'accept'|'decline'|'cancel', content?: object}>}
     */
    function handle(params) {
        const mode = params?.mode ?? 'form';

        if (mode === 'url') {
            return new Promise((resolve) => {
                const url = params?.url;
                const message = params?.message || 'Authorization required.';
                const meta = params?._meta || {};
                const serverInfo = meta.requestingServer;
                const elicitationId = params?.elicitationId || meta.elicitationId || null;
                renderUrlCard(url, message, serverInfo, elicitationId, resolve);
            });
        }

        // Default: form mode
        return new Promise((resolve) => {
            const message = params?.message || 'The agent is requesting input.';
            const schema = params?.requestedSchema || { type: 'object', properties: {} };
            const meta = params?._meta || {};
            const serverInfo = meta.requestingServer;
            const elicitationType = meta.elicitationType || 'confirmation';
            renderInlineCard(message, schema, serverInfo, elicitationType, resolve);
        });
    }

    /**
     * Render a URL-mode elicitation card. Shows a "Connect" button that opens
     * the authorization URL in a popup. A postMessage listener auto-resolves
     * when the popup's callback page signals success.
     */
    function renderUrlCard(url, message, serverInfo, elicitationId, resolve) {
        const cardId = `elicit-url-${++_elicitCounter}`;
        const chatMessages = document.getElementById('chat-messages');
        if (!chatMessages) return;

        const serverName = serverInfo?.name || 'AI Agent';
        const serverVersion = serverInfo?.version ? ` v${serverInfo.version}` : '';

        // Extract domain for display
        let displayDomain = '';
        try { displayDomain = new URL(url).hostname; } catch { displayDomain = url; }

        const messageDiv = document.createElement('div');
        messageDiv.className = 'flex items-start space-x-3';
        messageDiv.id = cardId;

        messageDiv.innerHTML = `
            <div class="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                <i class="fa-solid fa-link text-purple-600"></i>
            </div>
            <div class="bg-purple-50 border border-purple-200 rounded-lg p-4 max-w-[80%] shadow-sm">
                <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center">
                        <i class="fa-solid fa-shield-halved text-purple-600 mr-2"></i>
                        <span class="font-semibold text-gray-800">Authorization Required</span>
                    </div>
                    <span class="bg-purple-100 text-purple-700 px-2 py-0.5 rounded text-xs font-medium ml-2">MCP Elicitation (URL)</span>
                </div>
                <div class="text-xs text-slate-500 mb-2">
                    <i class="fa-solid fa-server mr-1"></i>
                    Requested by <span class="font-medium">${escapeHtml(serverName)}${escapeHtml(serverVersion)}</span>
                </div>
                <p class="text-gray-700 mb-2" data-elicit-message></p>
                <div class="text-xs text-slate-500 mb-3">
                    <i class="fa-solid fa-globe mr-1"></i>
                    <span class="font-mono">${escapeHtml(displayDomain)}</span>
                </div>
                <div class="flex space-x-3" data-elicit-actions>
                    <button type="button" data-action="connect"
                        class="flex-1 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center justify-center"
                        style="background-color: #2d3282;">
                        <i class="fa-solid fa-arrow-up-right-from-square mr-2"></i>Connect
                    </button>
                    <button type="button" data-action="decline"
                        class="flex-1 bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center justify-center">
                        <i class="fa-solid fa-xmark mr-2"></i>Decline
                    </button>
                    <button type="button" data-action="cancel"
                        class="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200 rounded-md transition flex items-center justify-center">
                        Cancel
                    </button>
                </div>
                <div class="hidden mt-3 text-sm text-purple-700 flex items-center" data-elicit-waiting>
                    <i class="fa-solid fa-spinner fa-spin mr-2"></i>
                    Waiting for authorization to complete...
                </div>
            </div>
        `;

        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Set the message text safely
        messageDiv.querySelector('[data-elicit-message]').textContent = message;

        let resolved = false;
        let popupWindow = null;

        function finish(result) {
            if (resolved) return;
            resolved = true;
            // Remove postMessage listener
            window.removeEventListener('message', onMessage);
            updateUrlCardAfterAction(messageDiv, result.action);
            resolve(result);
        }

        // Listen for postMessage from the popup's callback page
        function onMessage(event) {
            // Only accept from the expected origin
            if (event.origin !== 'https://acp-expense-mcp.localhost') return;
            const data = event.data;
            if (data?.type !== 'mcp-elicitation-complete') return;
            // Optionally verify elicitationId matches
            if (elicitationId && data.elicitationId && data.elicitationId !== elicitationId) return;

            console.log('[Elicitation] postMessage received — OAuth flow complete');
            // Surface the delegated token in the OAuth Token Flow panel
            if (data.delegatedToken) {
                addToken(data.delegatedToken, TOKEN_TYPES.DELEGATED);
                updateTokenPanel();
            }
            finish({ action: 'accept' });
        }
        window.addEventListener('message', onMessage);

        // Connect button: open popup
        messageDiv.querySelector('[data-action="connect"]').addEventListener('click', () => {
            popupWindow = window.open(url, 'mcp-oauth-connect', 'width=500,height=700,menubar=no,toolbar=no');
            // Show waiting indicator, hide actions
            const actions = messageDiv.querySelector('[data-elicit-actions]');
            const waiting = messageDiv.querySelector('[data-elicit-waiting]');
            if (actions) actions.classList.add('hidden');
            if (waiting) waiting.classList.remove('hidden');
        });

        messageDiv.querySelector('[data-action="decline"]').addEventListener('click', () => {
            finish({ action: 'decline' });
        });
        messageDiv.querySelector('[data-action="cancel"]').addEventListener('click', () => {
            finish({ action: 'cancel' });
        });
    }

    /**
     * Update a URL-mode card after the user takes action.
     */
    function updateUrlCardAfterAction(cardDiv, action) {
        const actionsDiv = cardDiv.querySelector('[data-elicit-actions]');
        const waitingDiv = cardDiv.querySelector('[data-elicit-waiting]');
        if (waitingDiv) waitingDiv.classList.add('hidden');
        if (!actionsDiv) return;
        actionsDiv.classList.remove('hidden');

        if (action === 'accept') {
            actionsDiv.innerHTML = `
                <div class="flex items-center justify-center w-full text-green-700 text-sm py-2">
                    <i class="fa-solid fa-check-circle mr-2"></i>
                    Connected — fetching financial report
                </div>
            `;
            const innerCard = cardDiv.querySelector('.bg-purple-50');
            if (innerCard) {
                innerCard.className = innerCard.className
                    .replace('bg-purple-50', 'bg-green-50')
                    .replace('border-purple-200', 'border-green-200');
            }
        } else if (action === 'decline') {
            actionsDiv.innerHTML = `
                <div class="flex items-center justify-center w-full text-red-700 text-sm py-2">
                    <i class="fa-solid fa-times-circle mr-2"></i>
                    Authorization declined
                </div>
            `;
            const innerCard = cardDiv.querySelector('.bg-purple-50');
            if (innerCard) {
                innerCard.className = innerCard.className
                    .replace('bg-purple-50', 'bg-red-50')
                    .replace('border-purple-200', 'border-red-200');
            }
        } else {
            actionsDiv.innerHTML = `
                <div class="flex items-center justify-center w-full text-slate-500 text-sm py-2">
                    <i class="fa-solid fa-circle-xmark mr-2"></i>
                    Cancelled
                </div>
            `;
            const innerCard = cardDiv.querySelector('.bg-purple-50');
            if (innerCard) {
                innerCard.className = innerCard.className
                    .replace('bg-purple-50', 'bg-slate-50')
                    .replace('border-purple-200', 'border-slate-200');
            }
        }
    }

    /**
     * Render the elicitation as an inline card in the chat flow.
     */
    function renderInlineCard(message, schema, serverInfo, elicitationType, resolve) {
        const cardId = `elicit-card-${++_elicitCounter}`;
        const chatMessages = document.getElementById('chat-messages');
        if (!chatMessages) return;

        // Build server identity line (MCP spec MUST: identify requesting server)
        const serverName = serverInfo?.name || 'AI Agent';
        const serverVersion = serverInfo?.version ? ` v${serverInfo.version}` : '';

        const messageDiv = document.createElement('div');
        messageDiv.className = 'flex items-start space-x-3';
        messageDiv.id = cardId;

        const isGatherArgs = elicitationType === 'gather-args';
        const cardHeading = isGatherArgs ? 'Additional Information Needed' : 'Action Requires Confirmation';
        const cardIcon = isGatherArgs ? 'fa-circle-question' : 'fa-circle-exclamation';
        const cardBg = isGatherArgs ? 'bg-blue-50' : 'bg-amber-50';
        const cardBorder = isGatherArgs ? 'border-blue-200' : 'border-amber-200';
        const iconBg = isGatherArgs ? 'bg-blue-100' : 'bg-amber-100';
        const iconColor = isGatherArgs ? 'text-blue-600' : 'text-amber-600';

        messageDiv.innerHTML = `
            <div class="w-8 h-8 rounded-full ${iconBg} flex items-center justify-center flex-shrink-0">
                <i class="fa-solid ${cardIcon} ${iconColor}"></i>
            </div>
            <div class="${cardBg} border ${cardBorder} rounded-lg p-4 max-w-[80%] shadow-sm">
                <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center">
                        <i class="fa-solid fa-robot text-indigo-600 mr-2"></i>
                        <span class="font-semibold text-gray-800">${cardHeading}</span>
                    </div>
                    <span class="bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded text-xs font-medium ml-2">MCP Elicitation (Form)</span>
                </div>
                <div class="text-xs text-slate-500 mb-3">
                    <i class="fa-solid fa-server mr-1"></i>
                    Requested by <span class="font-medium">${escapeHtml(serverName)}${escapeHtml(serverVersion)}</span>
                </div>
                <p class="text-gray-700 mb-3" data-elicit-message></p>
                <form data-elicit-form class="space-y-3 mb-4"></form>
                <div class="flex space-x-3" data-elicit-actions>
                    <button type="button" data-action="accept"
                        class="flex-1 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center justify-center"
                        style="background-color: #2d3282;">
                        <i class="fa-solid fa-check mr-2"></i>Accept
                    </button>
                    <button type="button" data-action="decline"
                        class="flex-1 bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-4 rounded-lg transition-colors flex items-center justify-center">
                        <i class="fa-solid fa-xmark mr-2"></i>Decline
                    </button>
                    <button type="button" data-action="cancel"
                        class="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200 rounded-md transition flex items-center justify-center">
                        Cancel
                    </button>
                </div>
            </div>
        `;

        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        // Set the message text safely (not via innerHTML)
        messageDiv.querySelector('[data-elicit-message]').textContent = message;

        // Render schema-driven form
        const form = messageDiv.querySelector('[data-elicit-form]');
        renderSchemaForm(form, schema);

        // Resolve once and update the card to show the outcome
        let resolved = false;
        function finish(result) {
            if (resolved) return;
            resolved = true;
            updateCardAfterAction(messageDiv, result.action, serverName);
            resolve(result);
        }

        messageDiv.querySelector('[data-action="cancel"]').addEventListener('click', () => {
            finish({ action: 'cancel' });
        });
        messageDiv.querySelector('[data-action="decline"]').addEventListener('click', () => {
            finish({ action: 'decline' });
        });
        messageDiv.querySelector('[data-action="accept"]').addEventListener('click', () => {
            const content = collectFormValues(form, schema);
            const missing = validateRequired(content, schema);
            if (missing.length > 0) {
                showFormErrors(form, missing);
                return;
            }
            finish({ action: 'accept', content });
        });

        // Focus the first input for keyboard users
        setTimeout(() => {
            const first = form.querySelector('input, select, textarea');
            if (first) first.focus();
        }, 0);
    }

    /**
     * Update the inline card after the user takes action — replace buttons
     * with a status indicator (similar to CIBA consent card pattern).
     */
    function updateCardAfterAction(cardDiv, action, serverName) {
        const actionsDiv = cardDiv.querySelector('[data-elicit-actions]');
        const formDiv = cardDiv.querySelector('[data-elicit-form]');
        if (!actionsDiv) return;

        // Hide the form inputs
        if (formDiv) formDiv.style.display = 'none';

        if (action === 'accept') {
            actionsDiv.innerHTML = `
                <div class="flex items-center justify-center w-full text-green-700 text-sm py-2">
                    <i class="fa-solid fa-check-circle mr-2"></i>
                    Confirmed — proceeding with action
                </div>
            `;
            // Update card styling
            const innerCard = cardDiv.querySelector('.bg-amber-50, .bg-blue-50');
            if (innerCard) {
                innerCard.className = innerCard.className
                    .replace(/bg-(amber|blue)-50/g, 'bg-green-50')
                    .replace(/border-(amber|blue)-200/g, 'border-green-200');
            }
        } else if (action === 'decline') {
            actionsDiv.innerHTML = `
                <div class="flex items-center justify-center w-full text-red-700 text-sm py-2">
                    <i class="fa-solid fa-times-circle mr-2"></i>
                    Declined — action will not be performed
                </div>
            `;
            const innerCard = cardDiv.querySelector('.bg-amber-50, .bg-blue-50, .bg-green-50');
            if (innerCard) {
                innerCard.className = innerCard.className
                    .replace(/bg-(amber|blue|green)-50/g, 'bg-red-50')
                    .replace(/border-(amber|blue|green)-200/g, 'border-red-200');
            }
        } else {
            actionsDiv.innerHTML = `
                <div class="flex items-center justify-center w-full text-slate-500 text-sm py-2">
                    <i class="fa-solid fa-circle-xmark mr-2"></i>
                    Cancelled
                </div>
            `;
            const innerCard = cardDiv.querySelector('.bg-amber-50, .bg-blue-50, .bg-green-50');
            if (innerCard) {
                innerCard.className = innerCard.className
                    .replace(/bg-(amber|blue|green)-50/g, 'bg-slate-50')
                    .replace(/border-(amber|blue|green)-200/g, 'border-slate-200');
            }
        }
    }

    /**
     * Render form fields from a JSON Schema object.
     * Supports type=string (with format=date|email|date-time, enum, oneOf),
     * type=number/integer, type=boolean.
     */
    function renderSchemaForm(form, schema) {
        const props = schema?.properties || {};
        const required = new Set(schema?.required || []);
        const keys = Object.keys(props);

        if (keys.length === 0) {
            const note = document.createElement('p');
            note.className = 'text-xs text-slate-500 italic';
            note.textContent = 'No additional input required. Click Accept to proceed.';
            form.appendChild(note);
            return;
        }

        for (const key of keys) {
            const prop = props[key];
            const wrapper = document.createElement('div');
            wrapper.className = 'space-y-1';
            wrapper.dataset.field = key;

            const label = document.createElement('label');
            label.className = 'block text-sm font-medium text-slate-700';
            label.htmlFor = `elicit-${key}`;
            label.textContent = prop.title || key;
            if (required.has(key)) {
                const star = document.createElement('span');
                star.className = 'text-red-600 ml-0.5';
                star.textContent = '*';
                label.appendChild(star);
            }
            wrapper.appendChild(label);

            const input = renderField(key, prop);
            wrapper.appendChild(input);

            if (prop.description) {
                const help = document.createElement('p');
                help.className = 'text-xs text-slate-500';
                help.textContent = prop.description;
                wrapper.appendChild(help);
            }

            const err = document.createElement('p');
            err.className = 'text-xs text-red-600 hidden';
            err.dataset.error = key;
            wrapper.appendChild(err);

            form.appendChild(wrapper);
        }
    }

    /**
     * Render a single input element for a schema property.
     */
    function renderField(key, prop) {
        const id = `elicit-${key}`;
        const baseClass = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';

        // Boolean → checkbox
        if (prop.type === 'boolean') {
            const wrap = document.createElement('label');
            wrap.className = 'inline-flex items-center gap-2 text-sm text-slate-700';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.id = id;
            cb.name = key;
            cb.className = 'rounded border-slate-300 text-indigo-600 focus:ring-indigo-500';
            if (prop.default === true) cb.checked = true;
            wrap.appendChild(cb);
            const span = document.createElement('span');
            span.textContent = prop.title || key;
            wrap.appendChild(span);
            return wrap;
        }

        // Enum (string with `enum` array, or `oneOf` with const+title) → select
        const enumValues = prop.enum;
        const oneOf = prop.oneOf;
        if ((prop.type === 'string') && (Array.isArray(enumValues) || Array.isArray(oneOf))) {
            const select = document.createElement('select');
            select.id = id;
            select.name = key;
            select.className = baseClass;
            if (Array.isArray(oneOf)) {
                for (const opt of oneOf) {
                    const o = document.createElement('option');
                    o.value = opt.const;
                    o.textContent = opt.title || opt.const;
                    select.appendChild(o);
                }
            } else {
                const enumNames = prop.enumNames || [];
                enumValues.forEach((val, idx) => {
                    const o = document.createElement('option');
                    o.value = val;
                    o.textContent = enumNames[idx] || val;
                    select.appendChild(o);
                });
            }
            if (prop.default !== undefined) select.value = prop.default;
            return select;
        }

        // Number / integer
        if (prop.type === 'number' || prop.type === 'integer') {
            const input = document.createElement('input');
            input.type = 'number';
            input.id = id;
            input.name = key;
            input.className = baseClass;
            if (prop.type === 'integer') input.step = '1';
            if (prop.minimum !== undefined) input.min = String(prop.minimum);
            if (prop.maximum !== undefined) input.max = String(prop.maximum);
            if (prop.default !== undefined) input.value = String(prop.default);
            return input;
        }

        // String (default) — pick input type from format hint
        const input = document.createElement('input');
        input.id = id;
        input.name = key;
        input.className = baseClass;
        if (prop.format === 'email') {
            input.type = 'email';
        } else if (prop.format === 'date') {
            input.type = 'date';
        } else if (prop.format === 'date-time') {
            input.type = 'datetime-local';
        } else if (prop.format === 'uri') {
            input.type = 'url';
        } else {
            input.type = 'text';
        }
        if (prop.minLength !== undefined) input.minLength = prop.minLength;
        if (prop.maxLength !== undefined) input.maxLength = prop.maxLength;
        if (prop.default !== undefined) input.value = String(prop.default);
        return input;
    }

    /**
     * Read form values keyed by schema property name. Empty optional strings
     * are omitted from the result (they're not "absent" vs "explicitly empty"
     * for our demo purposes).
     */
    function collectFormValues(form, schema) {
        const props = schema?.properties || {};
        const out = {};
        for (const [key, prop] of Object.entries(props)) {
            const el = form.querySelector(`[name="${CSS.escape(key)}"]`);
            if (!el) continue;
            if (prop.type === 'boolean') {
                out[key] = !!el.checked;
            } else if (prop.type === 'number' || prop.type === 'integer') {
                if (el.value !== '') {
                    const n = prop.type === 'integer' ? parseInt(el.value, 10) : Number(el.value);
                    if (!Number.isNaN(n)) out[key] = n;
                }
            } else {
                if (el.value && el.value.length > 0) {
                    out[key] = el.value;
                }
            }
        }
        return out;
    }

    /**
     * Return the list of required keys missing from the collected values.
     */
    function validateRequired(values, schema) {
        const required = schema?.required || [];
        return required.filter(k => values[k] === undefined || values[k] === '');
    }

    /**
     * Show inline errors next to required fields that are missing.
     */
    function showFormErrors(form, missingKeys) {
        // Clear previous errors
        form.querySelectorAll('[data-error]').forEach(el => {
            el.classList.add('hidden');
            el.textContent = '';
        });
        for (const key of missingKeys) {
            const err = form.querySelector(`[data-error="${CSS.escape(key)}"]`);
            if (err) {
                err.textContent = 'This field is required.';
                err.classList.remove('hidden');
            }
        }
    }

    return { handle };
})();
