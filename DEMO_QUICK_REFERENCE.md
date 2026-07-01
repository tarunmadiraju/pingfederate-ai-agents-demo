# CTO Demo — Quick Reference Card (1-Page)

## The Pitch (30 seconds)

*"Most companies want AI agents but struggle with security. They ask: How do I authenticate users? How do I control what data they access? How do I prevent one hacked agent from compromising everything? Ping solves this by putting identity at the center of AI — securing agents the way you'd secure APIs. With authentication, fine-grained authorization, and token exchange, you get enterprise-grade control without rewriting agent code."*

---

## Demo Narrative (Walk-Through)

### 1. LOGIN (Identity Capture)
**Show**: Browser login screen
```
User: alice@company.com
Password: •••••••
```
**Say**: "Notice we're using OAuth2 OIDC. User logs in once. PingFederate captures their identity — department, role, groups. This context flows through the entire system."

**Check**: Open DevTools Network tab → Look for `/oauth/authorize` request

---

### 2. AGENT PICKER (Authorization Gate)
**Show**: Dropdown with agents
```
[ Workforce Assistant v ]
[ Trip Planner        ]
```
**Say**: "You see two agents here. Behind the scenes, PingAuthorize checked your policies. A contractor would only see Trip Planner. A finance person sees both. Authorization happens before the agent is even called."

**Technical point**: "PingAuthorize evaluates: `if (user.groups contains "finance") allow Workforce Agent`"

---

### 3. QUERY → TOKEN EXCHANGE (The Security Magic)
**Show**: Send message "Show me my Q3 expenses"

**In DevTools Network tab**, show two token requests:
1. First token (from login): `"aud": "portal"`, broad scopes
2. Second token (from token exchange): `"aud": "workforce-ai-agent"`, scoped

**Say**: "Here's the innovation. Your browser has a broad token from login. But before calling the agent, we EXCHANGE it for a narrow, agent-specific token using RFC 8693 token exchange. Now the agent only has access to this one agent's scope. If this agent is hacked, the attacker can't call other agents or access other data."

**Key callout**: "This is NIST standard token delegation. Defense in depth."

---

### 4. AGENT CALLS MCP TOOL (Tool Orchestration)
**Show**: Agent streams response
```
Fetching expenses...
Found 3 expenses for Q3 2025:
- Conference: $5,000
- Entertainment: $2,300
- Software: $1,500
```

**In DevTools**, show:
- Agent → MCP Server call (POST /call/getExpensesByUserAndQuarter)
- Scoped token in Authorization header
- MCP Server response (JSON data)

**Say**: "The agent decided it needs the Expense tool. It called the MCP server with the scoped token. The MCP server validated the token — checked the audience, extracted the user ID, enforced data access control. User can only see their own expenses. This is authorization at the execution layer."

**Technical detail**: "MCP server checked: `if (token.sub == expense_owner) allow else deny`"

---

### 5. SWITCH TO TRIP PLANNER (Different Agent, Different Token Scope)
**Show**: Send "Plan a trip from Lyon to Bristol"

**Say**: "Now we're switching agents. Notice the token changes AGAIN. New aud = `trip-planner-agent`. New act_scope = `plan:trips`. We're not reusing the Workforce token — that's locked to the Workforce agent. Each agent gets its own credential."

**In DevTools**, show new token exchange request with different resource

---

### 6. TRIPLE-LAYER SECURITY (Sum Up)

**Say**: "What you just saw is three layers of security:

**Layer 1 — Authentication (PingFederate)**: User logged in once. Identity is known.

**Layer 2 — Authorization (PingAuthorize)**: Every agent access is checked against policy. User only sees agents they're authorized for.

**Layer 3 — Token Exchange (PingGateway + RFC 8693)**: Each agent gets a scoped token. Attacker can't abuse one compromised agent to hit other agents. Minimal blast radius.

This is how you scale AI safely."

---

## DevTools Checklist (Things to Show During Demo)

- [ ] Network tab → POST /oauth/authorize (OIDC login)
- [ ] Network tab → POST /token (Token exchange request)
- [ ] Token 1: `aud: portal` (broad)
- [ ] Token 2: `aud: workforce-ai-agent` (narrow)
- [ ] Network tab → MCP call with scoped token
- [ ] Response: Expense data (not salary data — authz at MCP level)
- [ ] Switch agent → New token exchange with different aud
- [ ] Token 3: `aud: trip-planner-agent`

---

## Objections & Comebacks

**Objection**: "This is too complex. Can't we just let agents use user tokens?"

**Comeback**: "You could, but then one hacked agent has full access to everything the user can do. With scoped tokens, blast radius is limited to that agent. Enterprise security principle: least privilege."

---

**Objection**: "Doesn't token exchange slow things down?"

**Comeback**: "Token exchange is a one-time API call (~10ms). Compared to LLM inference (seconds), it's negligible. And you get enterprise security in return."

---

**Objection**: "Our CISO won't approve AI agents."

**Comeback**: "CISO's job is risk management. Ping reduces risk: strong authentication, fine-grained authz, audit trail, token isolation. This is the security model your CISO wants for APIs — we're applying it to agents."

---

**Objection**: "What about prompt injection? Can a hacker trick the LLM?"

**Comeback**: "Prompt injection is a separate concern (defense at app layer). But token injection is prevented here. The token is validated at infrastructure (PingGateway + MCP server). App logic can't bypass it."

---

## Talking Points (Memorize These)

1. **"Authentication + Authorization + Token Exchange = Enterprise AI"**
   - PingFederate: Who are you?
   - PingAuthorize: What can you do?
   - PingGateway: Limited scope + audit trail

2. **"RFC 8693 token exchange is NIST standard for delegation"**
   - Not Ping invention, industry standard
   - Proven in OAuth2 community

3. **"Every API call has user context"**
   - Sub (user ID), groups, roles
   - Query later: "Who called this? When? From which agent?"
   - Compliance: Audit trail built in

4. **"Scoped tokens = Defense in depth"**
   - One hacked agent ≠ entire system compromised
   - Attacker only has narrow token scope

5. **"Policy-driven, not code-driven"**
   - Policies in PingAuthorize, not hardcoded in agents
   - Change policy centrally, applies everywhere

---

## Slide Outline (If Presenting)

**Slide 1**: Problem statement
- "AI agents are great for productivity"
- "But: How do you secure them?"

**Slide 2**: Ping's solution (reference architecture diagram)
- PingFederate → PingAuthorize → PingGateway → Agents → MCP Tools

**Slide 3**: Three layers of security
- Layer 1: Authentication
- Layer 2: Authorization
- Layer 3: Token Exchange

**Slide 4**: Live demo walkthrough
- Login → Agent picker → Query → Token exchange → MCP call → Response

**Slide 5**: Why it matters
- Compliance ✓
- Least privilege ✓
- Audit trail ✓
- Defense in depth ✓

**Slide 6**: Q&A

---

## Time Budget

- Intro + problem statement: 2 min
- Architecture overview: 3 min
- Live demo walkthrough: 8 min
- Security deep-dive: 3 min
- Q&A: 4 min
- **Total: 20 minutes**

---

## Before You Demo

**Checklist**:
- [ ] PingFederate up and healthy
- [ ] PingGateway running
- [ ] Portal loading at https://portal-external.localhost/workforce-portal
- [ ] Ollama running for LLM
- [ ] MCP servers running (Expense, Travel)
- [ ] Test login as alice@company.com (or test user)
- [ ] Test both agents (Workforce, Trip Planner)
- [ ] DevTools open in separate window
- [ ] Network tab filtering: Show only API calls (filter by "/api")

---

## Post-Demo Handoff

If prospect is interested, schedule:
1. **Technical deep-dive** (30 min) — PingGateway config, MCP integration, authorization policies
2. **Integration workshop** (2 hours) — How to connect their existing agents to Ping
3. **Proof of concept** (1-2 weeks) — Deploy with their LDAP/AD, test with their data

---

## Competitive Positioning

| Question | Ping | OpenAI | Azure |
|----------|------|--------|-------|
| On-prem AI agents? | ✓ | ✗ | Limited |
| Token exchange? | ✓ | ✗ | ✗ |
| User isolation at gateway? | ✓ | ✗ | ✗ |
| Fine-grained authz? | ✓ | ✗ | Partial |
| Scoped token per agent? | ✓ | ✗ | ✗ |

**Your message**: "Ping makes AI agents enterprise-ready with identity. We're the identity platform for AI."
