"""LLM router for the Trip Planner Agent.

Uses a local Ollama model (OpenAI-compatible /v1/chat/completions) to:
  1. decide_agents       — pick which A2A sub-agents to call (keyword fallback)
  2. synthesize_packing  — write a short packing-advice paragraph from the
                           weather text; returned as-is for the trip-summary card
  3. synthesize          — fallback prose synthesis used only when the trip
                           card cannot be rendered (no structured results)

Routing is **card-driven**: decide_agents takes the request's candidate agents
(discovered from their AgentCards by src.discovery) and chooses among them by
their advertised identity + skills. There is no hardcoded agent vocabulary —
both the LLM prompt and the keyword fallback are built from the candidates'
cards, so adding/removing an agent is purely a registry concern.

No Anthropic / external API dependency — Ollama runs locally at OLLAMA_URL.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import TYPE_CHECKING

import httpx
from opentelemetry import trace
from opentelemetry.trace import SpanKind

if TYPE_CHECKING:
    from src.discovery import ResolvedAgent

logger = logging.getLogger("acp-trip-planner-agent.llm_router")
tracer = trace.get_tracer("acp-trip-planner-agent.llm_router")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://host.k3d.internal:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "auto")

_resolved_model: str | None = None


async def _ollama_chat(client: httpx.AsyncClient, model: str, payload: dict) -> dict:
    """POST a non-streaming chat completion, emitting a gen_ai.chat span.

    The Trip Planner's Ollama calls are non-streaming, so token usage is in the
    response body's `usage` block directly (no stream_options needed). Stamps the
    span with gen_ai.* model + usage attributes and returns the parsed JSON. The
    caller still owns raise_for_status / parsing of choices.
    """
    with tracer.start_as_current_span("gen_ai.chat", kind=SpanKind.CLIENT) as span:
        span.set_attribute("gen_ai.operation.name", "chat")
        span.set_attribute("gen_ai.request.model", model)
        resp = await client.post(f"{OLLAMA_URL}/v1/chat/completions", json=payload)
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data.get("model"), str):
            span.set_attribute("gen_ai.response.model", data["model"])
        usage = data.get("usage") or {}
        if isinstance(usage.get("prompt_tokens"), int):
            span.set_attribute("gen_ai.usage.input_tokens", usage["prompt_tokens"])
        if isinstance(usage.get("completion_tokens"), int):
            span.set_attribute("gen_ai.usage.output_tokens", usage["completion_tokens"])
        return data


async def _get_model() -> str | None:
    """Resolve OLLAMA_MODEL=auto to the first available model. Returns None on failure."""
    global _resolved_model
    if _resolved_model:
        return _resolved_model
    if OLLAMA_MODEL != "auto":
        _resolved_model = OLLAMA_MODEL
        return _resolved_model
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{OLLAMA_URL}/api/tags")
            resp.raise_for_status()
            models = resp.json().get("models", [])
            if models:
                _resolved_model = models[0]["name"]
                logger.info("Resolved Ollama model: %s", _resolved_model)
                return _resolved_model
    except Exception as exc:
        logger.warning("Ollama unreachable (%s) — keyword fallback will be used", exc)
    return None


# ---------------------------------------------------------------------------
# Runtime routing mode — togglable at runtime via the `/mode` chat command
# (intercepted server-side in router._handle_run; see handle_mode_command).
# ---------------------------------------------------------------------------

_routing_mode: str = "keyword"


def get_mode() -> str:
    return _routing_mode


def set_mode(mode: str) -> None:
    global _routing_mode
    if mode not in ("llm", "keyword"):
        raise ValueError(f"Unknown routing mode: {mode!r}. Must be 'llm' or 'keyword'.")
    _routing_mode = mode
    logger.info("Routing mode set to %r", _routing_mode)


def handle_mode_command(message: str) -> str | None:
    """Handle a `/mode` chat command. Mirrors the Workforce AI Agent's
    `handleModeCommand` (acp-workforce-ai-agent/src/routerState.js).

    Returns a user-facing response string when `message` is a `/mode` command
    (mutating the process-global routing mode on a valid switch), or None when
    the message is not a `/mode` command and should flow on to normal routing.
    """
    if not message.startswith("/mode"):
        return None

    parts = message.strip().split()
    cmd = parts[1] if len(parts) > 1 else ""

    if cmd == "llm":
        set_mode("llm")
        return "Switched to LLM routing mode."
    if cmd == "keyword":
        set_mode("keyword")
        return "Switched to keyword routing mode."
    if cmd == "status":
        return f"Current routing mode: {get_mode()}"
    return "Usage: /mode llm | /mode keyword | /mode status"


# ---------------------------------------------------------------------------
# Agent selection via Ollama JSON output
# (avoids multi-tool-call which small models handle unreliably)
# ---------------------------------------------------------------------------

_ROUTER_SYSTEM_TEMPLATE = (
    "You are a trip planning assistant. Given a travel request, decide which "
    "agents to consult from the catalog below. Each agent is identified by a "
    "domain token and describes the skills it offers.\n\n"
    "{catalog}\n"
    "Rules:\n"
    "- OUT OF SCOPE: if the request is NOT about travel — i.e. none of the "
    "agents above could meaningfully help (e.g. expenses, approvals, IT "
    "support, general chit-chat) — reply with an EMPTY array []. Do not pick "
    "agents just to have an answer.\n"
    "- DEFAULT: when the request mentions a destination or general travel "
    "(e.g. 'trip to X', 'plan my trip', 'help me plan', 'from X to Y', "
    "'travel to', 'visit'), include ALL agents whose skills could contribute.\n"
    "- When the request clearly targets a single domain, include only that "
    "agent (e.g. a weather-only question → only the weather domain).\n"
    "- When in doubt between travel agents, include more rather than fewer — "
    "but an off-topic request is still [].\n"
    "Reply with ONLY a JSON array of domain tokens, no explanation. "
    'Example: {example}'
)


def _build_catalog(candidates: list[ResolvedAgent]) -> str:
    """Render the candidate agents' identity + skills for the router prompt."""
    lines: list[str] = []
    for agent in candidates:
        skill_descs = []
        for skill in agent.skills:
            name = skill.get("name") or skill.get("id") or ""
            desc = skill.get("description") or ""
            tags = ", ".join(skill.get("tags") or [])
            piece = name
            if desc:
                piece = f"{piece} — {desc}" if piece else desc
            if tags:
                piece = f"{piece} (tags: {tags})"
            if piece:
                skill_descs.append(piece.strip())
        skills_blurb = "; ".join(skill_descs) or "(no skills advertised)"
        lines.append(f'- "{agent.domain}": {skills_blurb}')
    return "Available agents:\n" + "\n".join(lines) + "\n"


def _mark_fallback(reason: str) -> None:
    """Record on the active agent.reasoning span that LLM mode silently
    degraded to keyword routing. The span owns reasoning.mode/candidates/chosen
    (set by router._fan_out); this adds the two facts only decide_agents knows.
    Safe to call when no span is recording (get_current_span() returns a no-op).
    """
    span = trace.get_current_span()
    span.set_attribute("reasoning.fallback", True)
    span.set_attribute("reasoning.fallback_reason", reason)


async def decide_agents(
    user_text: str, candidates: list[ResolvedAgent]
) -> list[dict]:
    """Return [{"agent": <domain>, "query": str}, ...] chosen from `candidates`.

    `candidates` is the request's discovered agent set (src.discovery.
    get_candidates()). Both the LLM path and the keyword fallback choose only
    from these — an agent absent from the registry (or card-less, hence
    excluded) is never selected. Returns [] when there are no candidates.

    Enriches the active `agent.reasoning` span (opened by router._fan_out) with
    reasoning.model and, when LLM mode silently degrades, reasoning.fallback.
    """
    if not candidates:
        logger.warning("decide_agents called with no candidates — nothing routable")
        return []

    valid_domains = {a.domain for a in candidates}

    if _routing_mode == "keyword":
        # Intentional keyword mode — NOT a fallback (the span's reasoning.mode
        # is already 'keyword'); no fallback attribute is set.
        logger.info("Routing mode 'keyword' — skipping Ollama")
        return _keyword_fallback(user_text, candidates)

    model = await _get_model()
    if not model:
        _mark_fallback("ollama_unreachable")
        return _keyword_fallback(user_text, candidates)

    trace.get_current_span().set_attribute("reasoning.model", model)

    example = json.dumps(sorted(valid_domains))
    system_prompt = _ROUTER_SYSTEM_TEMPLATE.format(
        catalog=_build_catalog(candidates), example=example
    )

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            data = await _ollama_chat(client, model, {
                "model": model,
                "temperature": 0,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_text},
                ],
            })
            raw = data["choices"][0]["message"]["content"].strip()
    except Exception as exc:
        logger.warning("Ollama routing failed (%s) — keyword fallback", exc)
        _mark_fallback("ollama_error")
        return _keyword_fallback(user_text, candidates)

    # Strip markdown fences some models add
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, list):
            raise ValueError("expected a list")
    except Exception:
        logger.warning("Ollama returned unparseable routing response %r — keyword fallback", raw[:200])
        _mark_fallback("unparseable_response")
        return _keyword_fallback(user_text, candidates)

    # A well-formed empty list is the model's deliberate "out of scope" verdict
    # (per the OUT OF SCOPE prompt rule) — honour it and route to nobody. This
    # is the LLM owning the scope decision; it is NOT a degrade, so no fallback.
    if not parsed:
        logger.info("Ollama judged request out of scope — no delegation")
        return []

    agents = [a for a in parsed if a in valid_domains]
    if not agents:
        # The model named only domains that don't exist (hallucination) — it
        # tried to route but produced nothing usable. That IS a degrade.
        logger.warning("Ollama returned only unknown domains %r — keyword fallback", parsed[:10])
        _mark_fallback("empty_result")
        return _keyword_fallback(user_text, candidates)

    delegations = [{"agent": a, "query": user_text} for a in agents]
    logger.info("Ollama router decided: %s", agents)
    return delegations


# ---------------------------------------------------------------------------
# Slot extraction — pull trip details out of free text before fan-out
# ---------------------------------------------------------------------------
#
# The router decides WHICH agents to call (decide_agents); slot extraction
# decides whether we know ENOUGH to call them. A vague "help me plan my trip"
# names no destination, so delegating verbatim makes the sub-agents guess (the
# weather agent geolocates to its egress IP). The planner instead extracts the
# trip slots and, when a required one is missing, raises an AG-UI interrupt to
# ask (the gather gate lives in router._gate_and_dispatch). `_SLOT_KEYS` is the
# generic, domain-agnostic shape of a trip request and the round-trip contract
# with the portal's `pendingTrip` state; the per-domain "which are required"
# rule lives in the router, not here.
#
# Extraction only ever fills destination/origin (`_TEXT_SLOT_KEYS`): the LLM
# can't reliably produce ISO dates and doesn't know "today", so departDate /
# returnDate are NEVER extracted from text — they come only from the form
# date-picker (browser-guaranteed YYYY-MM-DD) on the resume turn.

_SLOT_SYSTEM = (
    "You extract structured trip details from a travel request. Return ONLY a "
    "JSON object with exactly these keys: \"destination\" (the place the user is "
    "travelling TO) and \"origin\" (the place they start FROM). Use null for any "
    "value the user did not state — do NOT guess or invent a value. Do NOT "
    "include dates. Reply with the JSON object only, no explanation.\n"
    'Example: {"destination": "Paris", "origin": "San Francisco"}'
)

# Full slot shape == portal `pendingTrip.slots` shape == form/payload shape, so
# the resume merge is a plain loop. Dates are part of the shape but never
# text-extracted (see _TEXT_SLOT_KEYS).
_SLOT_KEYS = ("destination", "origin", "departDate", "returnDate")

# The only slots extract_slots / _keyword_slots ever fill from free text.
_TEXT_SLOT_KEYS = ("destination", "origin")


async def extract_slots(user_text: str) -> dict[str, str | None]:
    """Extract trip slots from `user_text` — destination/origin only.

    LLM path (Ollama JSON output) with a deterministic regex fallback, mirroring
    decide_agents: any value the user did not state comes back as None — the
    extractor never guesses. Always returns all `_SLOT_KEYS`; the date slots are
    always None here (they come from the form date-picker, not text).
    """
    empty: dict[str, str | None] = {k: None for k in _SLOT_KEYS}
    if not user_text.strip():
        return empty

    if _routing_mode == "keyword":
        return _keyword_slots(user_text)

    model = await _get_model()
    if not model:
        return _keyword_slots(user_text)

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            data = await _ollama_chat(client, model, {
                "model": model,
                "temperature": 0,
                "messages": [
                    {"role": "system", "content": _SLOT_SYSTEM},
                    {"role": "user", "content": user_text},
                ],
            })
            raw = data["choices"][0]["message"]["content"].strip()
    except Exception as exc:
        logger.warning("Ollama slot extraction failed (%s) — keyword fallback", exc)
        return _keyword_slots(user_text)

    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("expected an object")
    except Exception:
        logger.warning("Ollama returned unparseable slots %r — keyword fallback", raw[:200])
        return _keyword_slots(user_text)

    out = dict(empty)
    for key in _TEXT_SLOT_KEYS:
        val = parsed.get(key)
        if isinstance(val, str) and val.strip():
            out[key] = val.strip()
    return out


# "to Paris" / "from SFO to Paris" / "trip to Tokyo" — a deliberately small
# deterministic parser used when Ollama is unreachable or mode=keyword. It only
# fills destination/origin (never dates); everything else stays None so the
# router's required-slot gate still fires (asking is cheaper than a wrong guess).
_TO_RE = re.compile(r"\b(?:to|for|visit(?:ing)?|in)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)")
_FROM_RE = re.compile(r"\bfrom\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)")


def _keyword_slots(user_text: str) -> dict[str, str | None]:
    out: dict[str, str | None] = {k: None for k in _SLOT_KEYS}
    m_from = _FROM_RE.search(user_text)
    if m_from:
        out["origin"] = m_from.group(1).strip()
    # Destination: prefer an explicit "to X" that isn't the "from X" capture.
    for m in _TO_RE.finditer(user_text):
        cand = m.group(1).strip()
        if cand and cand != out["origin"]:
            out["destination"] = cand
            break
    return out


# ---------------------------------------------------------------------------
# Synthesis via Ollama
# ---------------------------------------------------------------------------

_SYNTHESIS_SYSTEM = (
    "You are a helpful business travel assistant. Given sub-agent results, write a "
    "concise trip summary. Use bullet points where appropriate. "
    "Structure your response in this exact order: "
    "1. Flights (if available). "
    "2. Hotels (if available). "
    "3. Weather forecast (if available), immediately followed by "
    "4. Packing tips — 2-3 professional, business-appropriate recommendations "
    "derived directly from the weather forecast. "
    "Keep the tone neutral and practical — this is a business trip. "
    "Focus on items that affect comfort and professionalism: "
    "e.g. 'Consider a light overcoat for cold evenings', "
    "'Bring a compact umbrella for expected rain', "
    "'Light breathable clothing is advisable given the heat'. "
    "Avoid casual or leisure framing (no 'sunscreen', 'hiking boots', etc.)."
)

_PACKING_SYSTEM = (
    "You are a business-travel assistant. Given a weather summary for a destination, "
    "write a single short paragraph (1-2 sentences, under 40 words) of "
    "professional, business-appropriate packing advice derived directly from the "
    "forecast. Keep the tone neutral and practical. "
    "Avoid casual/leisure framing (no sunscreen, hiking boots, swimwear, etc.). "
    "Reply with the paragraph only — no markdown, no bullets, no preamble."
)


async def synthesize_packing(weather_text: str) -> str:
    """Return a short paragraph of packing advice derived from the weather summary.

    Falls back to a deterministic rule-based sentence when Ollama is
    unreachable or returns no content.
    """
    if not weather_text:
        return ""

    model = await _get_model()
    if not model:
        return " ".join(_gear_tips_from_weather(weather_text.lower()))

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            data = await _ollama_chat(client, model, {
                "model": model,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content": _PACKING_SYSTEM},
                    {"role": "user", "content": f"Weather summary:\n{weather_text}"},
                ],
            })
            raw = data["choices"][0]["message"]["content"].strip()
    except Exception as exc:
        logger.warning("Ollama packing synthesis failed (%s) — keyword fallback", exc)
        return " ".join(_gear_tips_from_weather(weather_text.lower()))

    if raw:
        return raw
    return " ".join(_gear_tips_from_weather(weather_text.lower()))


async def synthesize(
    user_text: str,
    results: dict[str, str],
    errors: dict[str, str],
) -> str:
    if not results and not errors:
        return "(No results from agents.)"

    model = await _get_model()
    if not model:
        return _simple_synthesis(results, errors)

    context_parts = []
    for agent, text in results.items():
        context_parts.append(f"=== {agent.title()} Agent Results ===\n{text}")
    for agent, err in errors.items():
        context_parts.append(f"=== {agent.title()} Agent (unavailable) ===\n{err}")
    context = "\n\n".join(context_parts)

    prompt = (
        f'The user asked: "{user_text}"\n\n'
        f"Here are the results from the specialized agents:\n\n{context}"
    )

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            data = await _ollama_chat(client, model, {
                "model": model,
                "temperature": 0.3,
                "messages": [
                    {"role": "system", "content": _SYNTHESIS_SYSTEM},
                    {"role": "user", "content": prompt},
                ],
            })
            text = data["choices"][0]["message"]["content"].strip()
            if text:
                return text
    except Exception as exc:
        logger.warning("Ollama synthesis failed (%s) — simple synthesis", exc)

    return _simple_synthesis(results, errors)


# ---------------------------------------------------------------------------
# Keyword fallback (no Ollama or mode=keyword)
# ---------------------------------------------------------------------------


# Generic travel-intent vocabulary — the "is this even a travel request?"
# anchor that card tags alone can't express. Card tags (e.g. weather/flights/
# hotels/travel/booking) are domain-specific; these cover the request-shaping
# words a traveller uses without naming a domain ("plan my trip to Tokyo",
# "I'm flying from X to Y next week"). Stemmed at match time, so "trips"/"trip"
# and "flights"/"flight" both hit. Kept deliberately small and travel-only.
_TRAVEL_INTENT_WORDS = frozenset({
    "trip", "travel", "vacation", "holiday", "itinerary", "destination",
    "visit", "visiting", "fly", "flying", "flight", "plane", "airport",
    "hotel", "stay", "accommodation", "lodging", "weather", "forecast",
    "pack", "packing", "abroad", "overseas", "journey", "tour",
})


def _has_travel_intent(user_text: str, candidates: list[ResolvedAgent]) -> bool:
    """Return True when the request carries any travel signal at all.

    Two sources, OR'd: (1) the candidate cards' own skill tags (so the gate
    stays card-driven — a new agent's domain words count automatically), and
    (2) a small generic travel vocabulary for the request-shaping words a user
    uses without naming a domain. Matching is whole-word and stemmed (mirrors
    _keyword_fallback), so "trips"→"trip" and "hotel"→"hotels"-tag both hit.

    A request with zero signals (e.g. "show my draft expenses") is out of scope
    for a trip planner and routes to nobody. This is the one place "I can't help
    with that" is decided — both routing modes funnel through it.
    """
    words = {_stem(w) for w in re.findall(r"[a-z]+", user_text.lower())}
    if any(_stem(w) in words for w in _TRAVEL_INTENT_WORDS):
        return True
    # Any candidate card tag present as a whole word → travel intent.
    for agent in candidates:
        if any(_stem(tag) in words for tag in agent.tags):
            return True
    return False


def _stem(word: str) -> str:
    """Crude singular/plural fold: drop a trailing 's' on words over 3 chars.

    Lets a user's "hotel"/"flight" match the plural card tags "hotels"/"flights"
    without a real stemmer or a hardcoded synonym list. The length guard keeps
    short stop-words ("as", "is") from collapsing into noise.
    """
    return word[:-1] if len(word) > 3 and word.endswith("s") else word


def _keyword_fallback(
    user_text: str, candidates: list[ResolvedAgent]
) -> list[dict]:
    """Match user words against each candidate card's skills[].tags.

    A candidate is selected when any of its skill tags matches a whole word in
    the request, comparing on a stemmed (singular/plural-folded) basis so
    "hotel" hits the "hotels" tag. With no tag hits we default to consulting
    every candidate — the user mentioned travel but no specific domain, so cast
    wide. Card tags are the only vocabulary; there is no hardcoded domain list.
    """
    if not candidates:
        return []

    words = {_stem(w) for w in re.findall(r"[a-z]+", user_text.lower())}
    delegations: list[dict] = []
    for agent in candidates:
        if any(_stem(tag) in words for tag in agent.tags):
            delegations.append({"agent": agent.domain, "query": user_text})

    if not delegations:
        # No domain tag matched. Two sub-cases — distinguished by the generic
        # travel-intent anchor (the keyword path's substitute for the LLM's
        # scope judgement, since this path has no model to ask):
        #   • generic travel ("plan my trip to Tokyo") → cast wide to all
        #   • off-topic ("show my draft expenses")      → route to nobody ([])
        if _has_travel_intent(user_text, candidates):
            delegations = [
                {"agent": agent.domain, "query": user_text} for agent in candidates
            ]
    return delegations


def _simple_synthesis(results: dict[str, str], errors: dict[str, str]) -> str:
    ok = list(results.keys())
    fail = list(errors.keys())
    if not ok and fail:
        return "I couldn't reach any of the travel agents. Please try again."
    parts = []
    if ok:
        parts.append("Results gathered from: " + ", ".join(f"**{a}**" for a in ok) + ".")
    if fail:
        parts.append("Unavailable: " + ", ".join(f"**{a}**" for a in fail) + ".")
    parts.append("See the cards above for the full details.")

    weather_text = results.get("weather", "").lower()
    if weather_text:
        tips = _gear_tips_from_weather(weather_text)
        if tips:
            parts.append("\n\n**Packing tips:** " + " ".join(tips))

    return " ".join(parts)


def _gear_tips_from_weather(weather_lower: str) -> list[str]:
    tips = []
    if any(w in weather_lower for w in ("snow", "sleet", "blizzard", "freezing")):
        tips.append("A warm overcoat and waterproof footwear are advisable given freezing/snow conditions.")
    elif any(w in weather_lower for w in ("cold", "chilly", "frost")) or any(
        str(t) in weather_lower for t in range(-10, 12)
    ):
        tips.append("Consider a warm overcoat — temperatures are cold.")
    elif any(w in weather_lower for w in ("cool", "mild")):
        tips.append("A light jacket or additional layer is recommended for the cooler temperatures.")
    if any(w in weather_lower for w in ("rain", "shower", "drizzle", "thunder", "storm")):
        tips.append("A compact umbrella or water-resistant jacket is recommended given expected precipitation.")
    if any(w in weather_lower for w in ("hot", "heat", "sunny", "sun", "clear")):
        tips.append("Light, breathable business attire is advisable — temperatures are warm.")
    return tips


async def generate_travel_response(user_text: str) -> str:
    """Fallback: generate travel planning response directly via LLM.
    
    Used when the A2A registry is empty (no sub-agents discovered). Generates
    a travel response using the LLM instead of delegating to sub-agents. This
    allows the Trip Planner to work even without the full A2A infrastructure.
    """
    model = await _get_model()
    if not model:
        return (
            "I can help plan your trip! To get started, please tell me:\n"
            "• Where are you flying from?\n"
            "• Where would you like to go?\n"
            "• What dates do you need to travel?"
        )
    
    prompt = (
        "You are a helpful travel planning assistant. Based on the user's request, "
        "provide travel suggestions including:\n"
        "1. Recommended destinations or flights\n"
        "2. Suggested hotels or accommodations\n"
        "3. Travel tips and recommendations\n"
        "4. Weather and best time to visit (if relevant)\n\n"
        "Keep your response concise and helpful."
    )
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            data = await _ollama_chat(client, model, {
                "model": model,
                "temperature": 0.7,
                "messages": [
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": user_text},
                ],
            })
            response = data["choices"][0]["message"]["content"].strip()
            return response
    except Exception as exc:
        logger.warning("Fallback travel response generation failed: %s", exc)
        return (
            "I'd be happy to help plan your trip! Here are some questions to get started:\n"
            "• Where would you like to travel to?\n"
            "• When are you planning to go?\n"
            "• What's your budget range?\n"
            "• Are you looking for hotels, flights, or both?"
        )
