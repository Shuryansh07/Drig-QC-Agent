import { pool } from "./pool.js";
import { toVectorLiteral } from "./vector.js";

// Rule P5 (Plan/DATABASE.md): every vector query goes through a SQL function.
// Application code never writes `<=>` or queries an embedding column
// directly — these wrappers are the only place retrieval touches the DB.

export interface MatchedChunk {
  chunkId: string;
  docId: string;
  parentChunkId: string | null;
  denseRank: number | null;
  lexicalRank: number | null;
  denseSimilarity: number;
  score: number;
}

export interface MatchChunksParams {
  orgId: string;
  queryEmbedding: number[];
  queryText: string;
  matchCount?: number;
  boostVendor?: string | null;
  boostModel?: string | null;
  boostLanguage?: string | null;
  sourceTypes?: string[] | null;
}

export const matchChunks = async ({
  orgId,
  queryEmbedding,
  queryText,
  matchCount = 8,
  boostVendor = null,
  boostModel = null,
  boostLanguage = null,
  sourceTypes = null,
}: MatchChunksParams): Promise<MatchedChunk[]> => {
  const { rows } = await pool.query(
    `select * from match_chunks(
       p_org_id          => $1,
       p_query_embedding => $2::extensions.vector,
       p_query_text      => $3,
       p_match_count     => $4,
       p_boost_vendor    => $5,
       p_boost_model     => $6,
       p_boost_language  => $7,
       p_source_types    => $8)`,
    [orgId, toVectorLiteral(queryEmbedding), queryText, matchCount, boostVendor, boostModel, boostLanguage, sourceTypes]
  );

  return rows.map((r) => ({
    chunkId: r.chunk_id,
    docId: r.doc_id,
    parentChunkId: r.parent_chunk_id,
    denseRank: r.dense_rank,
    lexicalRank: r.lexical_rank,
    denseSimilarity: r.dense_similarity,
    score: r.score,
  }));
};

export interface MatchedCallCard {
  cardId: string;
  symptom: string;
  rootCause: string | null;
  resolution: unknown;
  confidence: "confirmed" | "probable" | "unverified";
  contextJson: unknown;
  similarity: number;
}

export const matchCallCards = async (
  orgId: string,
  symptomEmbedding: number[],
  matchCount = 5
): Promise<MatchedCallCard[]> => {
  const { rows } = await pool.query(
    `select * from match_call_cards(
       p_org_id            => $1,
       p_symptom_embedding => $2::extensions.vector,
       p_match_count       => $3)`,
    [orgId, toVectorLiteral(symptomEmbedding), matchCount]
  );

  return rows.map((r) => ({
    cardId: r.card_id,
    symptom: r.symptom,
    rootCause: r.root_cause,
    resolution: r.resolution,
    confidence: r.confidence,
    contextJson: r.context_json,
    similarity: r.similarity,
  }));
};

export interface WiringLookupResult {
  entryId: string;
  year: number;
  make: string;
  modelRaw: string;
  startType: string | null;
  circuit: "12v" | "ignition";
  cellKind: "inline" | "doc_ref";
  cellRaw: string | null;
  wireColour: string | null;
  pin: number | null;
  connectorPins: number | null;
  docRefLabel: string | null;
  docRefUrl: string | null;
  docId: string | null;
  requiresLogin: boolean;
  validationState: "ok" | "flagged" | "quarantined";
  validationNotes: Record<string, string>;
  sourceRow: number | null;
  sheetVersion: number;
}

// INV-2: exact match or zero rows. Never a nearest-year fallback.
export const lookupWiring = async (
  orgId: string,
  make: string,
  model: string,
  year: number,
  circuit: "12v" | "ignition" | null = null,
  startType: "pts" | "key" | null = null
): Promise<WiringLookupResult[]> => {
  const { rows } = await pool.query(
    `select * from lookup_wiring($1, $2, $3, $4, $5, $6)`,
    [orgId, make, model, year, circuit, startType]
  );

  return rows.map((r) => ({
    entryId: r.entry_id,
    year: r.year,
    make: r.make,
    modelRaw: r.model_raw,
    startType: r.start_type,
    circuit: r.circuit,
    cellKind: r.cell_kind,
    cellRaw: r.cell_raw,
    wireColour: r.wire_colour,
    pin: r.pin,
    connectorPins: r.connector_pins,
    docRefLabel: r.doc_ref_label,
    docRefUrl: r.doc_ref_url,
    docId: r.doc_id,
    requiresLogin: r.requires_login,
    validationState: r.validation_state,
    validationNotes: r.validation_notes,
    sourceRow: r.source_row,
    sheetVersion: r.sheet_version,
  }));
};

export interface ChunkImage {
  imageId: string;
  chunkId: string;
  docId: string;
  page: number | null;
  s3Key: string;
  thumbKey: string | null;
  caption: string | null;
  imageType: string;
  isCitable: boolean;
}

// Deliberately never selects `description` — that text is model-generated
// and must never reach the generator as if it were fact (§6, images_for_chunks).
export const imagesForChunks = async (chunkIds: string[]): Promise<ChunkImage[]> => {
  if (chunkIds.length === 0) return [];

  const { rows } = await pool.query(`select * from images_for_chunks($1)`, [chunkIds]);

  return rows.map((r) => ({
    imageId: r.image_id,
    chunkId: r.chunk_id,
    docId: r.doc_id,
    page: r.page,
    s3Key: r.s3_key,
    thumbKey: r.thumb_key,
    caption: r.caption,
    imageType: r.image_type,
    isCitable: r.is_citable,
  }));
};
