# Wiresheet Scraping Plan

How we pull wiring data from Wiresheet into the DRIG QC agent: what we scrape,
how we scrape it without risking the login, where the images go, and how the
result sits next to DRIG's own wiring guide.

Source of the requirements: `DrigDocuments/Todd Questions.xlsx` (Todd's answers
to Q1–Q10). Q11–Q13 are still open; §11 lists the default we build to until Todd
answers.

---

## 1. What Todd told us, and what it means for the scraper

| # | Todd said | What the scraper must do |
|---|---|---|
| Q2, Q3 | Wiresheet is a **supplement**, not a replacement. It is written for remote-start installs and can point to connection points that differ from DRIG's GPS standard (e.g. Chevy Express: Wiresheet says BCM / ignition switch, DRIG uses the junction module). | Keep Wiresheet data in **its own tables**, never merged into `wiring_entry`. The DRIG guide always wins. Every Wiresheet answer is labelled as Wiresheet, with a "may differ from DRIG standard, call QC if unsure" line. |
| Q3 | The current guide came from Directechs and AstroStart, not Wiresheet. Todd wrote separate guides for Teslas, E-Transit, F-150 Lightning, Kia Soul EV and semi trucks. | We cannot assume guide and Wiresheet agree. We **compare** them (§8) and send disagreements to Todd. EVs and semis come from Todd's guides only. |
| Q2 | Not sure the 2024 scrape (to Oct 2024, in Google Drive) was complete. | Treat the 2024 data as a baseline to diff against, not as a source of truth. Re-scrape everything. |
| Q4 | No Directechs access any more. Replace those links with Wiresheet pages and test logged out. | Side output: a mapping of each Directechs row → matching Wiresheet URL (§9). |
| Q5 | Blank rows in the guide just mean "not filled in". Not "check Wiresheet", not "same as last year", not "we don't install". | Wiresheet values can be offered as **draft fills** for Todd to approve. Never auto-fill the DRIG guide. |
| Q6 | Go ahead with the scraper. The login belongs to **Lesco Distribution**, so losing it hurts them too. Not confirmed that their account allows it. | Low, human-paced load; hard stop on any warning sign (§5). Ask Lesco to confirm before the full run (§11). |
| Q6 | Scope: Security view only, **12V constant and ignition**. Door locks, starter kill etc. → send the tech to Wiresheet. | Scrape only the Security view, and only the 12V constant and ignition rows. Store the page URL so the agent can link to it for everything else. |
| Q7 | The agent must **ask** push-to-start or keyed. The VIN cannot tell. | Capture start type on every row. When a vehicle has both, the agent asks. |
| Q8, Q9 | Mismatch or no diagram → call QC. Never tap airbag circuits. Use DRIG's approved parts only. The agent must never tell a tech to cancel. | Flag any scraped value that mentions airbag / SRS. "Not on Wiresheet" → QC handoff, never a guess. |

---

## 2. Goal and non-goals

**Goal.** For every vehicle on Wiresheet, store the 12V constant and ignition
connection details (as Wiresheet states them), the photos and diagrams that go
with them, and a link back to the page. The agent can then answer *"2021 Ford
Transit keyed, where's ignition?"* when the DRIG guide has no row, clearly
labelled as Wiresheet.

**Non-goals.**
- No other circuits (door locks, starter kill, tach, parking lights, CAN, etc.).
- No reading of diagrams by a model to extract values. Images are **shown**, not
  read (blueprint §7). Values come only from Wiresheet's own text.
- No writing to the DRIG wiring guide. Fills go to Todd as a review sheet.
- No RingCentral work (Q14 is a separate decision).

---

## 3. Phases

| Phase | What | Output | Load on Wiresheet |
|---|---|---|---|
| 0. Recon (manual) | One person, logged in, maps the site by hand with browser DevTools open | `wiresheet-site-map.md`: URL patterns, navigation tree, where the Security view lives, how PTS/Key and variants appear, whether data comes as HTML or JSON, how images load | A few dozen page views |
| 1. Pilot | Scrape **one make** (Acura, so we can compare against the rows already reviewed in blueprint §11.1) end to end | Rows + images in a staging schema, a review sheet for Todd | ~200 pages |
| 2. Index crawl | Walk make → model → year to list every vehicle document | `wiresheet_vehicle` filled (expect ≈ 11,650) | One page per model/year listing |
| 3. Detail crawl | For each vehicle, fetch the Security view | Raw HTML/JSON snapshots in S3, task status per vehicle | ≈ 11,650 pages over several nights |
| 4. Parse | Parse the snapshots offline into 12V / ignition rows | `wiresheet_entry` rows | **None.** Re-runs never touch the site. |
| 5. Images | Download the images referenced on each Security view, make thumbnails | Images in S3 + `wiresheet_image` rows | One request per new image |
| 6. Validate + reconcile | Run checks, compare against the DRIG guide | Coverage report + review sheet for Todd (§8) | None |
| 7. Publish | Atomic swap to a new scrape version | Agent can use it | None |
| 8. Refresh | Monthly delta re-check | Changed pages only | Small |

Todd signs off the pilot (phase 1) before phases 2–3 run at full scale.

---

## 4. Scraping technique

### 4.1 Tooling

- **Playwright (Chromium, headed or headless)** for login and session. Wiresheet
  is a logged-in dealer site; a real browser handles the cookies, redirects and
  any client-side rendering without us reverse-engineering auth.
- **Prefer the site's own JSON calls when recon finds them.** If the Security
  view is filled by an XHR/fetch call, call that endpoint with the browser
  session's cookies (`page.request` / `context.request`) instead of rendering the
  page. It's one small request instead of a page plus its assets, and gives
  structured data instead of HTML to parse.
- If the data is only in rendered HTML, use Playwright to load the page, wait
  for the Security section, and save `page.content()`.
- Lives in the backend as a separate worker script
  (`BackEnd/scripts/wiresheet/…`), run by hand or on a schedule. **Never** part
  of the API process.

### 4.2 Session and credentials

- The Wiresheet username/password go in **AWS Secrets Manager**
  (`@aws-sdk/client-secrets-manager` is already a dependency), never in `.env`
  committed to git and never in logs.
- Log in **once**, save Playwright `storageState` (encrypted at rest, local to
  the worker), reuse it across runs. Re-login only when a request comes back
  logged-out. Logging in hundreds of times looks far more like a bot than
  browsing does.
- One session at a time. Never run the scraper while a second copy is running.
- Run when technicians are least likely to be using the account (overnight US
  time), so a lockout would hit no one mid-install.

### 4.3 Pacing (human-like, low load)

| Setting | Value | Why |
|---|---|---|
| Concurrency | **1** | A person views one page at a time |
| Delay between pages | Random **6–15 s** (uniform), plus a **2–5 min** pause every 40–60 pages | No fixed rhythm |
| Nightly cap | **1,500 pages** | ≈ 11,650 vehicles in about 8 nights |
| Window | e.g. 22:00–05:00 Central | Off-shift for techs |
| Order | Shuffled within a make, not strictly A→Z | Less like a sequential sweep |
| Assets | Block fonts, analytics, ads; load images only in phase 5 | Fewer requests per page |

At ~10 s per page, 1,500 pages is ~4–5 hours a night.

### 4.4 Stop rules (hard stop, alert a person, do not retry automatically)

- HTTP **401 / 403** after a fresh login, or a redirect to login twice in a row.
- HTTP **429**, or any "too many requests / unusual activity" text.
- A **CAPTCHA**, a terms or "verify you're human" page.
- An account warning or email from Wiresheet / Lesco.
- More than 5 % of the last 100 pages failing to parse (layout changed).

5xx and timeouts: retry up to 3 times with backoff (30 s, 2 min, 10 min), then
mark the task `failed` and move on.

### 4.5 Resumable, never re-fetch

- Every vehicle is a row in `scrape_task` with a state (`pending`, `fetched`,
  `parsed`, `failed`, `skipped`). A crash or a stop rule resumes from where it
  stopped.
- The **raw response is saved to S3 before parsing**
  (`wiresheet/raw/<run_id>/<vehicle_key>.html|json`). Parser bugs are fixed by
  re-parsing the snapshots, never by re-scraping.
- Each snapshot stores its `content_hash`. The monthly refresh compares hashes
  and only re-parses pages that changed.

### 4.6 Things that keep it polite

- Send a normal desktop User-Agent and keep the same one for the whole session.
  Do not rotate IPs or fingerprints: we are a known customer with a login, not
  hiding.
- Respect `robots.txt` where it applies to the logged-in area, and read
  Wiresheet's terms of service in phase 0. If the terms forbid automated
  access, stop and raise it with Todd and Lesco before phase 1.

---

## 5. What to scrape from each vehicle page

Only the **Security** view. From it, only the **12V constant** and **ignition**
rows. Field names below are ours; phase 0 maps them to what Wiresheet actually
shows.

| Field | Example | Notes |
|---|---|---|
| `year`, `make`, `model` | 2019, Ford, Transit | As Wiresheet names them; normalised copies alongside |
| `trim` / variant text | "Gas", "w/ Upfitter Switches" | Kept verbatim; variants are separate rows |
| `start_type` | `pts` / `key` / `null` | From the page or the model name ("PTS"/"Key"). `null` only when Wiresheet doesn't distinguish |
| `circuit` | `12v` / `ignition` | Nothing else |
| `ordinal` | 1, 2 | Position when a circuit appears more than once (Q13, two 12V rows) |
| `wire_colour` | "Red/White" | Verbatim |
| `polarity` / signal | "+", "(+) 12V" | Verbatim |
| `location` | "Ignition switch harness, 6-pin white plug" | Verbatim |
| `pin`, `connector` | 3, "White 6-pin" | Only if Wiresheet states them as separate fields |
| `notes` | Any note under the row | Verbatim |
| `cell_raw` | The full row text, exactly as on the page | **What the technician is shown**, same rule as `wiring_entry` |
| `page_url` | Link to the Wiresheet page | For "see Wiresheet for door locks etc." and for citation |
| `image_refs` | URLs of photos/diagrams for these circuits | Downloaded in phase 5 |
| `scraped_at`, `content_hash` | | Provenance |

Rule: **verbatim first, parsed second.** `cell_raw` is always stored. The parsed
fields help lookups and checks. When parsing fails, keep the row with
`parse_confidence` low rather than dropping it.

---

## 6. Image storage

Follows the existing storage service (`BackEnd/src/services/storage.service.js`)
and the DATABASE.md rule: **store S3 keys only, never URLs or bucket names.**

**Keys**

```
wiresheet/img/<sha256>.<ext>          original, as downloaded
wiresheet/thumb/<sha256>.webp         ~640 px wide, for slow phone signal
wiresheet/raw/<run_id>/<vehicle_key>.html|json   page snapshots (§4.5)
```

- Keyed by **content hash**, so the same photo used on 40 vehicle pages is
  stored once. Before downloading, check if we already have that source URL;
  after downloading, check the hash.
- Thumbnails made with `@napi-rs/canvas` (already a dependency).
- `wiresheet_image` row: `image_id, s3_key, thumb_key, source_url, width,
  height, content_hash, image_type ('photo' | 'diagram'), caption` (Wiresheet's
  own caption text only).
- Join table `wiresheet_entry_image (entry_id, image_id, ordinal)` links a
  photo to the circuit row(s) it illustrates.
- **No model-written description is stored or shown as fact** for these images.
  They are shown next to the answer so the tech can check visually (blueprint
  §7). If we later add a description as a search aid, it follows the `kb_image`
  rule: never cited, never shown.
- Served to the app through short-lived signed URLs, as today.

Rough size: if each vehicle has 1–3 photos at ~150 KB, and half are shared,
expect a few GB. Not a cost concern.

---

## 7. Database

Separate from `wiring_entry` on purpose. Wiresheet is a lower-trust source, and
`wiring_entry`'s unique key `(org_id, sheet_version, row_key, circuit)` can't
hold two 12V rows for one vehicle.

```sql
create table wiresheet_vehicle (
  vehicle_id   uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organization(org_id),
  vehicle_key  text not null,          -- stable id from Wiresheet's URL / doc id
  year int not null, make text not null, model_raw text not null, model text not null,
  variant      text,
  page_url     text not null,
  unique (org_id, vehicle_key)
);

create table wiresheet_entry (
  entry_id      uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organization(org_id),
  scrape_version int not null,
  vehicle_id    uuid not null references wiresheet_vehicle(vehicle_id),
  start_type    text check (start_type in ('pts','key')),
  circuit       text not null check (circuit in ('12v','ignition')),
  ordinal       int  not null default 1,      -- two 12V rows → 1 and 2
  cell_raw      text not null,
  wire_colour text, polarity text, location text, connector text, pin int, notes text,
  parse_confidence real,
  validation_notes jsonb not null default '{}',
  validation_state text not null default 'ok'
                    check (validation_state in ('ok','flagged','quarantined')),
  content_hash  text not null,
  scraped_at    timestamptz not null,
  is_live       boolean not null default false,
  unique (org_id, scrape_version, vehicle_id, start_type, circuit, ordinal)
);

create table wiresheet_image ( ... as §6 ... );
create table wiresheet_entry_image ( entry_id uuid, image_id uuid, ordinal int );

create table scrape_run  ( run_id, started_at, finished_at, pages_ok, pages_failed, stop_reason );
create table scrape_task ( run_id, vehicle_key, state, attempts, last_error, raw_s3_key, content_hash );
```

`lookup_wiresheet(org, make, model, year, circuit, start_type)` behaves like
`lookup_wiring`: **exact match or zero rows, never a nearby year** (INV-2).
Publishing uses the same atomic-swap pattern as `publish_wiring_version`.

The final migration goes in `BackEnd/db/migrations/` following the existing
numbering, and DATABASE.md gets a Wiresheet section.

---

## 8. Validation and reconciliation with the DRIG guide

### 8.1 Checks on scraped rows

| Rule | Check | Result |
|---|---|---|
| W1 | Row mentions airbag / SRS / "do not tap" | **quarantined**: never served (Todd Q9) |
| W2 | 12V and ignition text identical for one vehicle | flagged |
| W3 | Pin number greater than the stated connector pin count | quarantined (same as V1) |
| W4 | Colour not in the colour vocabulary | flagged |
| W5 | Parse confidence below threshold | flagged (`cell_raw` still shown) |
| W6 | Same vehicle + circuit + ordinal twice with different text | quarantined |

### 8.2 Coverage report (answers Q11)

For every year/make/model in either source:

| Bucket | Meaning | What happens |
|---|---|---|
| A. Both, agree | DRIG row and Wiresheet match (normalised colour + location) | Good. Agent uses DRIG. |
| B. Both, disagree | Values differ | Goes on Todd's review sheet. **Agent uses DRIG** and doesn't mention Wiresheet. Many of these will be DRIG-standard differences, like the Chevy Express. |
| C. Wiresheet only, DRIG row blank or missing | The ~6,500+ vehicles the guide doesn't cover (11,650 vs ~4,099 with data) | Agent can answer from Wiresheet, **labelled**. Also offered to Todd as draft fills for the guide. |
| D. DRIG only | EVs, semis, Todd's own guides | DRIG / Todd's guides only. |
| E. Neither | | QC handoff (Q8). |

The report is a spreadsheet with counts per make and a row list per bucket. It
answers Q11 with numbers instead of an estimate.

### 8.3 How the agent uses it

1. `lookup_wiring` (DRIG guide) first. A hit → answer from DRIG, as today.
2. No DRIG row → `lookup_wiresheet`. A hit → answer with:
   - the value verbatim, photos alongside, link to the Wiresheet page;
   - *"From Wiresheet. Wiresheet is written for remote-start installs and may
     differ from DRIG's GPS standard. If anything doesn't match, call QC."*
3. Several rows (PTS + Key, or two 12V rows) → ask which applies, naming the
   actual values (Q7).
4. Nothing in either → *"Not covered. Call QC."* Never a nearby year, never
   "cancel the install" (Q8).
5. Anything other than 12V or ignition → link to the Wiresheet page (Q6).

---

## 9. Side outputs

- **Directechs → Wiresheet link map (Q4).** For the ~1,385 rows that only link
  to Directechs, match year/make/model to a `wiresheet_vehicle.page_url`. Output
  a sheet: DRIG row, old link, new link, match confidence. Todd or someone not
  logged in tests a sample.
- **Draft fills for the blank guide rows (Q5).** Bucket C as a sheet in the
  guide's own column layout, marked "from Wiresheet, not reviewed". Todd decides
  what goes in.
- **Diff against the 2024 scrape (Q2).** What's new, changed or missing since
  October 2024. Shows whether the old scrape was complete.

---

## 10. Refresh

- Monthly: re-fetch the index (phase 2) to find new vehicles; re-fetch detail
  pages for new vehicles and a rolling ~10 % sample of existing ones; compare
  `content_hash`; re-parse only changes; new `scrape_version`; publish.
- Same pacing and stop rules as the first run.
- A make/model whose page changes goes back through reconciliation (§8.2).

---

## 11. Open questions (defaults we build to until answered)

| # | Question | Default until answered |
|---|---|---|
| Q11 | 11,650 Wiresheet documents vs ~4,099 vehicles with data in the guide. What about the rest? | Bucket C: answer from Wiresheet with the label + draft fills for Todd. Coverage report gives the real numbers. |
| Q12 | Confirm the new format for the scraped data. | Send Todd the phase-1 Acura review sheet (columns from §5) as the format to confirm. |
| Q13 | Two 12V rows: which one? | **Store both** (ordinal 1 and 2), show both with their locations, let the tech or QC pick. Never pick one silently. Ask Todd whether there's a DRIG preference (e.g. always the fused one). |
| — | Does Lesco's distributor agreement allow automated access? | Ask Lesco through Todd **before phase 3**. Phases 0–1 are small enough to look like normal use. |
| — | Wiresheet terms of service | Read in phase 0. If automated access is forbidden, stop and raise it. |
| — | Can we get a data export or API from Wiresheet instead? | Ask. If yes, it replaces phases 2–3 and removes the account risk. |

---

## 12. Done when

- [ ] Phase 0 site map written; ToS read; Lesco asked.
- [ ] Acura pilot reviewed and signed off by Todd (format = Q12 answer).
- [ ] ≥ 98 % of indexed vehicles fetched; every failure listed with a reason.
- [ ] Every stored value has `cell_raw`, `page_url` and `scraped_at`.
- [ ] Zero airbag/SRS rows served (W1 test).
- [ ] `lookup_wiresheet` returns zero rows for a year that isn't there (no nearby year).
- [ ] Agent tests: DRIG hit, Wiresheet-only hit with label, PTS/Key question, two-12V question, not-covered → QC.
- [ ] Coverage report, Directechs link map and draft-fill sheet sent to Todd.
- [ ] No stop rule triggered during the full run, or each one investigated and cleared.
