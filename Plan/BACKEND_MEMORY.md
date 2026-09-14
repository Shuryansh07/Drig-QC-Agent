# Backend Memory — Implementation Plan

How the agent remembers within a conversation, across a session, and across a technician's working day — without that memory becoming a route around the seven gates.

---

## 1. The governing idea

**The frame is the memory. The transcript is not.**

The obvious way to build multi-turn memory is to append every message to a growing array and send the whole thing to the model each turn. For a grounded system that is actively harmful:

- The prompt grows without bound, and cost with it.
- The stable prefix stops being stable, so prompt caching stops working.
- Earlier *answers* sit in context, and the model starts treating its own prior output as established fact.

That third point is the serious one. If turn 3's answer says "the blue wire at pin 7" and turn 5 asks a follow-up, an unstructured transcript lets the model reuse "blue wire at pin 7" as grounding without any chunk ever being retrieved for it. Gate 5 sees a valid-looking step, Gate 6 finds the literal in… the model's own earlier claim. **Conversation history becomes a laundering path for ungrounded content.**

So the structure is: extract meaning into a typed frame, carry the frame forward, and retrieve fresh every single turn.

---

## 2. Four layers

| Layer | Lifetime | Store | Purpose |
|---|---|---|---|
| **L0 — Turn context** | One request | Process memory | Retrieved chunks, gate decisions, scores. Discarded after logging |
| **L1 — Working memory (the frame)** | One session | Cache, write-through to DB | What we know about this problem: vehicle, symptom, what's been tried, what's been asked |
| **L2 — Conversation history** | One session | Postgres, bounded window in prompt | Understanding follow-ups like "what about the ignition side?" |
| **L3 — Technician recall** | Across sessions | Postgres | Recent vehicles, open cases. Convenience only — never grounding |

### The hard rule across all layers

> **Nothing from L1, L2 or L3 may ever be cited as a source.**
> Only chunks retrieved in the current turn are eligible for `source_chunk_ids`.

Gate 5 enforces this mechanically: the valid-id set is built fresh from this turn's retrieval, and memory contributes nothing to it. Memory shapes *what we search for*. It never supplies *what we answer with*.

---

## 3. L1 — Working memory

### Shape

```python
@dataclass
class SessionFrame:
    session_id: str
    org_id: str
    workflow_id: str

    # Vehicle — accumulates across turns
    make: str | None
    model: str | None
    year: int | None
    start_type: str | None          # 'pts' | 'key'
    vehicle_confidence: float

    # Problem
    product: str | None
    symptom: str | None
    error_code: str | None
    install_stage: str | None
    circuit: str | None

    # Interaction history, structured
    already_tried: list[str]        # things the technician reports doing
    asked_slots: list[str]          # never ask the same thing twice
    declined_slots: list[str]       # they said "I don't know" — stop asking
    refused_topics: list[str]       # what we've already said isn't covered

    version: int                    # optimistic concurrency
    updated_at: datetime
```

`asked_slots` and `declined_slots` are what make the agent feel like it is paying attention. Asking "which model year?" twice in one conversation is the fastest way to lose a technician's patience, and it is entirely avoidable with a list.

### Merge, don't replace

Each turn extracts a partial frame from the new message and merges it into the session frame:

```python
def merge(existing: SessionFrame, incoming: PartialFrame) -> SessionFrame:
    out = copy(existing)
    for field in VEHICLE_FIELDS + PROBLEM_FIELDS:
        new = getattr(incoming, field)
        if new is None:
            continue                                  # absence never clears
        old = getattr(existing, field)
        if old is not None and old != new:
            out.record_correction(field, old, new)    # log it, take the newer
        setattr(out, field, new)
    out.already_tried = dedupe(existing.already_tried + incoming.already_tried)
    out.version += 1
    return out
```

**Absence never clears a value.** If turn 1 established a 2019 Silverado and turn 4 says "what about the ignition wire", the extractor returns `make: null` simply because the message doesn't mention it. Overwriting would silently lose the vehicle and send retrieval somewhere else entirely.

**Corrections are logged, not swallowed.** When the technician says "sorry, it's a 2021 not a 2019," the frame takes the new value and writes a `frame_correction` event. That event is worth surfacing in the UI — "switching to 2021" — so the technician can see the system tracked the correction.

### Storage

```
Cache (Catalyst Cache or Redis)
  key    session:{session_id}:frame
  value  JSON, ~2KB
  TTL    4 hours, refreshed on each turn
```

Write-through: cache first for latency, Postgres for durability. On cache miss, rebuild from the most recent `message.frame_json` — no data is lost, only a few milliseconds.

```sql
ALTER TABLE message ADD COLUMN frame_json jsonb;   -- snapshot AFTER this turn's merge
```

Snapshotting per message rather than only in the cache gives you two things for free: full replay of how understanding evolved, and an audit trail when someone asks why the agent searched a 2019 when the technician meant 2021.

### Concurrency

Two tabs, or a retry after a flaky connection, can both write. Optimistic concurrency on `version`:

```sql
UPDATE session_frame SET frame_json = $1, version = $2
WHERE session_id = $3 AND version = $2 - 1;
```

Zero rows updated means someone else wrote first — reload, re-merge, retry once, then fail loudly. A silently lost correction is worse than a visible error.

---

## 4. L2 — Conversation history

### Bounded window, never unbounded

```python
def build_history(session_id: str, limit: int = 6) -> list[Message]:
    """Last N turns verbatim. Older turns are represented by the frame alone."""
```

Six turns covers essentially every real troubleshooting exchange. Beyond that, the frame already carries everything that mattered.

**No rolling LLM summary.** It is tempting, and it is a slow leak: a summary is model-generated text that becomes context for the next turn, drifting a little each time, with no citation and no way to validate it. The frame is a typed, validated, auditable structure that does the same job without the drift.

### Answers enter history stripped

```python
def to_history(turn: Turn) -> Message:
    if turn.role == "assistant":
        return Message(
            role="assistant",
            content=summarize_for_context(turn),   # "Gave 4 steps on ignition wiring"
            citations_stripped=True,
        )
    return Message(role="user", content=turn.text)
```

The model sees *that* it answered and roughly about what. It does not get the full prior answer text back as raw material. This is the concrete mechanism that closes the laundering path from §1.

---

## 5. L3 — Cross-session recall

Deliberately thin.

```sql
CREATE TABLE technician_recall (
  person_id     uuid PRIMARY KEY,
  recent_vehicles jsonb,    -- last 5, with timestamps
  open_handoffs   uuid[],
  updated_at      timestamptz
);
```

Used for exactly two things: prefilling the vehicle picker with "you were working on a 2021 Transit an hour ago," and surfacing unresolved handoffs on login.

**It never enters the model prompt.** It is a UI convenience layer. The moment cross-session recall reaches the prompt, you have a system whose answers depend on what a technician asked last Tuesday, which is untestable and unauditable. The golden set cannot cover it, so it cannot be trusted.

---

## 6. Prompt assembly

Order matters, because only a stable prefix caches:

```
┌─ STABLE (caches at 10% of input cost) ─────────┐
│ 1. System prompt — role, rules, output contract│
│ 2. Answer JSON schema                          │
│ 3. Settings-driven behaviour rules             │
├─ VARIABLE ─────────────────────────────────────┤
│ 4. Session frame (compact rendering)           │
│ 5. Bounded history (stripped)                  │
│ 6. Retrieved chunks — THIS TURN ONLY           │
│ 7. The question                                │
└────────────────────────────────────────────────┘
```

Sections 1–3 are byte-identical every call. Move anything variable above them and caching stops working entirely.

Realistic cache hit rate is 20–30% of input tokens, not the 60% quoted earlier — retrieved context dominates the prompt and changes every turn.

---

## 7. Retrieval runs every turn

No caching of retrieval results across turns. A follow-up question is a new question with more context, and the frame has changed.

```python
async def handle_turn(session_id, text):
    frame  = await load_frame(session_id)          # cache, fall back to DB
    partial = await extract_frame(text, frame)
    frame  = merge(frame, partial)

    if slot := needs_clarification(frame):         # Gate 1, ask-vs-answer rule
        frame.asked_slots.append(slot)
        await save_frame(frame)
        return clarify(slot, frame)

    chunks = await retrieve(frame, text)           # fresh, every turn
    await save_frame(frame)
    return await run_gates(frame, chunks, text)
```

Two turns about the same vehicle will retrieve overlapping chunks. That is fine and correct — each answer stands on its own retrieval, which is precisely what makes each answer independently auditable.

---

## 8. Session lifecycle

| Event | Action |
|---|---|
| Technician opens the app | New session, empty frame, L3 prefills the vehicle picker |
| Each turn | Merge, persist snapshot, refresh TTL |
| Resolution confirmed | Close session, write outcome, update L3 |
| Handoff | Frame and full history transfer to the engineer — nothing is repeated |
| 4h idle | Cache expires; reopening rebuilds from DB, offers "continue with the 2021 Transit?" |
| New vehicle mentioned | Offer a fresh session rather than merging two problems into one frame |

That last one matters. A technician moving to the next job should not inherit the previous vehicle's symptom. Detect a vehicle change with no accompanying symptom change and offer a clean start.

---

## 9. Caching beyond session memory

| What | Store | TTL | Note |
|---|---|---|---|
| Session frame | Cache | 4h | §3 |
| Settings (prompts, thresholds) | Process memory | 5 min | Hot path, changes rarely |
| Embedding of an identical query | Cache, hashed | 24h | Meaningful saving on repeated phrasings |
| Vehicle alias table | Process memory | 1h | Small, read constantly |
| Document metadata for citations | Cache | 1h | Rendering the citation drawer |
| **Retrieval results** | **Never cached** | — | Fresh retrieval per turn is a correctness property |
| **Generated answers** | **Never cached** | — | An identical question from a different technician may carry a different frame |

---

## 10. Failure behaviour

| Failure | Behaviour |
|---|---|
| Cache unavailable | Fall back to Postgres for every frame read. Slower, fully correct |
| Frame corrupt or unparseable | Start a clean frame, log an incident, tell the technician the context was reset |
| Version conflict | Reload, re-merge, retry once, then surface the error |
| Frame extraction fails | Retry once at lower temperature; on second failure, treat as a plain question with no frame and let Gate 1 ask |
| History query slow | Proceed with the frame alone — degraded understanding beats a timeout |

---

## 11. Test cases

These are the ones that catch real memory bugs:

1. Turn 1 establishes a vehicle; turn 4 asks a follow-up without repeating it → retrieval still scoped correctly.
2. Technician corrects the year mid-conversation → new value wins, correction logged, retrieval re-scoped.
3. Same slot is never asked twice in one session.
4. Technician says "I don't know" to a slot → never asked again.
5. Turn 3 answers with a wire colour; turn 5 asks a follow-up → **no step in turn 5 cites anything not retrieved in turn 5**.
6. Cache flushed mid-conversation → frame rebuilds from DB, conversation continues seamlessly.
7. Two concurrent writes → one wins, the other retries, no correction lost.
8. New vehicle mentioned → offered a fresh session, symptom not inherited.
9. 20-turn conversation → prompt size stays bounded, stable prefix still cache-eligible.

Test 5 is the important one. It is the difference between a system that remembers and a system that accumulates its own unverified claims.
