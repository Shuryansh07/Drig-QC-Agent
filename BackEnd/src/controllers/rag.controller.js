import { retrieveRelevantChunks } from "../services/ragRetrieval.service.js";
import {
  generateAnswer,
  streamAnswer,
  sourcesFromChunks,
  loadEvidenceImages,
  imagesCitedBy,
  INSUFFICIENT_EVIDENCE_ANSWER,
} from "../services/answerGeneration.service.js";
import { verifyAnswer } from "../services/answerVerification.service.js";
import * as storage from "../services/storage.service.js";
import { recordGap } from "../db/gaps.js";
import { decideClarification, withClarification } from "../services/clarification.service.js";
import { sanitizeHistory, contextualizeQuestion } from "../services/conversationContext.service.js";
import { findFaq, mergeFaqChunks, resolveAdminAnswer } from "../services/faq.service.js";
import { saveTurn, isUuid } from "../db/chat.js";
import { markFaqUsed } from "../db/faq.js";
import { getDeadlineMs, getContextMaxTurns, getClarifyEnabled, getClarifySimilarityGap, getClarifyMinOptions, getClarifyMaxOptions } from "../db/settings.js";
import { logger } from "../utils/logger.js";
import { generateEmbedding } from "../services/embedding.service.js";
import { detectWiringIntent, missingVehicleFields, withJobVehicle } from "../services/wiring/wiringIntent.service.js";
import { manualsForEquipment } from "../services/equipmentFilter.service.js";
import { lookupVehicleWiring, composeWiringAnswer } from "../services/wiring/wiringLookup.service.js";
import { vehicleClarify } from "../services/wiring/wiringChat.service.js";
import { describeVehicle } from "../services/wiring/vehicleNames.js";

const HEARTBEAT_MS = 10_000;
const FALLBACK_DEADLINE_MS = 22_000;

/**
 * The evidence images the answer was (or wasn't) grounded on, as time-limited
 * URLs a browser can load directly — the only shape the technician ever sees;
 * the base64 vision parts generation/verification used are internal to those
 * calls and never leave the server.
 */
const imagesForResponse = (images) =>
  Promise.all(
    images.map(async (img) => ({
      label: img.label,
      document_id: img.docId,
      page: img.page,
      url: await storage.getPresignedUrl(img.s3Key),
    }))
  );

/**
 * A refused question is not just an empty answer: it is recorded so
 * management can see what technicians keep asking that nothing documents
 * (Blueprint scenario D), and the technician is told what IS covered.
 * Neither step may break the refusal itself, so both are best-effort.
 */
const refuse = async ({ question, retrieval }) => {
  const { admission, embedding, candidateIds } = retrieval;
  logger.info(`[rag] refused (${admission.reason}, top similarity ${admission.topSimilarity.toFixed(3)}): "${question}"`);

  await recordGap({ queryText: question, queryEmbedding: embedding, retrievedIds: candidateIds, reason: "not_covered" }).catch((err) =>
    logger.error("[rag] failed to record knowledge gap", err)
  );

  return {
    // The client no longer shows what is covered, so the list of every manual is not sent at all.
    coveredTopics: [],
    message: "I don't have documented guidance for that. I can hand this to an engineer with everything you've told me.",
  };
};

/**
 * A vehicle wiring question, end to end, on the stream. Asks for whatever part of
 * the vehicle is missing; otherwise looks it up (DRIG guide first, Wiresheet only
 * for a circuit DRIG has nothing for) and sends the composed answer. No language
 * model writes the answer, so there is nothing for Checks 5-7 to verify.
 */
const answerWiring = async ({ intent, question, send, persist, agentTurnId, requestStart, isClosed }) => {
  const missing = missingVehicleFields(intent);
  if (missing.length > 0) {
    const clarify = vehicleClarify(intent, missing);
    logger.info(`[rag stream] wiring question, asking for ${missing.join(", ")}`);
    await persist(agentTurnId, { role: "agent", text: clarify.question, gateOutcome: "clarify", turnJson: { clarify } });
    send({ type: "clarify", clarify });
    return;
  }

  const vehicle = { year: intent.year, make: intent.make, model: intent.model, startType: intent.startType, circuits: intent.circuits };
  const lookup = await lookupVehicleWiring(vehicle);
  if (isClosed()) return;
  logger.info(
    `[rag stream] wiring lookup ${describeVehicle(vehicle)}: ` + lookup.results.map((r) => `${r.circuit}=${r.source ?? "none"}`).join(", ")
  );

  if (!lookup.anyFound) {
    const notCovered = {
      coveredTopics: [],
      message: `I don't have the ${intent.circuits.map((c) => (c === "12v" ? "12V" : "ignition")).join(" or ")} wiring for the ${describeVehicle(vehicle)} in the DRIG wiring guide or Wiresheet. Call QC before tapping anything — they can check the vehicle's schematics.`,
    };
    // Best effort, like refuse(): the gap list is how missing vehicles reach the guide's owner.
    generateEmbedding(question)
      .then((embedding) => recordGap({ queryText: question, queryEmbedding: embedding, retrievedIds: [], reason: "not_covered" }))
      .catch((err) => logger.error("[rag] failed to record wiring gap", err));
    await persist(agentTurnId, { role: "agent", text: notCovered.message, gateOutcome: "not_covered", turnJson: { notCovered, wiring: { vehicle }, standalone_question: question } });
    send({ type: "not_covered", notCovered });
    return;
  }

  const { answer, images } = await composeWiringAnswer(lookup);
  if (isClosed()) return;
  send({ type: "sources", sources: [] });
  if (images.length > 0) send({ type: "images", images: images.map(({ stored, ...wire }) => wire) });
  send({ type: "delta", text: answer });

  const durationMs = Date.now() - requestStart;
  send({ type: "complete", answer, durationMs, verified: true });
  await persist(agentTurnId, {
    role: "agent",
    text: answer,
    gateOutcome: "answered",
    turnJson: {
      sources: [],
      images: images.map((i) => i.stored),
      verified: true,
      durationMs,
      standalone_question: question,
      // No chunk ids: a wiring answer is a lookup, and is deliberately never copied into the FAQ.
      source_chunk_ids: [],
      wiring: { vehicle, sources: Object.fromEntries(lookup.results.map((r) => [r.circuit, r.source])) },
    },
  });
  logger.info(`[rag stream] TOTAL request time: ${durationMs}ms (wiring)`);
};

export const queryRag = async (req, res) => {
  const requestStart = Date.now();
  try {
    const { question } = req.body || {};

    if (!question || typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ success: false, message: "question is required" });
    }

    logger.info(`[rag query] received: "${question}"`);

    const retrieval = await retrieveRelevantChunks({ question });
    logger.info(`[rag query] retrieved ${retrieval.chunks.length} chunk(s) (gate: ${retrieval.admission.reason})`);

    if (!retrieval.admission.admitted) {
      await refuse({ question, retrieval });
      return res.status(200).json({ answer: INSUFFICIENT_EVIDENCE_ANSWER, sources: [] });
    }

    // Resolved once, right after retrieval — the same set grounds generation,
    // verification, and (if the answer survives) what the technician is shown.
    const images = await loadEvidenceImages(retrieval.chunks);

    const { answer, sources } = await generateAnswer({ question, chunks: retrieval.chunks, images });

    // Blueprint Checks 5-7: a written answer is not yet a safe one. Runs after
    // generation, before the response leaves the server — nothing unverified here
    // is ever sent, since this path has no partial state already shown to anyone.
    // Blueprint Checks 5-7 run either way, but a failure no longer withholds the
    // answer — it flags it. The technician decides whether to trust it, not the gate.
    let verified = true;
    if (answer !== INSUFFICIENT_EVIDENCE_ANSWER) {
      const verification = await verifyAnswer({ question, answer, chunks: retrieval.chunks, images });
      if (!verification.passed) {
        logger.warn(`[rag query] answer unverified, returned with a caution flag: "${question}"`);
        verified = false;
      }
    }

    logger.info(`[rag query] TOTAL request time: ${Date.now() - requestStart}ms`);

    return res.status(200).json({ answer, sources, images: await imagesForResponse(imagesCitedBy(answer, images)), verified });
  } catch (error) {
    logger.error("RAG query error", error);
    return res.status(500).json({
      success: false,
      message: "Failed to answer question",
      error: error.message,
    });
  }
};

/**
 * POST /api/rag/query/stream — Server-Sent Events. One JSON object per
 * `data:` line, in this order:
 *
 *   {type:"stage", stage:"retrieving"}                      immediately
 *   {type:"not_covered", notCovered:{...}}                  gate refused -> stream ends, no LLM call
 *   {type:"clarify", clarify:{slot, question, options, allowSkip}}  several guides match equally and the
 *                                                            question does not say which -> stream ends, no
 *                                                            LLM call; the client re-asks with `clarification`
 *   {type:"sources", sources:[{document_id, page_number}]}  as soon as retrieval finishes
 *   {type:"stage", stage:"generating"}
 *   {type:"delta", text}                                    repeated, as the model writes
 *   {type:"deadline_warning", elapsedMs}                    only if gate.deadline_ms passes first
 *   {type:"images", images:[{label, url, page, document_id}]}  after the answer, only the evidence
 *                                                            diagrams/photos it cites — url is a
 *                                                            time-limited S3 link
 *   {type:"complete", answer, durationMs, verified}         the whole answer, then the stream ends —
 *                                                            verified is false when Checks 5-7 flagged
 *                                                            a possible issue; the answer is still the
 *                                                            real text, not withheld, and the client
 *                                                            renders a caution banner under it
 *   {type:"error", code, message}                           anything that went wrong after headers —
 *                                                            a dropped upstream call or a stream failure,
 *                                                            never a verification outcome (see "complete")
 *
 * The first byte goes out before retrieval starts, so a slow embedding or
 * database call shows up as "searching…" on the client instead of a blank wait.
 * Lines starting with ":" are heartbeats that keep proxies from closing an idle
 * connection.
 */
const JOB_FIELD_MAX = 120;
const jobField = (value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, JOB_FIELD_MAX) : null);

/**
 * The jobsheet a chat was opened from: { id, car, equipment }, every field optional. Its equipment narrows the
 * manuals searched (when the question names none) and its car fills a wiring question's vehicle.
 */
const jobContext = (job) => {
  if (!job || typeof job !== "object") return null;
  const context = { id: jobField(job.id), car: jobField(job.car), equipment: jobField(job.equipment) };
  return context.id || context.car || context.equipment ? context : null;
};

/**
 * GET /api/rag/job-context?equipment=&car= — what the chat will use for a job before anything is asked:
 * the manuals the job's equipment points at. The chat shows them, so the technician sees it knows the job.
 */
export const getJobContext = async (req, res) => {
  const job = jobContext({ car: req.query.car, equipment: req.query.equipment });
  try {
    const manuals = job?.equipment ? await manualsForEquipment([job.equipment]) : [];
    return res.status(200).json({
      car: job?.car ?? null,
      equipment: job?.equipment ?? null,
      manuals: manuals.map((m) => ({ document_id: m.docId, title: m.title })),
    });
  } catch (error) {
    logger.error("[rag] could not resolve the job's manuals", error);
    return res.status(500).json({ success: false, message: "Could not look up the manuals for this job" });
  }
};

export const streamRagQuery = async (req, res) => {
  const requestStart = Date.now();
  const { question: askedQuestion, clarification, history: rawHistory } = req.body || {};
  const job = jobContext(req.body?.job);

  // Before headers: a bad request is still an ordinary JSON 400.
  if (!askedQuestion || typeof askedQuestion !== "string" || !askedQuestion.trim()) {
    return res.status(400).json({ success: false, message: "question is required" });
  }
  // After the technician answered a clarification, retrieval and the answer use
  // the original question plus their pick. Asked once per question: a request
  // that carries a clarification (even a skipped one) is never asked again.
  const clarifiedQuestion = withClarification(askedQuestion, clarification);
  const alreadyClarified = Boolean(clarification);

  // Chat history lives in the database, not the browser: every turn is saved here as it happens, under
  // the ids the client chose (so a later "resolved" can name the answer). A request without a valid
  // session id still works; it just isn't saved.
  const { session_id, turn_id, agent_turn_id, display_text } = req.body || {};
  const sessionId = isUuid(session_id) ? session_id : null;
  const persist = (turnId, turn) =>
    sessionId && isUuid(turnId)
      ? saveTurn({ sessionId, turnId, ...turn }).catch((err) => logger.error("[chat] could not save turn", err))
      : Promise.resolve();

  const deadlineMs = await getDeadlineMs().catch(() => FALLBACK_DEADLINE_MS);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // tell nginx-style proxies not to buffer the stream
  });
  res.flushHeaders();

  let closed = false;
  const abort = new AbortController();
  const send = (event) => {
    if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  const deadline = setTimeout(() => send({ type: "deadline_warning", elapsedMs: Date.now() - requestStart }), deadlineMs);

  // Client went away (tab closed, Stop pressed): stop paying for the answer.
  res.on("close", () => {
    closed = true;
    abort.abort();
    clearInterval(heartbeat);
    clearTimeout(deadline);
  });

  try {
    logger.info(`[rag stream] received: "${clarifiedQuestion}"`);
    send({ type: "stage", stage: "retrieving" });
    await persist(turn_id, {
      role: "technician",
      text: (typeof display_text === "string" && display_text.trim()) || askedQuestion.trim(),
      turnJson: job ? { job } : {},
    });
    if (job) logger.info(`[rag stream] job context: ${[job.id, job.car, job.equipment].filter(Boolean).join(" · ")}`);

    // Conversation context: the last few turns, so a follow-up ("and the wiring?") is searched and
    // answered as the question it really is. A question that stands alone is used as it is.
    const history = sanitizeHistory(rawHistory, await getContextMaxTurns().catch(() => 6));
    const question = await contextualizeQuestion({ question: clarifiedQuestion, history });
    if (closed) return;

    // Vehicle wiring (12V / ignition) is a lookup in the DRIG wiring guide, then Wiresheet, by exact
    // vehicle — not a document search. It needs the year, make, model and start type, so it asks first.
    // From a jobsheet, the job's car fills whatever part of the vehicle the question leaves out.
    const wiringIntent = withJobVehicle(await detectWiringIntent(question), job?.car);
    if (closed) return;
    if (wiringIntent) {
      await answerWiring({ intent: wiringIntent, question, send, persist, agentTurnId: agent_turn_id, requestStart, isClosed: () => closed });
      return;
    }

    const retrieval = await retrieveRelevantChunks({ question, jobEquipment: job?.equipment ? [job.equipment] : [] });
    if (closed) return;

    // The FAQ of resolved questions, searched with the same question embedding. A close match brings back the
    // passages that answered it (they join the evidence) and its answer (a reference for the model).
    const faq = await findFaq({ embedding: retrieval.embedding });
    const chunks = faq.chunks.length > 0 ? mergeFaqChunks(retrieval.chunks, faq.chunks) : retrieval.chunks;
    let admission = retrieval.admission;
    // Retrieval alone refused, but a near-identical question was resolved before: its passages are enough.
    if (!admission.admitted && faq.strong && chunks.length > 0) {
      admission = { admitted: true, reason: "faq", topSimilarity: faq.best.similarity };
    }
    if (faq.matches.length > 0) {
      logger.info(`[rag stream] FAQ: ${faq.matches.length} similar resolved question(s), best ${faq.best.similarity.toFixed(3)} ("${faq.best.question}"), ${faq.chunks.length} passage(s)`);
    }

    // An admin wrote the answer to this question (Unanswered questions tab): it is the reply, as written.
    // No answer generation and no verification — there are no passages to check it against, and an admin
    // vouched for it. A looser match costs one small model call deciding it is the same question.
    const adminMatch = await resolveAdminAnswer({ question, faq });
    if (closed) return;
    if (adminMatch) {
      const adminAnswer = adminMatch.entry;
      logger.info(
        `[rag stream] answered from an admin-written FAQ entry (similarity ${adminAnswer.similarity.toFixed(3)}, matched by ${adminMatch.how}: "${adminAnswer.question}")`
      );
      send({ type: "stage", stage: "generating" });
      send({ type: "delta", text: adminAnswer.answer });
      const durationMs = Date.now() - requestStart;
      send({ type: "complete", answer: adminAnswer.answer, durationMs, verified: true });
      await persist(agent_turn_id, {
        role: "agent",
        text: adminAnswer.answer,
        gateOutcome: "answered",
        turnJson: { faqId: adminAnswer.faqId, fromAdmin: true, verified: true, durationMs, standalone_question: question },
      });
      markFaqUsed([adminAnswer.faqId]).catch(() => {});
      return;
    }

    if (!admission.admitted) {
      const notCovered = await refuse({ question, retrieval });
      await persist(agent_turn_id, { role: "agent", text: notCovered.message, gateOutcome: "not_covered", turnJson: { notCovered, standalone_question: question } });
      send({ type: "not_covered", notCovered });
      return;
    }

    logger.info(`[rag stream] ${chunks.length} chunk(s) admitted (${admission.reason}) after ${Date.now() - requestStart}ms`);

    // Blueprint Check 1: the evidence is good enough, but if several different guides match about
    // equally well and the question does not say which, ask before answering. No LLM call is made.
    if (!alreadyClarified && !faq.strong && (await getClarifyEnabled().catch(() => true))) {
      const [gap, minOptions, maxOptions] = await Promise.all([getClarifySimilarityGap(), getClarifyMinOptions(), getClarifyMaxOptions()]);
      const clarify = decideClarification({ question, chunks, admission, gap, minOptions, maxOptions });
      if (clarify) {
        logger.info(`[rag stream] asking for clarification (${clarify.options.length} option(s): ${clarify.options.map((o) => o.value).join(" | ")})`);
        await persist(agent_turn_id, { role: "agent", text: clarify.question, gateOutcome: "clarify", turnJson: { clarify } });
        send({ type: "clarify", clarify });
        return;
      }
    }

    send({ type: "sources", sources: sourcesFromChunks(chunks) });

    // Resolved once, right after retrieval — the same set grounds generation and
    // verification. What the technician is shown is decided after the answer is
    // written: only the pictures it cites (imagesCitedBy, below).
    const images = await loadEvidenceImages(chunks);
    if (closed) return;

    send({ type: "stage", stage: "generating" });

    let answer = "";
    let firstTokenLogged = false;
    for await (const delta of streamAnswer({ question, chunks, images, history, faq: faq.best, signal: abort.signal })) {
      if (!firstTokenLogged) {
        firstTokenLogged = true;
        logger.info(`[rag stream] first token after ${Date.now() - requestStart}ms`);
      }
      answer += delta;
      send({ type: "delta", text: delta });
    }
    if (closed) return;

    const finalAnswer = answer.trim() || INSUFFICIENT_EVIDENCE_ANSWER;

    // Blueprint Checks 5-7, run on the complete text. The technician has already
    // watched this stream in live, so a failure here no longer RETRACTS it — it
    // flags it. Vanishing text someone already read is its own kind of untrustworthy;
    // the client shows the same answer with a caution banner instead.
    // A bare refusal has nothing to check, and skips straight to "complete".
    let verified = true;
    if (finalAnswer !== INSUFFICIENT_EVIDENCE_ANSWER) {
      const verification = await verifyAnswer({ question, answer: finalAnswer, chunks: chunks, images });
      if (closed) return;
      if (!verification.passed) {
        logger.warn(`[rag stream] answer unverified, shown with a caution banner: "${question}"`);
        verified = false;
      }
    }

    const shownImages = imagesCitedBy(finalAnswer, images);
    if (images.length > shownImages.length) {
      logger.info(`[rag stream] showing ${shownImages.length} of ${images.length} evidence image(s): the answer cites only those pages`);
    }
    if (shownImages.length > 0) send({ type: "images", images: await imagesForResponse(shownImages) });
    if (closed) return;

    const durationMs = Date.now() - requestStart;
    send({ type: "complete", answer: finalAnswer, durationMs, verified });
    if (finalAnswer !== INSUFFICIENT_EVIDENCE_ANSWER) {
      // What the FAQ needs if this answer is later marked resolved: the standalone question (follow-ups
      // already rewritten) and the passages that grounded it.
      await persist(agent_turn_id, {
        role: "agent",
        text: finalAnswer,
        gateOutcome: "answered",
        turnJson: {
          sources: sourcesFromChunks(chunks),
          images: shownImages.map((i) => ({ label: i.label, docId: i.docId, page: i.page, s3Key: i.s3Key })),
          verified,
          durationMs,
          standalone_question: question,
          source_chunk_ids: chunks.map((c) => c.chunkId),
        },
      });
      markFaqUsed(faq.matches.map((m) => m.faqId)).catch(() => {});
    } else {
      // The passages were admitted but the model found no answer in them. Saved so the admin's
      // unanswered-questions list shows it; no source_chunk_ids, so it can never become an FAQ.
      await persist(agent_turn_id, {
        role: "agent",
        text: finalAnswer,
        gateOutcome: "answered",
        turnJson: { noAnswer: true, verified, durationMs, standalone_question: question, sources: sourcesFromChunks(chunks) },
      });
    }
    logger.info(`[rag stream] TOTAL request time: ${Date.now() - requestStart}ms`);
  } catch (error) {
    if (closed) return; // the client left; nothing to tell them
    logger.error("RAG stream error", error);
    send({ type: "error", code: error.status ? `upstream_${error.status}` : "stream_failed", message: "The answer could not be completed." });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
    if (!closed) res.end();
  }
};
