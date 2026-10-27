import { pool } from "./pool.js";
import { getDefaultOrg } from "./org.js";

// Read side of the Wiresheet tables (migration 0810) for the admin Excel export.
// The scraper writes these rows; here we only read them, shaped the way the
// tracker builder expects (one record per vehicle, its wires nested), matching
// what the scraper's own writeReport() used to read from vehicles.jsonl.

export interface WiresheetWire {
  function: string | null;
  color: string | null;
  polarity: string | null;
  location: string | null;
  notes: string | null;
  imageS3Key: string | null;
  imageThumbKey: string | null;
  imageContentHash: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
}

export interface WiresheetRecord {
  make: string;
  year: string;
  model: string;
  keyType: string | null;
  status: string;
  wires: WiresheetWire[];
}

interface Row {
  make: string;
  year: string;
  model: string;
  recnum: string | null;
  key_type: string | null;
  status: string;
  function_name: string | null;
  wire_colour: string | null;
  polarity: string | null;
  location: string | null;
  notes: string | null;
  s3_key: string | null;
  thumb_key: string | null;
  content_hash: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Every scraped vehicle (optionally just one make), with its 12V/ignition wires
 * and each wire's photo keys. One row per vehicle in the result; the SQL returns
 * one row per wire and we fold them together in insertion order (ordinal).
 */
export const loadWiresheetReport = async (make?: string): Promise<WiresheetRecord[]> => {
  const { orgId } = await getDefaultOrg();
  const params: unknown[] = [orgId];
  let makeClause = "";
  if (make) {
    params.push(make);
    makeClause = ` and lower(v.make) = lower($${params.length})`;
  }

  const { rows } = await pool.query<Row>(
    `select v.make, v.year, v.model, v.recnum, v.key_type, v.status,
            e.function_name, e.wire_colour, e.polarity, e.location, e.notes,
            i.s3_key, i.thumb_key, i.content_hash, i.width, i.height
       from wiresheet_vehicle v
       left join wiresheet_entry e on e.vehicle_id = v.vehicle_id
       left join wiresheet_image i on i.image_id = e.image_id
      where v.org_id = $1${makeClause}
      order by v.make, v.year, v.model, v.recnum, e.ordinal`,
    params
  );

  const byVehicle = new Map<string, WiresheetRecord>();
  for (const r of rows) {
    const key = `${r.make}|${r.year}|${r.model}|${r.recnum ?? r.status}`;
    let rec = byVehicle.get(key);
    if (!rec) {
      rec = { make: r.make, year: r.year, model: r.model, keyType: r.key_type, status: r.status, wires: [] };
      byVehicle.set(key, rec);
    }
    if (r.function_name) {
      rec.wires.push({
        function: r.function_name,
        color: r.wire_colour,
        polarity: r.polarity,
        location: r.location,
        notes: r.notes,
        imageS3Key: r.s3_key,
        imageThumbKey: r.thumb_key,
        imageContentHash: r.content_hash,
        imageWidth: r.width,
        imageHeight: r.height,
      });
    }
  }
  return [...byVehicle.values()];
};

/** Distinct makes present, for a picker / to show counts in the admin UI. */
export const listWiresheetMakes = async (): Promise<{ make: string; vehicles: number }[]> => {
  const { orgId } = await getDefaultOrg();
  const { rows } = await pool.query<{ make: string; vehicles: string }>(
    `select make, count(*)::int as vehicles from wiresheet_vehicle where org_id = $1 group by make order by make`,
    [orgId]
  );
  return rows.map((r) => ({ make: r.make, vehicles: Number(r.vehicles) }));
};
