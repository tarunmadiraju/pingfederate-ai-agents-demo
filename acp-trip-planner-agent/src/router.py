"""ACP Trip Planner Agent — AG-UI run router.

`server.py` instantiates `TripPlannerRouter()` per inbound run and consumes
the async iterator returned by `run(input_data)`. The router yields AG-UI
events; the server frames them as SSE.

Contract:
  - First event MUST be RunStartedEvent
  - Last event MUST be RunFinishedEvent or RunErrorEvent
  - Events between are agent-specific (TextMessage*, ToolCall*, Custom, ...)

Routing:
  - "slow weather" → SubscribeToTask demo against the Weather Agent
    (immediate-return SendMessage + lifecycle subscription)
  - everything else → LLM-driven fan-out across the agents discovered from
    their AgentCards (weather / flights / hotels today).
    The LLM router (Ollama) decides which agents to consult; A2A
    SendStreamingMessage runs concurrently against each; frames are forwarded
    as AG-UI CUSTOM events; once all delegations finish the LLM synthesises
    a final itinerary which is emitted as a TextMessage* sequence.
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from typing import Any, AsyncIterator

from ag_ui.core import (
    BaseEvent,
    EventType,
    Interrupt,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunFinishedInterruptOutcome,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)
from opentelemetry import baggage, context as otel_context, trace
from pydantic import BaseModel

from src import discovery, llm_router
from src.a2a_client import (
    A2AClient,
    A2AClientError,
    _TERMINAL_STATES as _A2A_TERMINAL_STATES,
    _extract_data,
    _extract_text,
    protocol_version_from_card,
)
from src.tx_propagation import get_tx_token, make_outbound_client

logger = logging.getLogger("acp-trip-planner-agent")
tracer = trace.get_tracer("acp-trip-planner-agent.router")

# Stable agent identity, stamped on the agent.reasoning span as
# gen_ai.agent.id / gen_ai.agent.name and used (set-once) as the
# origin_agent.id baggage value. Human-meaningful slug, not a UUID.
_AGENT_ID = "acp-trip-planner-agent"
_AGENT_NAME = "Trip Planner Agent"

_TERMINAL_STATES = _A2A_TERMINAL_STATES

# Packing tips are a synthesis add-on whose advice is intrinsically a function
# of the weather forecast — they are NOT part of the (now generic) result
# bucketing. This single token names the domain whose summary feeds
# llm_router.synthesize_packing(); it is the one weather-specific coupling left
# in the router, isolated here so the bucketing stays agent-agnostic.
_PACKING_SOURCE_DOMAIN = "weather"


# =============================================================================
# CustomEvent — defined locally for SDK version independence
# =============================================================================


class CustomEvent(BaseModel):
    """AG-UI CUSTOM event wire shape: {"type":"CUSTOM","name":...,"value":...}.

    Defined locally so it works regardless of whether the installed
    ag-ui-protocol SDK version exports a CustomEvent. The EventEncoder
    serialises Pydantic models via model_dump, producing the correct wire.
    """

    type: str = "CUSTOM"
    name: str
    value: Any


class StateSnapshotEvent(BaseModel):
    """AG-UI STATE_SNAPSHOT event wire shape.

    Defined locally — ag-ui-protocol 0.1.x does not export StateSnapshotEvent.
    Must be emitted after RUN_STARTED and before any STEP/TOOL/TEXT/CUSTOM
    events so the portal's state machine can seed result history.
    """

    type: str = "STATE_SNAPSHOT"
    snapshot: Any


class StateDeltaEvent(BaseModel):
    """AG-UI STATE_DELTA event wire shape (RFC 6902 JSON Patch).

    Defined locally. Each `delta` entry is a JSON Patch operation.
    The portal's _renderStateResults() processes `results[]` entries
    whose `view` field drives renderStructuredContent() dispatch.
    """

    type: str = "STATE_DELTA"
    delta: list[Any]


# =============================================================================
# Helpers
# =============================================================================


def _latest_user_text(input_data: RunAgentInput) -> str:
    for msg in reversed(input_data.messages):
        if msg.role == "user" and isinstance(msg.content, str):
            return msg.content
    return ""


def _text_events(message_id: str, text: str) -> list[BaseEvent]:
    return [
        TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            message_id=message_id,
            role="assistant",
        ),
        TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id=message_id,
            delta=text,
        ),
        TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END,
            message_id=message_id,
        ),
    ]


def _custom_event(name: str, value: Any) -> CustomEvent:
    return CustomEvent(name=name, value=value)


def _paz_decision_from_error(message: str) -> str:
    """Derive a PAZ decision label from an A2AClientError message.

    The sidecar preserves the original HTTP status code from PAZ in the
    error message as 'HTTP <code>'. Map to a human label:
      401/403 → DENY (PAZ evaluated policy and denied)
      503     → UNAVAILABLE (PAZ unreachable)
      anything else → ERROR
    """
    m = re.search(r'HTTP (\d{3})', message)
    if not m:
        return "ERROR"
    code = int(m.group(1))
    if code in (401, 403):
        return "DENY"
    if code == 503:
        return "UNAVAILABLE"
    return "ERROR"


# =============================================================================
# Slot-gather gate (S2) — clarify missing trip details before fanning out
# =============================================================================

# Slots required regardless of which agents are chosen. Dates are never
# extracted from free text (see llm_router._TEXT_SLOT_KEYS), so a fresh request
# always lacks them — every fresh trip gathers at least once, which is the whole
# point of the demo's clarification gate.
_ALWAYS_REQUIRED = ("destination", "departDate", "returnDate")

# Human labels for the elicitation form (responseSchema titles + the prompt).
_SLOT_LABELS = {
    "destination": "Destination city",
    "origin": "Departure city",
    "departDate": "Departure date",
    "returnDate": "Return date",
}


def _slot_present(slots: dict, key: str) -> bool:
    val = slots.get(key)
    return isinstance(val, str) and bool(val.strip())


def _chosen_requires_origin(chosen_domains: list[str], by_domain: dict) -> bool:
    """Origin is required only when a flights-tagged agent is in the chosen set.

    Card-driven: matches the reserved 'flights' domain tag (acp-platform/
    AGENTS.md routing contract), not a hardcoded agent name. With no flights
    agent chosen we never ask the user where they're flying from.
    """
    for domain in chosen_domains:
        agent = by_domain.get(domain)
        if agent and "flights" in agent.tags:
            return True
    return False


def _required_slots(chosen_domains: list[str], by_domain: dict) -> list[str]:
    required = list(_ALWAYS_REQUIRED)
    if _chosen_requires_origin(chosen_domains, by_domain):
        required.append("origin")
    return required


def _missing_slots(slots: dict, required: list[str]) -> list[str]:
    return [k for k in required if not _slot_present(slots, k)]


def _gather_schema(missing: list[str]) -> dict:
    """JSON Schema for the gather form: properties == required == missing slots.

    Date slots carry format:"date" so the portal renders a native date-picker
    (browser-guaranteed YYYY-MM-DD); every property is required (the form has no
    optional fields — we only ask for what's actually missing).
    """
    props: dict[str, dict] = {}
    for key in missing:
        prop = {"type": "string", "title": _SLOT_LABELS.get(key, key)}
        if key in ("departDate", "returnDate"):
            prop["format"] = "date"
        props[key] = prop
    return {"type": "object", "properties": props, "required": list(missing)}


def _gather_message(missing: list[str]) -> str:
    labels = [_SLOT_LABELS.get(k, k).lower() for k in missing]
    if len(labels) == 1:
        need = labels[0]
    elif len(labels) == 2:
        need = f"{labels[0]} and {labels[1]}"
    else:
        need = ", ".join(labels[:-1]) + f", and {labels[-1]}"
    return f"Before I can plan this trip, I need a few details: {need}."


def _clear_pending_delta() -> "StateDeltaEvent":
    """STATE_DELTA that nulls pendingTrip once the gather is done/cancelled.

    Uses `replace` (not `remove`): the portal's _applyPatch only implements
    `replace` for object-member paths and `add` for `/-` array appends, so a
    null replace is the portable way to clear a sibling of results[].
    """
    return StateDeltaEvent(delta=[{"op": "replace", "path": "/pendingTrip", "value": None}])


# =============================================================================
# Router
# =============================================================================


class TripPlannerRouter:
    """Per-run orchestrator.

    A new instance is constructed for every inbound run so any state held
    on `self` is local to a single SSE stream.

    Delegation context (the `X-Tx-Token` minted by the inbound ext_proc
    sidecar) is propagated to outbound A2A calls entirely by the infrastructure
    layer: the per-run httpx client is built via `make_outbound_client()`, which
    stamps `X-Tx-Token` from a ContextVar set by `TxTokenMiddleware`. The router
    holds no auth state of its own.
    """

    async def run(self, input_data: RunAgentInput) -> AsyncIterator[BaseEvent]:
        # Per-run interrupt sink. The slot-gather gate (see _fan_out) sets this
        # when it pauses to ask the user for missing trip details; run() then
        # closes the stream with a RunFinishedInterruptOutcome instead of a plain
        # (success) RunFinishedEvent. Reset per instance (one router per run).
        self._interrupt: Interrupt | None = None

        yield RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )

        # AG-UI spec §5: STATE_SNAPSHOT must be emitted after RUN_STARTED and
        # before any STEP, TOOL, TEXT, or CUSTOM events. Seed from prior state
        # so the portal's result history carries over across turns.
        # Always include `results` and `error` keys so subsequent STATE_DELTA
        # patches targeting `/results/-` have an array to append to.
        seed_state: dict[str, Any] = {"results": [], "error": None}
        if input_data.state:
            seed_state.update(dict(input_data.state))
            seed_state.setdefault("results", [])
        yield StateSnapshotEvent(snapshot=seed_state)

        # Surface the inbound RFC 8693 delegation proof (X-Tx-Token minted by the
        # ext_proc sidecar at the trust boundary) so the portal renders it in the
        # OAuth Token Flow panel. Emitted after STATE_SNAPSHOT per AG-UI §5; the
        # token still propagates to outbound A2A calls independently.
        tx_token = get_tx_token()
        if tx_token:
            yield _custom_event("oauth.token_exchange", {"token": tx_token})

        try:
            async for event in self._handle_run(input_data):
                yield event
        except Exception as exc:  # noqa: BLE001 — surface as RUN_ERROR
            logger.exception("Run %s failed", input_data.run_id)
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=str(exc) or "Run failed",
            )
            return

        # A gather gate that paused this run set self._interrupt; close the
        # stream with an interrupt outcome so the portal renders the elicitation
        # form and resumes by addressing this interrupt.id. Otherwise finish
        # normally (outcome omitted == legacy success, per RunFinishedEvent).
        outcome = (
            RunFinishedInterruptOutcome(interrupts=[self._interrupt])
            if self._interrupt is not None
            else None
        )
        yield RunFinishedEvent(
            type=EventType.RUN_FINISHED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
            outcome=outcome,
        )

    async def _handle_run(
        self,
        input_data: RunAgentInput,
    ) -> AsyncIterator[BaseEvent]:
        user_text = _latest_user_text(input_data)
        logger.info("Run %s: user said %r", input_data.run_id, user_text)

        # Resume branch — a resume run carries both `resume[]` (the user's
        # answer to a prior interrupt) and an echoed `pendingTrip` in state
        # (the accumulated gather context). Both are required: a stray resume
        # with no pendingTrip, or a pendingTrip with no resume, falls through to
        # normal handling. This runs before /mode and slow-weather so a paused
        # gather always resumes cleanly.
        pending = (input_data.state or {}).get("pendingTrip")
        if input_data.resume and pending:
            async for event in self._resume_gather(input_data, pending):
                yield event
            return

        # `/mode` commands are intercepted here so they work regardless of which
        # routing path is active, and never fan out to the sub-agents. Mirrors
        # the Workforce AI Agent's server-side interception
        # (acp-workforce-ai-agent/src/agui/runHandler.js).
        mode_response = llm_router.handle_mode_command(user_text)
        if mode_response is not None:
            for event in _text_events(str(uuid.uuid4()), mode_response):
                yield event
            return

        # SubscribeToTask demo path — keeps the async task lifecycle exercise
        # available regardless of how the LLM router is configured.
        if "slow weather" in user_text.lower():
            async for event in self._delegate_weather_async(user_text):
                yield event
            return

        # Fresh trip turn: extract whatever slots the text states (destination/
        # origin only — dates come from the form), then run the gather gate.
        slots = await llm_router.extract_slots(user_text)
        async for event in self._gate_and_dispatch(
            user_text, slots, gather_round=0
        ):
            yield event

    # -------------------------------------------------------------------------
    # Slot-gather resume
    # -------------------------------------------------------------------------

    async def _resume_gather(
        self,
        input_data: RunAgentInput,
        pending: dict,
    ) -> AsyncIterator[BaseEvent]:
        """Resume a paused gather: correlate, merge the answer, re-dispatch.

        `pending` is the echoed `pendingTrip` state written by a prior run's
        interrupt. We correlate the resume entry by interruptId (spec-mandated
        linkage), and on a resolved answer merge its payload over the
        accumulated slots and re-run the gate (which may pause again for a
        second round, or dispatch the fan-out).
        """
        interrupt_id = pending.get("interruptId")
        slots = dict(pending.get("slots") or {})
        original_prompt = pending.get("originalPrompt") or ""
        gather_round = int(pending.get("round") or 0)

        # Correlate by interruptId — ignore resume entries for other interrupts.
        entry = next(
            (r for r in input_data.resume if r.interrupt_id == interrupt_id),
            None,
        )
        if entry is None:
            logger.warning(
                "Resume run with no entry matching pending interrupt %s — clearing",
                interrupt_id,
            )
            yield _clear_pending_delta()
            for event in _text_events(
                str(uuid.uuid4()),
                "Let me know when you'd like to plan a trip.",
            ):
                yield event
            return

        # Cancelled / dismissed → drop the gather with a calm message. Denials
        # live in status, not payload, per the AG-UI interrupt contract.
        if entry.status != "resolved":
            yield _clear_pending_delta()
            for event in _text_events(
                str(uuid.uuid4()),
                "No problem — let me know when you'd like to plan a trip.",
            ):
                yield event
            return

        # Merge the form answer over the accumulated slots. payload only carries
        # the keys the form rendered (the missing slots); flat shape == slot
        # shape, so the merge is a plain per-key loop. Empty values don't clobber.
        payload = entry.payload or {}
        for key in llm_router._SLOT_KEYS:
            val = payload.get(key)
            if isinstance(val, str) and val.strip():
                slots[key] = val.strip()

        async for event in self._gate_and_dispatch(
            original_prompt, slots, gather_round=gather_round + 1
        ):
            yield event

    # -------------------------------------------------------------------------
    # Slot-gather gate + dispatch
    # -------------------------------------------------------------------------

    async def _gate_and_dispatch(
        self,
        user_text: str,
        slots: dict,
        gather_round: int,
    ) -> AsyncIterator[BaseEvent]:
        """Shared entry for fresh + resume turns: run the gather gate, then
        fan out when the trip is fully specified.

        Thin wrapper over `_fan_out` carrying the gather context (`slots`,
        `gather_round`). Passing `slots` switches `_fan_out` into gated mode (a
        pre-gate before routing and a post-gate after the agent set is known);
        the direct-dispatch path (`slots=None`) is preserved for the assembly
        tests that drive `_fan_out` straight.
        """
        async for event in self._fan_out(
            user_text, slots=slots, gather_round=gather_round
        ):
            yield event

    def _emit_gather(
        self,
        slots: dict,
        missing: list[str],
        original_prompt: str,
        gather_round: int,
    ) -> list[BaseEvent]:
        """Build the events that pause a run to gather `missing` slots.

        Spec order (docs.ag-ui.com/concepts/interrupts): emit resume-needed
        state (STATE_DELTA → pendingTrip) BEFORE the interrupt finishes, then a
        terminal `planner.gathering` signal. The actual pause is carried by
        run() as a RunFinishedInterruptOutcome — this method sets self._interrupt
        and returns the lead-up events for the caller to yield.
        """
        interrupt_id = str(uuid.uuid4())
        pending = {
            "slots": slots,
            "interruptId": interrupt_id,
            "missing": missing,
            "originalPrompt": original_prompt,
            "round": gather_round,
        }
        # `replace` (not `add`): pendingTrip is a singular sibling of results[],
        # and the portal's _applyPatch implements replace for object members
        # (creating the key if absent) — so the same op writes and later clears.
        events: list[BaseEvent] = [
            StateDeltaEvent(
                delta=[{"op": "replace", "path": "/pendingTrip", "value": pending}]
            ),
            _custom_event(
                "planner.gathering", {"round": gather_round, "missing": missing}
            ),
        ]
        self._interrupt = Interrupt(
            id=interrupt_id,
            reason="input_required",
            message=_gather_message(missing),
            response_schema=_gather_schema(missing),
            metadata={"elicitationType": "gather-args"},
        )
        return events

    # -------------------------------------------------------------------------
    # LLM-driven fan-out across A2A sub-agents
    # -------------------------------------------------------------------------

    async def _fan_out(
        self,
        user_text: str,
        slots: dict | None = None,
        gather_round: int = 0,
    ) -> AsyncIterator[BaseEvent]:
        """Decide → fan out → forward frames → synthesize.

        When `slots` is provided the slot-gather gate is active: a **pre-gate**
        (before routing, when the destination is missing on a travel request)
        and a **post-gate** (after the agent set is known, for dates and a
        flights-only origin). `slots=None` is the ungated direct-dispatch path
        used by the assembly tests.

        Order of events:
          1. CUSTOM `planner.deciding` — emitted before the routing LLM call so
             the portal can render an immediate placeholder while Ollama is
             still warming up (cold start can take several seconds). Skipped on
             the pre-gate path (no routing happens — we gather instead).
          2. CUSTOM `a2a.delegation.plan` describing which agents will run.
          3. CUSTOM `a2a.delegation.update` for every streaming frame from
             every delegated agent (interleaved as they arrive).
          4. STATE_DELTA carrying the structured trip-summary card, OR a
             TextMessage* fallback when no structured data was returned.
        """
        # Resolve the sidecar registry first: the routing decision is made FROM
        # the discovered candidates (card-driven), the resolved agents are reused
        # across all delegations, and the pre-gate's travel-intent check reads
        # the candidate cards' tags. This is a fast local sidecar fetch — the
        # slow Ollama warm-up is in decide_agents, still after planner.deciding.
        await discovery.prefetch_registry()
        candidates = discovery.get_candidates()
        by_domain = {a.domain: a for a in candidates}

        # Pre-gate: a travel request that names no destination is the most common
        # vague case ("help me plan a trip"). Ask immediately — before the
        # routing LLM call and the delegation card — but only when the request
        # actually carries travel intent, so off-topic requests still fall
        # through to decide_agents and get the proper out-of-scope message.
        if (
            slots is not None
            and not _slot_present(slots, "destination")
            and llm_router._has_travel_intent(user_text, candidates)
        ):
            missing = _missing_slots(slots, list(_ALWAYS_REQUIRED))
            for event in self._emit_gather(
                slots, missing, user_text, gather_round
            ):
                yield event
            return

        yield _custom_event("planner.deciding", {})

        # Emit the unified agent.reasoning span (shared contract with the
        # Workforce AI Agent; rendered by acp-workforce-portal/lib/
        # traceProjector.js projectAgentReasoning). This span owns the
        # decision: reasoning.mode/candidates/chosen are set here, while
        # reasoning.model and reasoning.fallback (the facts only decide_agents
        # knows) are added by decide_agents onto this active span.
        runnable: list[tuple[str, str, str]] = []  # (domain, query, url)
        unreachable: dict[str, str] = {}
        # Seed origin_agent.id baggage SET-ONCE: when the portal routes here
        # directly this agent is the chain originator; when an upstream agent
        # delegated to us, that agent already named the origin and we must not
        # overwrite it. The baggage→attribute SpanProcessor (src/tracing.py)
        # copies it onto every span, including downstream A2A delegations.
        if not baggage.get_baggage("origin_agent.id"):
            otel_context.attach(baggage.set_baggage("origin_agent.id", _AGENT_ID))

        # Post-gate missing slots, computed inside the reasoning span (so the
        # interrupt outcome is stamped while the span is live) but emitted after
        # it closes (to preserve event order: delegation.plan before the gather).
        post_gate_missing: list[str] = []

        with tracer.start_as_current_span("agent.reasoning") as reasoning_span:
            # ACP-local operation name (agent.reasoning) for the portal trace
            # projection; gen_ai.operation.name makes the same span queryable by
            # OTel GenAI semconv.
            reasoning_span.set_attribute("gen_ai.operation.name", "invoke_agent")
            reasoning_span.set_attribute("reasoning.mode", llm_router.get_mode())
            # Stable agent identity (span-local) — joins to origin_agent.id baggage.
            reasoning_span.set_attribute("gen_ai.agent.id", _AGENT_ID)
            reasoning_span.set_attribute("gen_ai.agent.name", _AGENT_NAME)
            # Slot-gather tracing: gather_round is the gate pass count (0 on a
            # fresh turn), and a resume run is any pass past the first. Pre-gate
            # pauses never reach here (they short-circuit before decide_agents),
            # so this span only covers post-gate / dispatch outcomes.
            reasoning_span.set_attribute("reasoning.gather_round", gather_round)
            if gather_round > 0:
                reasoning_span.set_attribute("reasoning.resumed", True)
            reasoning_span.set_attribute(
                "reasoning.candidates", [a.domain for a in candidates]
            )

            delegations = await llm_router.decide_agents(user_text, candidates)

            reasoning_span.set_attribute(
                "reasoning.chosen", [d.get("agent", "") for d in delegations]
            )

            # Filter out delegations whose target is unreachable (no URL in registry).
            for d in delegations:
                domain = d.get("agent", "")
                query = d.get("query") or user_text
                url = await discovery.get_agent_url(domain)
                if url:
                    runnable.append((domain, query, url))
                else:
                    unreachable[domain] = "agent not registered in sidecar registry"

            # Post-gate (gated mode, agents resolved): if the card-aware required
            # rule leaves a slot unfilled, this run will pause. Record that on the
            # span now; the actual interrupt is emitted below, after the span.
            if slots is not None and runnable:
                chosen = [a for a, _, _ in runnable]
                post_gate_missing = _missing_slots(
                    slots, _required_slots(chosen, by_domain)
                )
                if post_gate_missing:
                    reasoning_span.set_attribute("reasoning.outcome", "interrupt")
                    reasoning_span.set_attribute(
                        "reasoning.missing_slots", post_gate_missing
                    )

        yield _custom_event(
            "a2a.delegation.plan",
            {
                "agents": [a for a, _, _ in runnable],
                "unreachable": list(unreachable.keys()),
            },
        )

        if not runnable:
            # Three distinct "nothing ran" cases — give the user the right why:
            #   1. Out of scope — candidates exist but the router chose none
            #      (decide_agents returned [] from the travel-intent gate). The
            #      request simply isn't a trip-planning task.
            #   2. Empty registry — no candidates discovered at all. FALLBACK:
            #      use the LLM to generate travel responses directly.
            #   3. All chosen agents unreachable — registry had them but no URL.
            if candidates and not delegations:
                reason = "out_of_scope"
                domains = ", ".join(sorted(a.domain for a in candidates))
                message = (
                    "I'm the Trip Planner — I can help with travel: "
                    f"{domains}. That request looks like it's for a different "
                    "agent, so I didn't route it anywhere."
                )
            elif not candidates:
                # Empty registry — fallback: generate response directly via LLM
                reason = "empty_registry_fallback"
                logger.info("Registry empty, falling back to direct LLM response for travel query: %r", user_text[:50])
                
                # Use LLM to generate travel planning response directly
                try:
                    from src.llm_router import generate_travel_response
                    message = await generate_travel_response(user_text)
                    yield _custom_event("planner.fallback", {"reason": "registry_empty", "mode": "direct_llm"})
                    for event in _text_events(str(uuid.uuid4()), message):
                        yield event
                    return
                except Exception as e:
                    logger.warning("Direct LLM fallback failed: %s, returning error", e)
                    message = (
                        "I couldn't reach any of the travel sub-agents — the "
                        "registry is empty."
                    )
            else:
                reason = "unreachable"
                unreachable_list = ", ".join(sorted(unreachable)) or "the sub-agents"
                message = (
                    f"I picked the right travel agents ({unreachable_list}) but "
                    "couldn't reach them right now. Please try again."
                )
            # Terminal signal so the portal can collapse the "Deciding…"
            # placeholder card (which would otherwise spin forever, since no
            # a2a.delegation.update / synthesis ever follows a no-delegation turn).
            yield _custom_event("planner.declined", {"reason": reason})
            for event in _text_events(str(uuid.uuid4()), message):
                yield event
            return

        # Post-gate: the card-aware required rule (dates always; origin only if a
        # flights-tagged agent is chosen) was evaluated inside the reasoning span
        # as `post_gate_missing`. Any still-missing slot pauses for another gather
        # round. Gated mode only (slots is not None); the delegation plan card
        # already rendered, so the portal parks those rows while it asks.
        if slots is not None:
            if post_gate_missing:
                for event in self._emit_gather(
                    slots, post_gate_missing, user_text, gather_round
                ):
                    yield event
                return
            # Fully specified — clear the pending gather before dispatching so a
            # later resume can't re-trigger on stale state.
            yield _clear_pending_delta()

        # Run all delegations concurrently, multiplex their event streams onto
        # this single AG-UI stream. Each delegation places (event_or_None,
        # agent_key, result_text) tuples on a shared queue; we drain the queue
        # in arrival order until every delegation has signalled completion.
        queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        results: dict[str, str] = {}
        structured_results: dict[str, dict] = {}
        errors: dict[str, str] = dict(unreachable)

        async def worker(agent_key: str, query: str, url: str) -> None:
            # Display name = the agent's real clientId from its card-backed
            # registry entry; fall back to the domain token if somehow absent.
            resolved = by_domain.get(agent_key)
            display = resolved.name if resolved else agent_key
            # The card drives the wire: delegate() picks streaming vs unary and
            # the A2A-Version header from this agent's published AgentCard.
            card = resolved.card if resolved else None
            collected_text: list[str] = []
            collected_data: dict | None = None
            task_id: str | None = None
            try:
                async with make_outbound_client() as http:
                    client = A2AClient(http)
                    async for frame in client.delegate(url, query, card=card):
                        if "task" in frame and task_id is None:
                            task_id = (frame["task"] or {}).get("id")
                        await queue.put((
                            "frame",
                            {
                                "agent": display,
                                "agentKey": agent_key,
                                "taskId": task_id,
                                "frame": frame,
                            },
                        ))
                        text = _extract_text(frame)
                        if text:
                            collected_text.append(text)
                        data = _extract_data(frame)
                        if data is not None:
                            collected_data = data
                        state = (
                            (frame.get("statusUpdate") or {})
                            .get("status", {})
                            .get("state")
                        )
                        if state in _TERMINAL_STATES:
                            logger.info(
                                "A2A delegation to %s reached %s (task %s)",
                                display, state, task_id,
                            )
            except A2AClientError as exc:
                logger.warning("Delegation to %s failed: %s", display, exc)
                await queue.put(("error", {
                    "agent": agent_key,
                    "message": str(exc),
                    "display": display,
                    "pazDecision": _paz_decision_from_error(str(exc)),
                }))
                return
            await queue.put((
                "done",
                {
                    "agent": agent_key,
                    "text": " ".join(collected_text).strip(),
                    "data": collected_data,
                },
            ))

        tasks = [
            asyncio.create_task(worker(a, q, u), name=f"delegate-{a}")
            for a, q, u in runnable
        ]
        remaining = len(tasks)

        try:
            while remaining > 0:
                kind, payload = await queue.get()
                if kind == "frame":
                    yield _custom_event("a2a.delegation.update", payload)
                elif kind == "error":
                    agent_key_err = payload["agent"]
                    errors[agent_key_err] = payload["message"]
                    remaining -= 1
                    yield _custom_event(
                        "a2a.delegation.error",
                        {
                            "agent": payload.get("display", agent_key_err),
                            "agentKey": agent_key_err,
                            "message": payload["message"],
                            "pazDecision": payload.get("pazDecision", "ERROR"),
                        },
                    )
                elif kind == "done":
                    text = payload["text"]
                    if text:
                        results[payload["agent"]] = text
                    data = payload.get("data")
                    if data is not None:
                        structured_results[payload["agent"]] = data
                    remaining -= 1
        finally:
            # Make sure no worker is left running if the consumer raised.
            for t in tasks:
                if not t.done():
                    t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        yield _custom_event("a2a.synthesis.started", {
            "agents": list(results.keys()),
            "errors": list(errors.keys()),
        })

        # Emit a STATE_DELTA carrying structured sub-agent data for rich card
        # rendering. The portal dispatches on view="trip_summary" to
        # renderTripSummary().
        #
        # The bucketing here is fully agent-agnostic: one `domains[]` entry per
        # responding agent, keyed by its card-derived domain token (the first
        # tag of its first skill — see src.discovery) and carrying the agent's
        # display identity plus its raw structured payload verbatim. The router
        # does NOT reshape per-domain or know any domain name — adding a new
        # travel agent surfaces it here with zero router changes. Interpreting a
        # payload into a bespoke visual card is the portal renderer's job (the
        # one accepted domain-aware hardcode, since it's genuinely UI-specific);
        # unknown domains fall back to a generic card there.
        if structured_results:
            # Packing tips: a weather-derived synthesis add-on (see
            # _PACKING_SOURCE_DOMAIN) — not part of the generic bucketing.
            packing_text = results.get(_PACKING_SOURCE_DOMAIN, "")
            packing_advice = (
                await llm_router.synthesize_packing(packing_text)
                if packing_text
                else ""
            )

            # Surface every responding domain — those with a structured payload
            # AND those that returned text only (e.g. the weather agent's
            # no-city / lookup-failure paths emit a text part but no JSON). The
            # card itself is gated on `structured_results` above (no JSON from
            # anyone → prose-synthesis fallback below), matching prior behavior;
            # within the card a text-only domain still renders via its summary.
            # Order: structured domains first (insertion order), then any
            # text-only domains not already present.
            ordered_domains = list(structured_results) + [
                d for d in results if d not in structured_results
            ]
            domains = []
            for domain in ordered_domains:
                resolved = by_domain.get(domain)
                entry = {
                    "domain": domain,
                    "agent": resolved.name if resolved else domain,
                    "data": structured_results.get(domain) or {},
                    "summary": results.get(domain) or None,
                }
                if domain == _PACKING_SOURCE_DOMAIN and packing_advice:
                    entry["packing"] = packing_advice
                domains.append(entry)

            yield StateDeltaEvent(delta=[{
                "op": "add",
                "path": "/results/-",
                "value": {
                    "runId": str(uuid.uuid4()),
                    "view": "trip_summary",
                    "data": {"domains": domains},
                },
            }])
            return

        # Fallback: no structured data from any sub-agent — emit the prose
        # synthesis so the user sees something. This path also covers the
        # all-errors case where workers produced text-only error frames.
        synthesis = await llm_router.synthesize(user_text, results, errors)
        for event in _text_events(str(uuid.uuid4()), synthesis):
            yield event

    # -------------------------------------------------------------------------
    # Async task lifecycle demo (kept from Phase 2c)
    # -------------------------------------------------------------------------

    async def _delegate_weather_async(
        self, user_text: str
    ) -> AsyncIterator[BaseEvent]:
        """Async task lifecycle demo: SendMessage(returnImmediately) → SubscribeToTask.

        Triggered by "slow weather" in the prompt. Issues an immediate-return
        SendMessage to get the Task ID, then subscribes to lifecycle transitions
        (SUBMITTED → WORKING → COMPLETED) via SubscribeToTask. Each transition
        is forwarded as an AG-UI CUSTOM event (a2a.delegation.update).
        """
        collected_text: list[str] = []

        # Resolve the weather agent from its card-backed registry entry. This
        # demo path is weather-specific by trigger ("slow weather"); the domain
        # token still comes from discovery, and the display name from the card.
        await discovery.prefetch_registry()
        weather = next(
            (a for a in discovery.get_candidates() if a.domain == "weather"), None
        )
        weather_url = weather.url if weather else ""
        weather_display = weather.name if weather else "weather"
        # A2A-Version comes from the weather agent's card (default v1.0).
        weather_version = protocol_version_from_card(
            weather.card if weather else None
        )
        if not weather_url:
            for event in _text_events(
                str(uuid.uuid4()),
                "Weather Agent isn't registered — cannot run the async demo.",
            ):
                yield event
            return

        async with make_outbound_client() as http:
            client = A2AClient(http)
            try:
                result = await client.send_message_immediate(
                    weather_url, user_text, version=weather_version
                )

                task = result.get("task") or result
                task_id: str | None = task.get("id")
                context_id: str | None = task.get("contextId")

                if not task_id:
                    text = _extract_text(result)
                    for event in _text_events(
                        str(uuid.uuid4()),
                        text or "(Weather Agent answered immediately — no task created.)",
                    ):
                        yield event
                    return

                yield _custom_event(
                    "a2a.delegation.update",
                    {
                        "agent": weather_display,
                        "agentKey": "weather",
                        "taskId": task_id,
                        "frame": {"task": task},
                    },
                )

                async for frame in client.subscribe_to_task(
                    weather_url, task_id, context_id, version=weather_version
                ):
                    yield _custom_event(
                        "a2a.delegation.update",
                        {
                            "agent": weather_display,
                            "agentKey": "weather",
                            "taskId": task_id,
                            "frame": frame,
                        },
                    )

                    text = _extract_text(frame)
                    if text:
                        collected_text.append(text)

                    state = (
                        (frame.get("statusUpdate") or {})
                        .get("status", {})
                        .get("state")
                    )
                    if state in _TERMINAL_STATES:
                        logger.info(
                            "Async task %s reached terminal state %s", task_id, state
                        )

            except A2AClientError as exc:
                logger.warning("Async weather delegation failed: %s", exc)
                for event in _text_events(
                    str(uuid.uuid4()),
                    "I couldn't reach the Weather Agent right now. Please try again.",
                ):
                    yield event
                return

        final_text = " ".join(collected_text).strip()
        if not final_text:
            final_text = "(The Weather Agent returned no text.)"

        for event in _text_events(str(uuid.uuid4()), final_text):
            yield event
