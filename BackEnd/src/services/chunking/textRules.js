/**
 * Recognition rules shared by every document parser (PDF and Word), so a
 * "WARNING" box is a warning box whichever format it arrived in. The chunker
 * depends on this: it attaches callouts to the procedure they belong to.
 */

const CALLOUT_RE = /^(WARNING|CAUTION|DANGER|NOTICE|IMPORTANT|ATTENTION|NOTE)\b\s*[!:.\-–—]*\s*/;
const CALLOUT_TITLECASE_RE = /^(Warning|Caution|Danger|Notice|Important|Attention|Note)\s*[!:]\s*/;

/**
 * @returns {{ kind: string, rest: string } | null} `kind` is lowercase
 *   ("warning", "note", ...); `rest` is the text after the keyword.
 */
export const matchCallout = (text) => {
  const match = text.match(CALLOUT_RE) || text.match(CALLOUT_TITLECASE_RE);
  return match ? { kind: match[1].toLowerCase(), rest: text.slice(match[0].length) } : null;
};

/**
 * Every vision-written description of a figure, diagram or table image carries
 * this marker in its stored text. It is how the answer model (see the grounding
 * prompt in answerGeneration.service.js) tells "a model's description of a
 * picture" apart from "what the manual says".
 */
export const FIGURE_MARKER = "[FIGURE — machine-generated description, unverified]";
