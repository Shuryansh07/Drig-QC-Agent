import type { AnswerStep, Citation } from "@/types/contracts";

/**
 * Turns an answer into steps when it is a step-by-step procedure.
 *
 * The server asks the model to write any procedure (installing, wiring, removing,
 * testing, troubleshooting) as plain numbered lines, "1. ...", one per line, with a
 * short sentence before and, if needed, after. Here those lines become steps the
 * page shows with number badges and a "Safety step" style for warnings.
 *
 * The model ends every step with its source, "(Page 7)" (the verification step needs
 * them in the text). The list does not show them between the steps: they are taken
 * out of the step text and the sources are shown once, under the whole list.
 * An answer that is not a procedure stays one block of text.
 */

const NUMBERED = /^\s*(\d{1,2})[.)]\s+(\S.*)$/;
// A step that is a precaution: "Warning: disconnect the battery first".
const SAFETY = /^(warning|caution|danger|safety)\b/i;
// "(Page 7)", "(Pages 7, 8)", "(Page 7-9)", "(Section: Power connection)"
const SOURCE_REF = /\s*\(\s*(?:pages?\s+[\d,\s&\u2013-]+|section:\s*[^)]+)\)/gi;

/** The step as the technician reads it, without the "(Page N)" markers. */
export function withoutSourceRefs(text: string): string {
  return text
    .replace(SOURCE_REF, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

interface Procedure {
  intro: string;
  steps: string[];
  outro: string;
}

/** Splits an answer into intro, numbered steps and closing note. Null when it is not a clean procedure. */
export function parseProcedure(text: string): Procedure | null {
  const intro: string[] = [];
  const steps: string[] = [];
  const outro: string[] = [];
  let phase: "intro" | "steps" | "outro" = "intro";
  let blankSinceStep = false;
  let firstNumber: number | null = null;

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const numbered = NUMBERED.exec(line);

    if (numbered) {
      // A numbered line after the list has ended is not a clean list: show the answer as written.
      if (phase === "outro") return null;
      if (firstNumber === null) firstNumber = parseInt(numbered[1], 10);
      phase = "steps";
      blankSinceStep = false;
      steps.push(numbered[2].trim());
      continue;
    }

    const trimmed = line.trim();
    if (phase === "intro") {
      intro.push(trimmed);
    } else if (phase === "steps") {
      if (trimmed === "") {
        blankSinceStep = true;
      } else if (!blankSinceStep) {
        // A step that wrapped onto the next line.
        steps[steps.length - 1] += ` ${trimmed}`;
      } else {
        phase = "outro";
        outro.push(trimmed);
      }
    } else {
      outro.push(trimmed);
    }
  }

  // One numbered line is just a sentence; a list that does not start at 1 is something else.
  if (steps.length < 2 || firstNumber !== 1) return null;

  const tidy = (lines: string[]) => lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { intro: tidy(intro), steps, outro: tidy(outro) };
}

/**
 * The steps to show for an answer.
 * A procedure becomes: an optional intro note, one numbered step per line (no source
 * markers, no source chips between them), and a closing note carrying every source
 * once, with the closing line if the model wrote one. Anything else is a single block
 * carrying every source, as before.
 */
export function buildAnswerSteps(text: string, citations: Citation[]): AnswerStep[] {
  const everyId = citations.map((c) => c.chunkId);
  const procedure = parseProcedure(text);
  if (!procedure) return [{ n: 1, text, sourceChunkIds: everyId }];

  const out: AnswerStep[] = [];

  if (procedure.intro) out.push({ n: 0, kind: "note", text: withoutSourceRefs(procedure.intro), sourceChunkIds: [] });

  procedure.steps.forEach((step, index) => {
    out.push({ n: index + 1, text: withoutSourceRefs(step), sourceChunkIds: [], isSafetyStep: SAFETY.test(step) });
  });

  const closing = withoutSourceRefs(procedure.outro);
  if (closing || everyId.length > 0) out.push({ n: 0, kind: "note", text: closing, sourceChunkIds: everyId });
  return out;
}
