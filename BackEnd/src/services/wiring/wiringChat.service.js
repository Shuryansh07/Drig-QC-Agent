import { describeVehicle } from "./vehicleNames.js";

// The chat side of a vehicle wiring lookup: what to ask when the vehicle is
// not fully known. Year, make, model AND start type are all required (Todd
// Q7: push-to-start and keyed are wired differently, and the VIN can't tell),
// so the lookup is always exact.

const FIELD_WORDS = { year: "year", make: "make", model: "model", startType: "whether it's push to start or keyed" };

const listOf = (words) => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);

/** The clarify event for a wiring question with `missing` fields. The client renders it as a vehicle form. */
export const vehicleClarify = (intent, missing) => {
  const known = { year: intent.year, make: intent.make, model: intent.model, startType: intent.startType };
  const onlyStartType = missing.length === 1 && missing[0] === "startType";
  const question = onlyStartType
    ? `Is the ${describeVehicle({ ...known, startType: null })} push to start or keyed? The 12V and ignition wiring are different.`
    : `Which vehicle is it? I need the ${listOf(missing.map((f) => FIELD_WORDS[f]))} to look up the exact wiring.`;
  return { slot: "vehicle", question, options: [], allowSkip: false, vehicle: known, missing, circuits: intent.circuits };
};
