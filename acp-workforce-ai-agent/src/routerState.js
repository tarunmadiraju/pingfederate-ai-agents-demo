/**
 * Router State — runtime routing mode singleton.
 *
 * Holds the current routing mode ('keyword' or 'llm') as mutable
 * in-process state. Switchable at runtime via the /mode chat command.
 * Resets to default on pod restart (not persisted).
 *
 * Separated into its own module to avoid circular imports between
 * index.js and the router modules.
 */

// Valid modes: 'keyword' | 'llm'
export const routerState = {
    mode: 'keyword'
};

/**
 * Handle a /mode chat command. Returns { message } if the input is a /mode
 * command, null otherwise. Mutates routerState.mode on valid mode switches.
 */
export function handleModeCommand(message) {
    if (!message.startsWith('/mode')) return null;

    const parts = message.trim().split(/\s+/);
    const cmd = parts[1];

    switch (cmd) {
        case 'llm':
            routerState.mode = 'llm';
            console.log(`[Mode] Switched to LLM routing`);
            return { message: 'Switched to LLM routing mode.' };
        case 'keyword':
            routerState.mode = 'keyword';
            console.log(`[Mode] Switched to keyword routing`);
            return { message: 'Switched to keyword routing mode.' };
        case 'status':
            return { message: `Current routing mode: ${routerState.mode}` };
        default:
            return { message: 'Usage: /mode llm | /mode keyword | /mode status' };
    }
}
