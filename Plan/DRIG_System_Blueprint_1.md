# DRIG Technical Support AI — System Blueprint

**Prepared for:** DRIG USA
**Phase 1 — AI Support Agent for Field Technicians**
**Version 1.0**

---

## 1. Executive summary

DRIG's field technicians install and troubleshoot vehicle equipment on site. When they hit a problem, the answer usually exists already — in a vendor manual, in the wiring guide, or in the head of an engineer who solved the same thing on a call two years ago. Finding it today means phoning the office and waiting.

This system puts that knowledge on the technician's phone. They ask a question by voice or by typing, and get step-by-step guidance in seconds, with a link to the exact document it came from. If the answer isn't in DRIG's documents, the system says so plainly and connects them to an engineer, passing the whole conversation across so nothing is repeated.

**The design centre is trust.** A technician who receives one confidently wrong answer stops using the system permanently. So the architecture treats two failures as equally unacceptable: inventing an answer, and hiding one that exists. Seven automated checks run before any answer reaches a phone, and four of those checks involve no AI at all — they are arithmetic and text matching, which is precisely why they are reliable.

**Where things live.** Your knowledge stays in **Zoho WorkDrive**, which remains the single source of truth and stays under DRIG's control. The technician app is hosted on **Zoho Catalyst**. The processing engine runs on **AWS**. Nothing about your documents changes ownership — AWS holds a working copy that is rebuilt from WorkDrive whenever needed.

---

## 2. What it costs and what it takes

| | |
|---|---|
| Running cost | Approximately **$182 per month** for 40–50 technicians |
| One-off setup | Approximately **$215** to process the existing call archive |
| Build timeline | **11–13 weeks**, ending with a monitored pilot |
| DRIG effort | A named project owner, a subject expert 4–6 hrs/week, and 5–8 pilot technicians |
| Ongoing DRIG effort | **A named knowledge curator** — see Section 11 |

If the system saves your engineers two hours a week, it has paid for itself several times over.

---

## 3. The problem this solves

Today a technician with a question has three options, and all of them cost time:

1. **Search the documents.** Which means knowing which of several hundred manuals covers this product, and finding the right page inside it.
2. **Call an engineer.** Which works, but interrupts someone who was doing something else — and if the question is one that's already documented, that interruption was avoidable.
3. **Rely on experience.** Fast when the technician has seen it before. Inconsistent otherwise.

The knowledge is not missing. It is **fragmented** — spread across vendor manuals, the wiring guide, job-specific schematics, and years of recorded support calls. Nobody can hold all of it, and no single place holds all of it either.

This system consolidates it into one searchable store and puts one consistent entry point in front of it.

---

## 4. Where everything lives

```
   ┌────────────────────────────────────────────────┐
   │              ZOHO WORKDRIVE                    │
   │        Your knowledge. Source of truth.        │
   │   Manuals · Wiring guide · Schematics · Calls  │
   └───────────────────────┬────────────────────────┘
                           │  read-only, scheduled
                           ▼
   ┌────────────────────────────────────────────────┐
   │                    AWS                         │
   │         Processing and search engine           │
   │  Reads WorkDrive · Builds the searchable index │
   │        Runs the answer checks · Logs           │
   └───────────────────────┬────────────────────────┘
                           │  secure API
                           ▼
   ┌────────────────────────────────────────────────┐
   │               ZOHO CATALYST                    │
   │       The app technicians open on a phone      │
   └────────────────────────────────────────────────┘
```

**Zoho WorkDrive — your knowledge, your control.** Every document, recording and spreadsheet lives here. DRIG manages access, versions and permissions exactly as you do today. The system only ever **reads** from WorkDrive. It never edits, moves or deletes anything.

**AWS — the engine.** Reading a PDF is easy. Finding the one paragraph out of forty thousand that answers a specific question, in under three seconds, is not. AWS does that work and stores a processed copy of your documents optimised for search. If it were wiped tomorrow, it would rebuild itself from WorkDrive.

**Zoho Catalyst — the app.** A web app that installs to a technician's home screen like a normal app. Nothing to distribute through an app store, and updates reach everyone instantly.

**Why the split.** Keeping knowledge in WorkDrive means DRIG's documents never leave systems DRIG controls. Running the engine on AWS gives us the specialised database capability this needs, which Zoho does not currently provide. Hosting the app on Catalyst keeps your user-facing footprint in the Zoho environment your team already administers.

---

## 5. How knowledge gets in

### 5.1 Two ways in, one destination

**Scheduled sync.** The system checks WorkDrive on a schedule — manuals overnight, the wiring guide every four hours, call recordings monthly. Anything new or changed is processed automatically. Nobody has to remember to do anything.

**Admin upload.** A manager uploads a file through the admin panel. Rather than putting it straight into the search index, the system **places it into the correct WorkDrive folder** and lets the normal sync pick it up.

That second point is deliberate and worth understanding. It means there is only ever one place your knowledge lives. A document uploaded through the app is a document in WorkDrive — visible to your team, under your permissions, backed up by your policies. There is no shadow copy that only the AI knows about.

### 5.2 What happens to each file type

**PDF manuals** — the system reads the text, splits it into sections of roughly 400–600 words (*chunks*), and tags each with where it came from: document, page, section heading. Figures and diagrams are extracted separately and stored so they can be shown alongside answers.

Two rules matter here. **Numbered procedures are never split** — cutting a twelve-step installation between steps 4 and 7 would produce an answer missing a step. And **warning boxes are attached to the procedure they relate to**. In the ECCO 5500 manual, for example, the instruction "Disable power before wiring up the microbar" sits in a separate box from the eight numbered mounting steps. Processed carelessly, that warning would be lost.

**Word documents** — the same treatment, using heading structure instead of page numbers for references.

**Images** — a photograph or scanned diagram uploaded on its own is stored and described so it can be found by search. **The description never becomes an answer.** More on this in Section 7.

**Call recordings** — the longest journey. Audio is transcribed with speaker separation so we know which voice is the engineer (their turns carry the resolution). Each call is split into separate problems — one call often covers three — and each is condensed into a structured summary: the symptom, the context, the root cause, the fix.

**Every one of those summaries is reviewed by a person before it enters the system.** Raw transcripts are never used directly. They contain false starts and half-diagnoses that turned out wrong, and indexing them would mean the assistant confidently repeats a theory someone floated at minute three of a call and then abandoned.

### 5.3 Handling document revisions

When a vendor issues revision 5 of a manual, revision 4 doesn't vanish from the folder. If both were searchable, a technician could get guidance from the old one — correctly quoted, correctly cited, and out of date.

So every document is marked **current**, **superseded** or **archived**. Only current documents are searched. Superseded ones are kept so that old conversations can still be audited, but they are invisible to new questions.

When a manager uploads a replacement, the system asks whether it supersedes an existing document. This is a required answer, not an optional field.

---

## 6. How an answer is made

Seven checks run between a technician's question and the words on their screen. Four of them use no AI at all.

### Check 1 — Did we understand the question?

The system works out what is actually being asked: which product, what symptom, which vehicle. If something essential is missing, it asks — but only if the answer genuinely depends on it.

It tests this by running the search **both ways**. If the answer is the same either way, it just answers. If the answers differ, it asks, and asks about something real rather than a generic prompt.

*Technically: entity extraction and slot resolution, with a speculative retrieval comparison.*

### Check 2 — Did we find anything worth using?

After searching, the system assesses how good the matches are. If nothing relevant came back, it **stops here and never asks the AI to write anything at all.**

This is the most important check and the least obvious. An AI given thin material and asked to be helpful will produce something helpful-sounding. Removing it from the process removes the problem.

*Technically: a retrieval admission threshold.*

### Check 3 — Do these documents actually answer this question?

A separate judgement, made before any answer is written: can these passages answer this fully, partly, or not at all? *Partly* is a real and useful outcome — answer what we can, then state plainly what's missing.

This is kept deliberately separate from writing the answer, because anyone asked to both judge whether they can answer *and* produce the answer will talk themselves into answering nearly every time.

*Technically: a coverage classification stage.*

### Check 4 — Write it as steps, each tagged with its source

The AI doesn't produce paragraphs. It produces numbered steps, each carrying a reference to the specific passage it came from. Our own software assembles the readable text.

You cannot verify a paragraph. You can verify a step against its source.

*Technically: constrained generation with a source-identifier contract.*

### Check 5 — Is every source real?

No AI here. Every step names its source, and we confirm that source was genuinely among the documents retrieved **for this question**. Any step referencing something that wasn't retrieved is deleted. If nothing survives, the whole answer is discarded and the technician is told we don't have it. They never see what was thrown away.

*Technically: deterministic citation validation.*

### Check 6 — Do the specific details match exactly?

The dangerous mistake in this business isn't a wrong paragraph. It's a **right-looking paragraph with one wrong number.**

Every wire colour, pin number, fuse rating, torque figure and measurement is extracted from the answer and checked against the document that step cites. If the answer says "blue wire at pin 7", both of those must appear in that passage.

*Technically: the literal guard.*

### Check 7 — Did we leave anything out?

The first six confirm that what we said is correct. None of them check whether we missed something.

If a manual says *"disconnect the negative terminal, then test continuity at pin 7"* and the answer only says *"test continuity at pin 7"*, every word is accurate and every detail matches. All six earlier checks pass — and a technician puts a probe on a live circuit.

This check compares the answer against the source's own numbered list and confirms that any instruction containing a warning, a disconnect, or an isolation step survived into what the technician reads.

*Technically: the completeness check.*

---

## 7. Diagrams and images

Many DRIG documents carry the answer in a picture — a connector pinout, a tail light schematic, an exploded assembly view.

**The system shows diagrams. It does not read them.**

This is a deliberate limit, and the reason is worth stating plainly. If an AI is asked to read a wiring diagram, it will produce an answer. On most drawings it will be right, because most drawings follow convention — green for right turn, yellow for left. On the drawings that *deviate from convention*, which are exactly the ones a technician needs help with, it will be wrong, and there is no way to tell the two cases apart.

So when a value exists only in a picture, the correct answer is:

> Here is the schematic for this exact build — drawing DTS 105246-001 Rev A, Rent-A-Center ProMaster Dura-Cube. The connection is shown in the diagram below. Confirm it visually before connecting. Want me to get an engineer?

**Finding the right drawing is the hard part. Reading it is not** — your technicians can do that. The system solves the hard part and stays out of the way on the rest.

Images are stored full-size and as a fast-loading version, so a diagram opens in about a second even on poor signal at a vehicle.

---

## 8. Four real scenarios

### Scenario A — A documented answer, from a manual

> **Technician:** "5550 lightbar isn't flashing, just steady on. What do I check?"

The system identifies the product and the symptom, notices that single-colour and dual-colour versions wire differently, and asks one question: *"Single or dual colour? Dual has a white wire as well as red."*

Technician answers. The ECCO manual's flash-pattern section is retrieved. The answer:

> Your 5550 is stuck in steady mode. The blue wire selects the flash pattern:
> 1. Touch blue to black briefly (under 1 second) to move to the next pattern
> 2. Hold 2–3 seconds to go back a pattern
> 3. Holding about 5 seconds forces steady — that's likely what happened
>
> **Disable power before working on the wiring.**
>
> *Source: ECCO 5500 Series Installation Instructions, p.3* →

Under fifteen seconds. Every timing verified against the manual. The safety line preserved by Check 7 — it lives in a separate box on the page and would otherwise have been dropped.

### Scenario B — A wiring lookup

> **Technician:** "2019 Acura RL, where's the ignition wire?"

Wiring is **not** handled by AI search. It is a direct database lookup on make, model, year and start type.

This matters. Rows for a 2019 and a 2021 model are nearly identical in wording and completely different electrically. An AI similarity search would return the near match and state the wrong pin with a valid-looking citation. A direct lookup returns the exact row or nothing at all.

If the vehicle isn't in the guide, the answer is *"the wiring guide covers 2019–2023 for this model, not 2024 — shall I get an engineer?"* Never a near miss.

### Scenario C — A job-specific schematic

> **Technician:** "Rent-A-Center ProMaster, where does the green wire go on the tail lights?"

The system finds the exact drawing for that customer, chassis and body configuration, and displays it full-screen and zoomable, with the drawing number and revision.

It does **not** state which terminal the green wire connects to. That relationship exists only as a line on a drawing, and Section 7 explains why we won't guess at it.

### Scenario D — Something we don't have

> **Technician:** "2024 ProMaster with the new camera module, how do I pair it?"

Nothing in the documents covers it. The system says so:

> I don't have documented guidance for the 2024 camera module. Our manuals cover the previous generation. I can hand this to an engineer now, with everything you've told me — want me to?

The technician escalates. The engineer receives the whole conversation and resolves it.

**And here is where the system earns its keep long-term.** That unanswered question is recorded. Every week, unanswered questions are grouped and ranked, and management sees:

> **"Nine technicians asked about the 2024 camera module. Nothing documented."**

An engineer writes the answer once. It's reviewed, added, and self-served from then on. The system tells you what it doesn't know, and that becomes your documentation priority list.

---

## 9. Voice

A technician with tools in both hands presses and holds a button, speaks the question, and hears the answer read back one step at a time. The text stays on screen throughout.

Two design decisions:

**Press-and-hold, not always-listening.** A workshop with a running engine defeats automatic voice detection entirely.

**Confirmation before acting.** If the system isn't confident it heard correctly, it asks — *"Did you say 2022 Transit?"* — rather than silently running the wrong query. Numbers and model codes are always confirmed back and always shown on screen.

The spoken answer goes through all seven checks first. Nothing unverified is ever spoken, because **spoken words cannot be taken back.**

---

## 10. Who can do what

| | Technician | Engineer | Manager | Admin |
|---|---|---|---|---|
| Ask questions | ✓ | ✓ | ✓ | ✓ |
| Receive escalations | | ✓ | | |
| See all conversations | | | ✓ | ✓ |
| Upload documents | | | ✓ | ✓ |
| Approve and publish | | | ✓ | ✓ |
| Retire a document | | | ✓ | ✓ |
| Dashboards and gap reports | | | ✓ | ✓ |
| System settings | | | | ✓ |
| Manage users | | | | ✓ |

Every upload, approval and retirement is logged with who did it and when. If an answer turns out wrong six months from now, we can trace exactly which document introduced it.

---

## 11. Two things DRIG should decide before we start

### 11.1 The wiring guide has data errors

While reviewing the wiring guide you shared, we examined the first 100 rows — all Acura — and found a pattern that needs your attention.

Acura RL, model years 2008 through 2012, both columns citing the same **brown 7-pin connector**:

| Year | 12V | Ignition |
|---|---|---|
| 2008 | Pin 3 | Pin 6 |
| 2009 | Pin 4 | Pin 7 |
| 2010 | Pin 5 | Pin 8 |
| 2011 | Pin 6 | Pin 9 |
| 2012 | Pin 7 | Pin 10 |

**A 7-pin connector has no pin 8, 9 or 10.** And the pin number advances by exactly one per model year in both columns, which real wiring does not do. This is the signature of a spreadsheet fill — someone dragged a cell down and the software auto-incremented the number. The same pattern appears in the RLX and NSX rows.

**Why this matters more than an ordinary data issue.** All seven checks verify that an *answer* matches its *source*. None of them can catch a source that is wrong. If the guide says pin 9, the system will faithfully relay pin 9, cite it correctly, and pass every check.

**What we propose.** Before the build starts, we run two automated checks across the complete guide — one confirming no pin number exceeds its connector's pin count, one detecting the fill pattern. That takes under a day and tells us the scale of the problem. Rows that fail are held back rather than served, and a question hitting one returns *"this entry is flagged for review"* plus an escalation.

This is worth knowing regardless of this project. Your technicians are using this guide today.

### 11.2 Someone needs to own knowledge quality

The system improves by feeding unanswered questions back to people who can answer them. That loop is what stops it going stale — and it needs a person.

Realistically, during the first few months: reviewing call summaries, checking flagged data, and working through the weekly gap list adds up to **15–20 hours a week**, settling lower once the backlog clears.

The current proposal assumes 4–6 hours a week from a subject expert. That covers design sign-off and testing. It does not cover ongoing curation.

Our recommendation is to name a part-time knowledge curator — most naturally an experienced technician or a support lead. Without one, the improvement loop becomes a backlog and the system stops getting better in month two.

---

## 12. What we need from DRIG

| What | When |
|---|---|
| Named project owner who can approve scope and sign off milestones | Before start |
| Subject expert, 4–6 hrs/week | Throughout |
| **Named knowledge curator** for after go-live | Before go-live |
| WorkDrive access with a consistent folder structure | Week 1 |
| The current wiring guide, exported with cell links intact | Week 1 |
| Around 30 real technician questions for the test set | Week 1 |
| Approved list of vendor websites the system may consult | Week 1 |
| 5–8 pilot technicians and the engineers who cover escalations | Week 10 |
| Milestone decisions within 5 working days | Throughout |

**One note on the WorkDrive migration.** You are consolidating everything into WorkDrive anyway, and that migration is the single cheapest moment to get the folder structure right. If manuals land in a structured tree — vendor, product, revision, date — the system reads that structure and the tagging is free. If they land in one flat folder, every document needs manual tagging forever. We'll supply the folder convention in week 1.

---

## 13. Timeline

| Weeks | Stage | What you see |
|---|---|---|
| 0 | Validation | Wiring guide data assessment. Go/no-go on scope |
| 1 | Discovery | Design sign-off, test question set agreed |
| 2–6 | Knowledge base | All sources processed. **Working demo in week 2** |
| 6–9 | The assistant | Text answering, tested against your questions |
| 9–10 | Voice | Tested on your technicians' actual phones |
| 10–11 | Escalation and reporting | Engineer handoff, dashboards |
| 11–12 | Pilot | 5–8 technicians on real jobs, reviewed daily |
| 12–13 | Go-live | Staged rollout with active support |

---

## 14. What Phase 1 does not include

- **Any change to your systems.** The assistant reads. It never writes to a manual, spreadsheet or recording.
- **Self-teaching.** Every knowledge update is approved by a person.
- **The complete call archive.** Prioritised batches in Phase 1; the rest afterwards using the same process.
- **Reading diagrams.** Explained in Section 7.
- **Photo diagnosis.** A technician photographing a connector and asking "is this right?" is a natural next capability and a strong Phase 2 candidate.

---

## 15. Where this goes next

The foundation built in Phase 1 — structured job records, role management, connectors to your systems, complete activity logging — is designed so that later capabilities are new screens rather than a rebuild.

| Phase | Capability |
|---|---|
| 2 | Structured job capture — guided records, photos, completion evidence |
| 3 | Scheduling and dispatch |
| 4 | Customer updates and billing links |
| 5 | Performance analytics |

Each is scoped and quoted separately when its requirements are clear.

---

## 16. In one paragraph

This system's whole value is that technicians trust it. That means the engineering is less about producing clever answers than about making it structurally incapable of two things: inventing an answer, and hiding one it already has. Your knowledge stays in WorkDrive under your control. The app runs on Catalyst alongside your other Zoho tools. AWS does the search work in the middle. And every answer a technician reads can be traced back to the exact page it came from.
