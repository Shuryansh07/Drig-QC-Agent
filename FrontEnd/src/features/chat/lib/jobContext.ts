/**
 * A chat opened from the jobsheet (JobsheetClient) carries its job in the address:
 * /?job=JS-1043&car=2021%20Ram%20ProMaster%201500&equipment=AD%20Plus2.0
 * The address is the only place it lives, so a reload keeps it and "New chat" (plain /) drops it.
 */
export interface JobContext {
  id: string | null;
  car: string | null;
  equipment: string | null;
}

const MAX_LENGTH = 120;

const field = (params: URLSearchParams, name: string): string | null => {
  const value = params.get(name)?.trim();
  return value ? value.slice(0, MAX_LENGTH) : null;
};

/** The job in these search params, or null when the chat was not opened from a job. */
export const jobFromSearch = (search: string | URLSearchParams): JobContext | null => {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const job = { id: field(params, "job"), car: field(params, "car"), equipment: field(params, "equipment") };
  return job.id || job.car || job.equipment ? job : null;
};

/** What the server's GET /api/rag/job-context returns. */
export interface JobContextResponse {
  car: string | null;
  equipment: string | null;
  manuals: { document_id: string; title: string }[];
}

/** Suggestions for an empty chat about this job, instead of the generic ones. */
export const jobSuggestions = (job: JobContext): string[] => {
  const equipment = job.equipment ?? "the unit";
  return [
    `How do I install the ${equipment}?`,
    job.car ? `Which wire is the ignition wire on the ${job.car}?` : "Which wire is the ignition wire?",
    `The ${equipment} won't power on after install`,
  ];
};
