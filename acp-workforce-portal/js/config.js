/**
 * Workforce Portal Configuration
 *
 * PingAccess handles OIDC authentication (BFF pattern).
 * The browser never sees tokens — only the session cookie.
 *
 * Two AG-UI orchestrators:
 *   workforce — Workforce AI Agent (expenses, budget reports)
 *   trip-planner — Trip Planner AI Agent (travel planning, flights, hotels)
 * The active agent is tracked client-side by agentClient.setCurrentAgent().
 */
const CONFIG = {
    agents: {
        // Workforce AI Agent — routed through PA at /api (PA's WorkforceAgentAPI
        // app injects a PA-signed JWT via AgentJwtMapping with audience
        // workforce-ai-agent). The browser sends requests same-origin; the PA
        // session cookie authenticates the user. Handles expenses and budget reports.
        workforce: {
            label: 'Workforce Assistant',
            endpoints: {
                health: '/api/health',
                agentRun: '/api/agent/run',
                agentResource: '/api/agent/resource'
            }
        },
        // Trip Planner AI Agent — routed through PA at /api/trip-planner (PA's
        // TripPlannerAgentAPI app injects a PA-signed JWT via AgentJwtMapping with
        // audience trip-planner-agent). Handles travel planning, flights, hotels.
        'trip-planner': {
            label: 'Trip Planner',
            endpoints: {
                health: '/api/trip-planner/health',
                agentRun: '/api/trip-planner/run',
                agentResource: '/api/trip-planner/resource'
            }
        }
    },
    defaultAgent: 'workforce',

    // User identity endpoint (PA Header Identity Mapping → Express /workforce-portal/me)
    // Under /workforce-portal context root so it's protected by PA's Web application (OIDC session)
    identity: {
        meEndpoint: '/workforce-portal/me'
    },

    // UI settings
    ui: {
        appName: 'Acme Corp Workforce Portal',
        assistantName: 'Workforce Assistant'
    }
};

Object.freeze(CONFIG);
Object.freeze(CONFIG.agents);
Object.freeze(CONFIG.agents.workforce);
Object.freeze(CONFIG.agents.workforce.endpoints);
Object.freeze(CONFIG.agents['trip-planner']);
Object.freeze(CONFIG.agents['trip-planner'].endpoints);
Object.freeze(CONFIG.identity);
Object.freeze(CONFIG.ui);
