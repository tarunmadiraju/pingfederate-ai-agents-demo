# MCP Tools & Integration Reference

## What is MCP?

**Model Context Protocol** — A standard way for AI agents to discover and call external tools.

Instead of an agent being hardcoded to call specific APIs, MCP lets the agent:
1. **Discover** what tools are available (and their schemas)
2. **Decide** which tools to call based on user query
3. **Execute** tools with user context (scoped token)
4. **Process** results and return to user

---

## In This Demo: Available Tools

### 1. WORKFORCE AI AGENT Tools

#### Tool: getExpensesByUserAndQuarter
**Purpose**: Retrieve user's expenses for a specific quarter
```
Query: "Show me my Q3 expenses"
       ↓
Agent LLM decides: Use Expense MCP tool
       ↓
Calls: getExpensesByUserAndQuarter(user_id=alice, quarter=Q3, year=2025)
       ↓
Returns:
{
  "expenses": [
    {"id": 1, "amount": 5000, "category": "Conference", "date": "2025-09-15"},
    {"id": 2, "amount": 2300, "category": "Entertainment", "date": "2025-08-20"},
    {"id": 3, "amount": 1500, "category": "Software", "date": "2025-07-10"}
  ],
  "total": 8800
}
       ↓
Agent LLM synthesizes: "You had 3 expenses in Q3..."
```

**Tool Authorization Level**:
- User can only see their own expenses (data-level authz enforced at MCP)
- Finance users can approve expenses
- Finance admins can view all company expenses

**Security**: MCP validates scoped token before executing

---

#### Tool: submitExpenseReport
**Purpose**: Submit expense report for manager approval
```
Query: "I need to submit my expenses for reimbursement"
       ↓
Agent LLM decides: Use Expense MCP tool
       ↓
Calls: submitExpenseReport(user_id=alice, expenses=[...], amount=8800)
       ↓
Returns:
{
  "status": "submitted",
  "report_id": "rpt-12345",
  "manager_id": "manager-bob",
  "pending_since": "2025-11-20T14:30Z"
}
```

**Security**: Only user who submitted expenses can withdraw (no cross-user access)

---

#### Tool: getReportStatus
**Purpose**: Check status of submitted expense reports
```
Query: "Where's my expense report?"
       ↓
Agent LLM decides: Use Expense MCP tool
       ↓
Calls: getReportStatus(user_id=alice, report_id=rpt-12345)
       ↓
Returns:
{
  "report_id": "rpt-12345",
  "status": "pending_manager_approval",
  "manager": "bob@company.com",
  "submitted_on": "2025-11-20",
  "estimated_approval": "2025-11-24"
}
```

---

#### Tool: getBudgetRemaining
**Purpose**: Check remaining budget for current quarter
```
Query: "How much budget do I have left?"
       ↓
Agent LLM decides: Use Finance MCP tool
       ↓
Calls: getBudgetRemaining(user_id=alice, quarter=Q4)
       ↓
Returns:
{
  "budget_allocated": 10000,
  "amount_spent": 7500,
  "remaining": 2500,
  "quarter": "Q4 2025"
}
```

**Security**: Only user's budget visible (data-level isolation)

---

### 2. TRIP PLANNER AGENT Tools

#### Tool: searchHotels
**Purpose**: Search available hotels in a destination
```
Query: "Show me available hotels in Paris"
       ↓
Agent LLM decides: Use Travel MCP tool
       ↓
Calls: searchHotels(city="Paris", check_in="2025-12-20", check_out="2025-12-22")
       ↓
Returns:
{
  "hotels": [
    {
      "id": "hotel-1",
      "name": "Hilton Paris",
      "rating": 4.5,
      "price_per_night": 180,
      "available_rooms": 5
    },
    {
      "id": "hotel-2",
      "name": "Airbnb Apartment - Marais",
      "rating": 4.8,
      "price_per_night": 120,
      "available_rooms": 2
    }
  ]
}
       ↓
Agent LLM synthesizes: "Here are 2 hotels matching your dates..."
```

---

#### Tool: searchFlights
**Purpose**: Search flights between two cities
```
Query: "Find flights from Lyon to Bristol"
       ↓
Agent LLM decides: Use Travel MCP tool
       ↓
Calls: searchFlights(origin="Lyon", destination="Bristol", date="2025-12-20")
       ↓
Returns:
{
  "flights": [
    {
      "flight_id": "af-123",
      "airline": "Air France",
      "departure": "08:30",
      "arrival": "10:15",
      "duration": "1h 45m",
      "price": 89,
      "seats_available": 12
    },
    {
      "flight_id": "rj-456",
      "airline": "Ryanair",
      "departure": "14:00",
      "arrival": "15:40",
      "duration": "1h 40m",
      "price": 45,
      "seats_available": 8
    }
  ]
}
```

---

#### Tool: getWeatherForecast
**Purpose**: Get weather forecast for destination
```
Query: "What's the weather like in Bristol?"
       ↓
Agent LLM decides: Use Travel MCP tool
       ↓
Calls: getWeatherForecast(city="Bristol", date="2025-12-20")
       ↓
Returns:
{
  "date": "2025-12-20",
  "high_temp": 12,
  "low_temp": 8,
  "conditions": "Rainy",
  "wind_speed": "15 mph",
  "packing_tips": ["Bring umbrella", "Wear waterproof jacket"]
}
```

---

#### Tool: getAttractionsAndTips
**Purpose**: Get tourist attractions and travel tips
```
Query: "What can I do in Bristol?"
       ↓
Agent LLM decides: Use Travel MCP tool
       ↓
Calls: getAttractionsAndTips(city="Bristol")
       ↓
Returns:
{
  "attractions": [
    {
      "name": "Clifton Suspension Bridge",
      "type": "landmark",
      "hours": "24/7",
      "admission": "Free"
    },
    {
      "name": "SS Great Britain Museum",
      "type": "museum",
      "hours": "10am-5pm",
      "admission": "£18"
    }
  ],
  "travel_tips": [
    "Use Oyster card for public transport",
    "Best food scene: Stokes Croft area",
    "Avoid rush hour 7-9am and 5-7pm"
  ]
}
```

---

## How MCP Tool Discovery Works

### At Agent Startup

```
Agent initialization:
┌─────────────────────────────────────────┐
│ 1. Read MCP registry config             │
│    File: ~/.openig/mcp-servers.json     │
│                                         │
│ 2. Discover available tools:            │
│    - Expense MCP Server (port 5001)    │
│    - Finance MCP Server (port 5002)    │
│    - Travel MCP Server (port 5003)     │
│                                         │
│ 3. Fetch tool schemas for each server: │
│    {                                   │
│      "name": "searchHotels",           │
│      "description": "...",             │
│      "parameters": {                   │
│        "type": "object",               │
│        "properties": {                 │
│          "city": {"type": "string"},   │
│          "check_in": {"type": "string"}│
│        }                               │
│      }                                 │
│    }                                   │
│                                         │
│ 4. Store schemas in memory             │
└─────────────────────────────────────────┘
```

### At Runtime (User Sends Query)

```
Query: "Show me hotels in Paris"
        ↓
Agent calls LLM with:
  - User query: "Show me hotels in Paris"
  - Available tools: [searchHotels, searchFlights, ...]
  - Tool schemas: [Full JSON schema for each tool]
        ↓
LLM decides: "I should call searchHotels with city='Paris'"
        ↓
Agent calls MCP Server:
  POST /call/searchHotels
  Authorization: Bearer <scoped_token>
  {
    "city": "Paris",
    "check_in": "2025-12-20",
    "check_out": "2025-12-22"
  }
        ↓
MCP Server validates scoped token (aud=trip-planner-agent)
        ↓
MCP Server executes tool logic:
  - Query hotel database
  - Filter by availability
  - Return results
        ↓
Agent receives tool result
        ↓
Agent calls LLM again:
  - User query: "Show me hotels in Paris"
  - Tool result: [hotel 1, hotel 2, ...]
  - LLM task: "Summarize this for the user"
        ↓
LLM generates: "Here are 2 hotels matching your dates..."
        ↓
Agent streams response to browser
```

---

## Tool Authorization & Data Access

### Who Can Call Which Tools?

| Tool | Workforce Agent | Trip Planner | Authorization |
|------|-----------------|-------------|----------------|
| getExpenses | ✓ | ✗ | Finance team only |
| submitExpenseReport | ✓ | ✗ | Finance team only |
| getBudgetRemaining | ✓ | ✗ | All users (own budget) |
| searchHotels | ✗ | ✓ | All users |
| searchFlights | ✗ | ✓ | All users |
| getWeatherForecast | ✗ | ✓ | All users |

**Enforcement Level 1** (Agent-level): Workforce Agent only has Finance tools registered

**Enforcement Level 2** (MCP-level): Even if agent tried to call searchFlights, MCP would check token audience (aud=workforce-ai-agent) and reject

**Enforcement Level 3** (Data-level): If authorized, MCP checks user can access returned data

---

### Example: Data-Level Access Control

```
Query: "Show me expenses for alice and bob"
        ↓
Agent calls: getExpensesByUserAndQuarter(
  user_id=["alice", "bob"],
  quarter="Q3"
)
        ↓
MCP Server receives request with token.sub="alice"
        ↓
MCP Server checks:
  Can alice (token.sub) access bob's expenses?
        ↓
Policy evaluation:
  if (token.sub == bob) {
    return bob's full expenses  // Bob can see his own
  } else if (user.role == "finance_admin") {
    return both alice and bob   // Admin can see all
  } else {
    return alice's only         // Regular user sees own only
  }
        ↓
MCP returns: Alice's expenses only
        ↓
Prevents horizontal privilege escalation
```

---

## Adding New MCP Tools

To add a new tool (e.g., Travel Booking):

### Step 1: Create MCP Tool Server

```python
# travel-booking-mcp/main.py
@app.post("/call/bookHotel")
async def book_hotel(request):
    # Validate scoped token
    token = extract_bearer_token(request)
    if token['aud'] != 'trip-planner-agent':
        raise UnauthorizedError()
    
    # Validate user can book
    if not can_book_hotel(token['sub']):
        raise ForbiddenError()
    
    # Execute booking
    booking = hotel_api.book(
        user_id=token['sub'],
        hotel_id=request.hotel_id,
        check_in=request.check_in
    )
    
    return booking
```

### Step 2: Register in MCP Config

```json
# ~/.openig/mcp-servers.json
{
  "mcpServers": {
    "travel-booking": {
      "url": "http://host.k3d.internal:5004",
      "description": "Hotel and flight booking",
      "tools": [
        "bookHotel",
        "cancelBooking"
      ]
    }
  }
}
```

### Step 3: Agent Auto-Discovers on Startup

Agent fetches from http://host.k3d.internal:5004/tools → Gets bookHotel schema → LLM can now call it

---

## Tool Invocation Audit Trail

Every tool call is logged with:
- User ID (token.sub)
- Tool name
- Timestamp
- Result (success/failure)
- Data accessed (expenses retrieved, flights searched, etc.)

**Example log**:
```
2025-11-20T14:35:22Z alice@company.com called getExpensesByUserAndQuarter(Q3) → 3 expenses, $8,800
2025-11-20T14:35:45Z alice@company.com called searchFlights(Lyon→Bristol) → 5 flights returned
2025-11-20T14:36:10Z bob@company.com (contractor) denied: searchHotels not authorized for contractor
```

**Compliance**: Full audit trail for regulatory requirements (SOX, HIPAA, etc.)

---

## MCP Best Practices (For Your Integration)

1. **Always validate scoped token** in MCP tool before executing
2. **Check audience** (`aud` must match MCP server identity)
3. **Extract user context** from token.sub (for data-level access control)
4. **Log every call** with user ID + tool + result
5. **Fail secure**: If token invalid, deny by default (not allow)
6. **Rate limit** per user (prevent LLM from spamming one tool)
7. **Return only authorized data** (filter sensitive fields based on user role)

---

## Performance Considerations

| Operation | Latency | Notes |
|-----------|---------|-------|
| Token validation | ~1ms | Cached JWKS |
| MCP tool call | ~50-500ms | Depends on backend service |
| LLM decision | ~500ms-2s | Depends on model + query complexity |
| Data access check | ~5-10ms | Local policy evaluation |

**Total end-to-end**: ~2-5 seconds (user perceives as instant streaming)

---

## Q&A: MCP & Tools

**Q: Can an agent call multiple tools in sequence?**

A: Yes. LLM can decide to call Tool A first, then use result to call Tool B. Example: Search flights → Check prices → Book cheapest option.

---

**Q: What if a tool fails or times out?**

A: Agent catches the error and can retry or inform user. Example: "Hotel search timed out; try again later."

---

**Q: Can we use existing APIs as tools (not just custom MCP)?**

A: Yes. MCP is an adapter. You can wrap existing REST APIs as MCP tools.

---

**Q: How do we handle tool responses that are too large?**

A: Stream them. MCP supports streaming. Agent gets data chunk-by-chunk.

---

**Q: What if user is not authorized for a tool?**

A: Two options:
1. PingGateway blocks call before it reaches MCP
2. MCP validates scoped token and rejects

Both are secure; use both for defense in depth.

---

## Demo Script for Tools

**When showing tool execution:**

1. Open DevTools Network tab
2. Send query: "Show me my Q3 expenses"
3. Point to MCP call in Network tab:
   ```
   POST /call/getExpensesByUserAndQuarter
   Authorization: Bearer eyJhbGc... (scoped token)
   ```
4. Show scoped token in Authorization header
5. Show MCP response: `{ "expenses": [...] }`
6. Point out: "This is a real tool call, not LLM hallucination"
7. Explain: "LLM didn't make this up; it read the tool schema and decided to call it"
