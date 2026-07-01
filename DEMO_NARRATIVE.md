# Workforce Portal AI Agent Demo — CTO Narrative

## Executive Summary: What This App Does

**This is a reference implementation showing how Ping Identity secures AI-powered agents with enterprise-grade identity, authorization, and token exchange.**

In plain terms:
- **Problem**: Organizations want AI agents (Chat, Travel Planning, Expense Reports) but need security, auditability, and control
- **Solution**: Ping provides the identity fabric that sits between users and AI agents, adding authentication, authorization, and granular access control
- **Benefit**: Your AI agents inherit enterprise security without rewriting them

---

## The Tech Stack: 5-Minute Version

| Component | Role | Why Ping? |
|-----------|------|-----------|
| **PingFederate** | Identity Provider (IdP) | Authenticates users (who are you?) |
| **PingAuthorize** | Policy Decision Point (PDP) | Decides what agents/tools users can access (what can you do?) |
| **PingGateway** | API Gateway + Token Exchange | Sits between user and AI agents, enforces policy, exchanges tokens |
| **MCP Servers** | Tool Providers | Finance tools (expenses), Travel tools (flights), etc. |
| **AI Agents** | Orchestrators | Use LLM + MCP tools to answer user queries |

---

## Reference Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ User Browser (Portal UI)                                     │
│  - Shows agent dropdown (Workforce AI, Trip Planner)        │
│  - Sends user message: "Show my expenses" or "Book a flight"│
└────────────┬──────────────────────────────────────────────┘
             │ 1. User sends query
             ▼
┌─────────────────────────────────────────────────────────────┐
│ PingAccess (Session Management + OIDC)                       │
│  - Validates browser session                                │
│  - Verifies OIDC token from PingFederate                    │
│  - Acts as BFF (Backend for Frontend)                       │
└────────────┬──────────────────────────────────────────────┘
             │ 2. Routes to appropriate agent
             ▼
┌─────────────────────────────────────────────────────────────┐
│ PingGateway (OAuth2 Resource Server + Token Exchange)        │
│  - Validates Bearer token in request                        │
│  - Extracts user identity + scopes                          │
│  - RFC 8693: Exchanges user token for RESOURCE-SCOPED token│
│    (workforce-ai-agent or trip-planner-agent audience)      │
│  - Applies Authz policy via PingAuthorize                   │
│  - Blocks if user lacks permission for this agent/action    │
└────────────┬──────────────────────────────────────────────┘
             │ 3. Scoped token + policy check passed
             ▼
┌─────────────────────────────────────────────────────────────┐
│ AI Agent (Python AG-UI Server)                               │
│  - Receives: user query + scoped token                       │
│  - Decision: Which MCP tools should I call?                 │
│  - Calls LLM: "Should I invoke Finance tools or Travel?"    │
│  - LLM says: "Use Expense MCP server"                       │
└────────────┬──────────────────────────────────────────────┘
             │ 4. Agent invokes MCP tool
             ▼
┌─────────────────────────────────────────────────────────────┐
│ MCP Server (Tool Provider)                                   │
│  - Receives: Tool request + scoped token                    │
│  - Example: "Get expenses for user in Q3 2025"             │
│  - Returns: Structured data (JSON)                          │
└────────────┬──────────────────────────────────────────────┘
             │ 5. Tool result back to agent
             ▼
┌─────────────────────────────────────────────────────────────┐
│ AI Agent (LLM Synthesis)                                     │
│  - Gets tool results                                        │
│  - Feeds to LLM: "User asked X, tools returned Y, answer:" │
│  - Generates natural language response                      │
└────────────┬──────────────────────────────────────────────┘
             │ 6. Streams response back to browser
             ▼
┌─────────────────────────────────────────────────────────────┐
│ Browser (Portal UI)                                          │
│  - Displays agent response                                  │
│  - Shows tool provenance: "Used Finance MCP - Expenses"     │
└─────────────────────────────────────────────────────────────┘
```

---

## The Identity Security Layer (Why Ping Matters)

### PingFederate: Who Are You?
**What it does**: Authenticates the user logging into the portal
- User navigates to portal → redirected to PingFederate login
- PingFederate validates credentials (username/password, MFA, etc.)
- Returns OIDC token with user identity + claims (department, role, manager, etc.)
- Token contains: `sub` (user ID), `email`, `groups`, `roles`, `aud` (audience)

**Demo highlight**: "At login, we capture the user identity and their organizational context. This becomes the foundation for everything downstream."

---

### PingGateway: The Boundary Guard

**What it does**: Acts as the gateway between portal and AI agents. Three critical functions:

#### 1. Token Validation
- Every API call from browser must include Bearer token from PingFederate
- PingGateway validates the token signature and expiration
- If invalid/expired → 401 Unauthorized (user must re-login)

#### 2. RFC 8693 Token Exchange
**The Security Innovation**: Instead of giving the AI agent the user's full token, we **exchange it for a resource-scoped token**

```
Step 1: User's token (very broad powers)
  {
    "sub": "user123",
    "email": "alice@company.com",
    "groups": ["sales", "finance"],
    "roles": ["manager", "agent-user"],
    "aud": "all-company-apps",
    "scope": "openid profile email"
  }

        ↓ RFC 8693 Token Exchange ↓

Step 2: Resource-scoped token (limited to this agent)
  {
    "sub": "user123",
    "email": "alice@company.com",
    "aud": "workforce-ai-agent",  ← SCOPED to just this agent
    "actor": "gateway",  ← Token Exchange metadata
    "act_scope": "read:expenses"  ← Limited to expenses action only
  }
```

**Why this matters**: If the agent is compromised, attacker only has scoped token (can't access other agents or unrelated data).

#### 3. Authorization Policy (PingAuthorize Integration)
Before routing to the agent, PingGateway asks PingAuthorize: **"Can this user call this agent?"**

Example policies:
- Only Finance team can use Expense agent
- Only managers can access Revenue agent
- All users can access Trip Planner (public)
- Contractors blocked from accessing payroll MCP tools

**Demo highlight**: "At the gateway, we enforce organizational policies. Users are automatically scoped to agents they're authorized for. A sales rep can't snoop on finance data even if they tried."

---

### PingAuthorize: What Can You Do?

**What it does**: Policy Decision Point (PDP) that evaluates authorization requests

**Policy evaluation happens at multiple levels**:

1. **Agent Level**: Can this user even call the Expense agent?
   - Policy: `department == "finance" OR role == "manager" → allow`

2. **Tool Level**: Which MCP tools can this user invoke?
   - Policy: `call to MCP.Finance.getAllExpenses is denied for contractor users`

3. **Data Level**: What data can this user see in tool results?
   - Policy: `remove salary field from expense data if user not in finance`

**In our demo**:
- Workforce AI Agent is restricted to Finance/HR teams
- Trip Planner is open to all (no sensitive data)
- Each agent enforces different policies

**Demo highlight**: "Even if a user somehow bypasses the agent layer, PingAuthorize blocks unauthorized tool access at the MCP boundary. You have defense in depth."

---

## Demo Flow: Click-by-Click Breakdown

### SCENE 1: Login & Identity Capture

**What you see**: Portal login screen
```
Username: alice@company.com
Password: ••••••••
[Login]
```

**What's happening behind the scenes**:
1. Portal calls `/api/auth/login` (Express backend)
2. Backend redirects to PingFederate: `https://pingfederate.localhost/oauth/authorize?client_id=portal&redirect_uri=...`
3. User enters credentials
4. PingFederate validates against LDAP/database
5. PingFederate returns authorization code
6. Backend exchanges code for ID token + access token (OIDC Code Flow + PKCE)
7. Tokens stored in Express session (secure HttpOnly cookie)
8. Portal displays: **Agent Picker + Chat Box**

**Technical Stack in Use**:
- ✅ PingFederate: OAuth2 + OIDC
- ✅ Express: Session management
- ✅ No MCP yet (just identity)

**CTO Talking Point**: "Notice we're using OAuth2 OIDC with PKCE — this is industry standard for securing web apps. The user's token is never exposed to the browser; it's held server-side."

---

### SCENE 2: Agent Selection & Authorization

**What you see**: Dropdown with two agents
```
Select Agent:
[ Workforce Assistant v ]
[ Trip Planner        ]
```

**What's happening**:
1. Portal frontend lists available agents (hardcoded or from `/api/agents` endpoint)
2. **Behind the scenes**: Portal backend could filter this list based on user's token claims
   - Extract `groups` from token: `["sales", "finance"]`
   - PingAuthorize says: "finance group can see Workforce Agent" ✓
   - PingAuthorize says: "all users can see Trip Planner" ✓
   - Display both

**If user was contractor** (hypothetically):
- PingAuthorize blocks access to Workforce Agent
- Only Trip Planner shows up

**Technical Stack in Use**:
- ✅ PingFederate: Token claims (groups, roles)
- ✅ PingAuthorize: Policy evaluation
- ✅ No MCP yet

**CTO Talking Point**: "Authorization happens early. Users only see agents they're permitted to use. This prevents confusion and reduces security surface."

---

### SCENE 3: User Sends Query to Workforce Agent

**What you see**: 
```
Agent: Workforce Assistant
Message: "Show me my Q3 expenses"
[Send]
```

**Technical Flow**:

```
Step 1: Portal sends HTTP request
─────────────────────────────────
POST /api/agent/run
Authorization: Bearer eyJhbGci... (user's original token from PingFederate)
Content-Type: application/json
{
  "message": "Show me my Q3 expenses",
  "agent": "workforce-assistant"
}

Step 2: PingAccess (BFF) receives request
──────────────────────────────────────────
- Validates Bearer token against PingFederate JWKS (public key set)
- Extracts claims: sub=alice123, email=alice@company.com, groups=[finance]
- Checks PingAuthorize: "Can alice call workforce-assistant?"
- PingAuthorize responds: "YES, she's in finance group"

Step 3: Portal backend creates new token exchange request
──────────────────────────────────────────────────────────
- Takes user's token
- Calls PingGateway Token Exchange endpoint (RFC 8693)
- Sends: { assertion: user_token, resource: "workforce-ai-agent" }

Step 4: PingGateway performs Token Exchange
─────────────────────────────────────────────
- Validates user token
- Creates NEW scoped token with:
  - aud: "workforce-ai-agent" (only valid for this agent)
  - act_scope: "read:expenses" (limited to expense queries)
  - Original user claims: sub, email, groups
- Returns scoped token: eyJhbGci... (NEW, narrow-scoped token)

Step 5: Portal backend calls Workforce Agent
──────────────────────────────────────────────
GET /api/agent/run?message=Show%20me%20my%20Q3%20expenses
Authorization: Bearer eyJhbGci... (SCOPED token, not original)
Accept: text/event-stream
MCP-Session-Id: session-12345

Step 6: Workforce Agent receives request
──────────────────────────────────────────
- Validates scoped token: aud must be "workforce-ai-agent" ✓
- Extracts user ID: alice123
- Extracts user groups: finance
- Ready to process query
```

**Key Security Checkpoint**: Notice the scoped token is **different** from the original token. If this request is logged/leaked, attacker can only impersonate calls to Workforce Agent, not other agents.

**MCP/Tools invoked**: None yet (agent hasn't called tools)

**Technical Stack in Use**:
- ✅ PingFederate: Original OIDC token
- ✅ PingAccess: BFF routing + token validation
- ✅ PingAuthorize: Policy check ("can alice use workforce?")
- ✅ PingGateway: Token Exchange (RFC 8693)
- ✅ Agent: Token validation

**CTO Talking Point**: "Watch how the token changes. We exchange the user's broad token for a narrow, agent-specific token. This is RFC 8693 token exchange — a NIST standard for delegation in OAuth2. Even if the agent server is compromised, the attacker's access is limited to that specific agent's scope."

---

### SCENE 4: Agent Decides Which MCP Tool to Use

**What you see**: 
```
Agent (loading...)
Delegating to sub-agents
Fetching expenses from Finance MCP...
```

**What's happening**:

1. **Agent receives query**: "Show me my Q3 expenses"
2. **Agent calls LLM**: "Given this question, should I invoke the Expense MCP tool?"
   - LLM has access to MCP tool registry (discovered via plugin discovery)
   - LLM sees: Finance MCP tool available with schema
   - LLM decides: YES, invoke Expense tool with user_id=alice123, quarter=Q3
3. **Agent invokes MCP**: Calls Expense MCP Server with scoped token
4. **MCP Server validates**: Receives scoped token, verifies aud=workforce-ai-agent
5. **MCP Server checks**: "Can user alice (from token) access Q3 expenses?"
   - Could call PingAuthorize again for fine-grained check
   - Or has local policy: all users in finance group can see their own expenses
6. **MCP Server returns data**: JSON array of expenses
7. **Agent gets results**: Feeds to LLM along with original query
8. **LLM synthesizes**: Creates natural language response

**MCP/Tools invoked**: 
- ✅ **Expense MCP Tool**: `getExpensesByUserAndQuarter(user_id, quarter)`

**Technical Stack in Use**:
- ✅ AG-UI Protocol: Server-Sent Events (SSE) streaming
- ✅ LLM (Ollama): Decision making (which tool to call)
- ✅ MCP: Tool discovery + execution
- ✅ PingGateway: Scoped token passed to MCP
- ✅ PingAuthorize: Could be called by MCP for data-level authz

**CTO Talking Point**: "The magic happens here. The LLM doesn't just make stuff up — it has access to real tools. The MCP registry tells the LLM what's available. And because the token is scoped, the MCP server knows this request is legitimate and resource-limited. The LLM can't suddenly call a Travel tool or access salary data — the token audience is locked to this agent."

---

### SCENE 5: MCP Tool Execution & Data Return

**What you see**:
```
Agent streaming...
Found 3 expenses for Q3 2025:
- Conference attendance: $5,000
- Client entertainment: $2,300
- Software licenses: $1,500
Total: $8,800
```

**What's happening**:

```
Agent → MCP Server Call
─────────────────────────
POST /call/getExpensesByUserAndQuarter
Authorization: Bearer eyJhbGci... (scoped token)
{
  "user_id": "alice123",
  "quarter": "Q3",
  "year": 2025
}

MCP Server Processing
─────────────────────
1. Validates token: aud == "workforce-ai-agent" ✓
2. Extracts user_id from token.sub
3. Checks policy: User alice can access alice's expenses ✓
4. Queries Finance database (internal API)
5. Returns structured data:
   {
     "expenses": [
       {"id": 1, "amount": 5000, "category": "Conference", "date": "2025-09-15"},
       {"id": 2, "amount": 2300, "category": "Entertainment", "date": "2025-08-20"},
       {"id": 3, "amount": 1500, "category": "Software", "date": "2025-07-10"}
     ]
   }

Agent LLM Synthesis
────────────────────
Prompt to LLM:
  "User asked: 'Show me my Q3 expenses'
   Tool returned: [expense data above]
   Generate a friendly summary."

LLM Response:
  "You had 3 expenses in Q3 2025 totaling $8,800..."

Agent Streams to Browser
─────────────────────────
Event: TEXT
  "You had 3 expenses in Q3 2025..."

Event: CUSTOM
  {
    "tool": "Finance.Expenses",
    "result": "[3 expenses found]"
  }
```

**Security in Action**:
- MCP server only ever saw the scoped token (narrow access)
- MCP server enforced user isolation (alice can only see alice's expenses)
- Token audience `workforce-ai-agent` prevents cross-agent abuse
- Response is streamed back, never persisted (no data sitting around)

**MCP/Tools in use**:
- ✅ **Expense MCP**: `getExpensesByUserAndQuarter()`

**Technical Stack**:
- ✅ MCP Server: Tool execution with fine-grained authz
- ✅ PingGateway: Scoped token validation at MCP boundary
- ✅ LLM: Synthesis
- ✅ AG-UI: Streaming events to browser

**CTO Talking Point**: "Here's the end-to-end identity story: User logged in with PingFederate. Token was scoped by PingGateway using RFC 8693. MCP server received the scoped token and enforced its own policies. The tool only returned data the user was authorized to see. No token creep, no privilege escalation, no data leakage. This is defense in depth with identity at the center."

---

### SCENE 6: Switch to Trip Planner Agent

**What you see**:
```
Select Agent: [ Trip Planner v ]
Message: "Plan a trip from Lyon to Bristol"
[Send]
```

**What's different**:

1. **Authorization check**: PingAuthorize: "Can alice use Trip Planner?"
   - Policy: Everyone can use Trip Planner (no restriction)
   - Response: YES ✓

2. **Token exchange**: Different resource scope
   - Original scope: all-users
   - New scoped token aud: **"trip-planner-agent"** (not "workforce-ai-agent")
   - New act_scope: "plan:trips" (not "read:expenses")

3. **Agent decision**: "Which tools can I invoke?"
   - Workforce Agent sees: Finance MCP
   - Trip Planner Agent sees: Travel MCP (flights, hotels, destinations)

4. **LLM calls tool**: "Get available hotels in Bristol for 2025-09-20"

5. **MCP Server invokes**:
   - Hotel MCP: `searchHotels(city="Bristol", date="2025-09-20")`
   - Flight MCP: `searchFlights(from="Lyon", to="Bristol")`

6. **Results synthesized**: LLM creates travel itinerary

**MCP/Tools invoked**:
- ✅ **Hotel MCP**: `searchHotels()`
- ✅ **Flight MCP**: `searchFlights()`
- ✅ **Travel MCP**: `getDestinationInfo()` (weather, attractions, etc.)

**Security Model**: Same as Workforce, but with **different scoped token** for this agent

**CTO Talking Point**: "Notice the token switched scopes automatically. From `workforce-ai-agent` to `trip-planner-agent`. This is the power of token exchange — each agent gets its own credential, scoped to its own tools. If Trip Planner is hacked, Finance data is still safe (attacker's token won't grant access)."

---

## The Complete Security Story (5-Minute Elevator Pitch)

### Problem Statement
*"Most organizations want AI agents because they increase productivity. But:*
- *How do you authenticate users?*
- *How do you prevent agents from accessing data they shouldn't?*
- *How do you audit who called what?*
- *How do you prevent one compromised agent from accessing everything?"*

### Ping's Solution (Three Layers)

**Layer 1: Authentication (PingFederate)**
- Users login once with their identity
- Identity claims (department, role, manager) are captured
- Used throughout the system for context

**Layer 2: Authorization (PingAuthorize)**
- Every agent access is checked against organizational policies
- Users only see agents they're authorized for
- MCP tools enforce data-level access control
- Policies can be updated centrally without touching agent code

**Layer 3: Token Exchange (PingGateway + RFC 8693)**
- Instead of giving agents full user token, we exchange it for scoped tokens
- Each agent gets a token good only for that agent
- MCP tools only see scoped tokens (limited privilege)
- If one agent is compromised, damage is isolated

### Business Impact
✅ **Security**: Multi-layer defense, minimal blast radius  
✅ **Compliance**: Audit trail (who called what when)  
✅ **Control**: Policies apply uniformly, no hardcoding  
✅ **Developer Friendly**: Agents don't rewrite auth logic  

**CTO Closing**: *"This is how you scale AI safely in the enterprise. Identity isn't a nice-to-have — it's foundational."*

---

## Technical Deep Dive for Technical Audiences

### Token Exchange Flow (RFC 8693 / Token Delegation)

```
User has this token:
{
  iss: "https://pingfederate.localhost",
  sub: "alice123",
  aud: "portal",
  scope: "openid profile email read:finance read:travel",
  groups: ["finance", "sales"]
}

Portal backend calls PingGateway Token Exchange:
POST /token
grant_type: urn:ietf:params:oauth:grant-type:token-exchange
subject_token: <user's token>
subject_token_type: urn:ietf:params:oauth:token-type:jwt
resource: workforce-ai-agent
audience: workforce-ai-agent

PingGateway validates original token, creates new token:
{
  iss: "https://pingfederate.localhost",
  sub: "alice123",
  aud: "workforce-ai-agent",
  actor: {
    sub: "portal-backend"
  },
  act_scope: "read:expenses"
}

New token ONLY valid for:
- Audience: workforce-ai-agent
- Actions: read expenses
- Original user context preserved: sub=alice123
```

### MCP Tool Discovery & Binding

**At agent startup**:
1. Agent queries MCP registry: "What tools are available?"
2. Registry returns: Finance MCP (expenses, budgets), Travel MCP (flights, hotels)
3. Agent stores schema locally

**At runtime (user sends query)**:
1. Agent calls LLM: "Given query, which tools should I invoke?"
2. LLM sees tool schemas and decides
3. Agent invokes MCP with scoped token
4. MCP validates token audience matches its own identity
5. MCP executes tool, returns data
6. Agent feeds data to LLM for synthesis

### Authorization Decision Flow

```
Portal receives request with Bearer token
         ↓
PingAccess validates token signature
         ↓
PingAccess extracts claims (sub, groups, roles)
         ↓
Portal backend asks PingAuthorize:
  "Can user=alice, action=call_workforce_agent?"
         ↓
PingAuthorize evaluates policies:
  if (user.groups contains "finance") {
    allow = true
  }
         ↓
Response: ALLOW or DENY
         ↓
If ALLOW: Proceed to token exchange
If DENY: Return 403 Forbidden
```

### Data-Level Authorization (In MCP Tools)

```
MCP server receives call:
  GET /expenses?user_id=bob&quarter=Q3
  Authorization: Bearer <scoped_token for alice>

MCP server validates:
  token.sub = "alice123" (not bob)
         ↓
MCP server asks PingAuthorize:
  "Can alice (token.sub) access bob's expenses?"
         ↓
Response: NO (users can only see their own expenses)
         ↓
MCP server returns 403 or empty result
         ↓
Prevents horizontal privilege escalation
```

---

## Demo Checklist for CTO Presentation

**Before demo**:
- [ ] PingFederate running at https://pingfederate.localhost
- [ ] PingGateway running (port 8443)
- [ ] Portal accessible at https://portal-external.localhost/workforce-portal
- [ ] Ollama running (for LLM fallback)
- [ ] MCP servers running (Expense, Travel)
- [ ] Browser DevTools open (Network tab) to show token exchanges

**During demo**:
- [ ] **5 min**: Show login flow, capture OIDC token (Network tab)
- [ ] **3 min**: Show agent dropdown, explain authorization (which agents visible)
- [ ] **5 min**: Send Workforce query, watch token exchange in Network tab
  - Show original token: broad scopes
  - Show scoped token: narrow audience
- [ ] **5 min**: Send Trip Planner query, show tool invocation
  - Show MCP tool calls in Network tab
  - Show scoped token passed to MCP
- [ ] **5 min**: Q&A on security model

**Talking points**:
1. "User authenticates once (PingFederate), identity flows through entire system"
2. "Each agent gets a scoped token — defense in depth"
3. "MCP tools enforce policies at the execution layer"
4. "Audit trail: every call includes user context"
5. "Scale this to 10,000 agents; policies apply uniformly"

---

## Key Differentiators (Why Ping vs. OpenAI / Azure AI)

| Feature | Ping | OpenAI API | Azure AI |
|---------|------|-----------|---------|
| On-premises deployment | ✓ | ✗ | ✓ (Azure) |
| Token exchange (RFC 8693) | ✓ | ✗ | Limited |
| Fine-grained authz policies | ✓ | ✗ | ✓ (RBAC) |
| MCP tool orchestration | ✓ | ✓ | ✓ |
| User isolation at gateway | ✓ | ✗ | Limited |
| Scoped token delegation | ✓ | ✗ | ✗ |
| Identity provider agnostic | ✓ | ✗ | ✓ (Azure AD only) |

**Your value prop**: "Ping makes AI agents enterprise-ready. We handle identity, authorization, and delegation. You focus on agent logic."

---

## Q&A Prep

**Q: "Why do we need token exchange? Can't agents just use user tokens?"**

A: "You could, but then a compromised agent has full user access. With token exchange, we scope the token to just that agent. Attacker can only abuse that agent, not the whole identity system."

---

**Q: "What if a user is not authorized for an agent?"**

A: "PingAuthorize blocks the request before it reaches the agent. User gets a 403 error. The agent never even knows about unauthorized requests."

---

**Q: "How do you audit who called what?"**

A: "Every token has user context (sub, groups). Every API call logs the token + action. You can query: 'Who called getExpenses? When? From which agent?'"

---

**Q: "Can we use this with LDAP / Active Directory?"**

A: "Yes. PingFederate can authenticate against any identity store (LDAP, AD, SAML, OIDC). The portal doesn't care where users come from."

---

**Q: "What about LLM jailbreaks? Can a hacker trick the agent into ignoring the token?"**

A: "The token validation happens at the infrastructure layer (PingGateway), not in app code. The agent receives a token from PingGateway; it can't bypass that. And the MCP server validates the token again. Double-check."

---

## Files to Show During Demo

1. **Portal Config** (`js/config.js`): Shows agent endpoints + PingAccess routing
2. **Portal Backend** (Express): Shows `/api/agent/run` → token exchange → agent call
3. **Agent Code** (router.py): Shows tool invocation decision logic
4. **MCP Tool** (Expense MCP): Shows token validation + data access control

---

**Next: Book time with CTO champion to walk through live demo. Send this document beforehand so they come prepared.**
