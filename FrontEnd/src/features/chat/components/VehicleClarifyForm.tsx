import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useVehicleMakes, useVehicleModels } from "@/features/chat/api/vehicleOptions";
import type { ClarifyRequest, StartType } from "@/types/contracts";

interface VehicleClarifyFormProps {
  clarify: ClarifyRequest;
  onAnswer: (value: string) => void;
}

/** "F-150" and "f150" are the same model; "Dodge/Ram" lists as "Dodge". */
const squash = (text: string | null | undefined) => (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const findIn = (list: string[], value: string | null | undefined) => list.find((item) => squash(item) === squash(value)) ?? null;

const START_TYPES: { value: StartType; label: string; hint: string }[] = [
  { value: "pts", label: "Push to start", hint: "Start button, no key in the column" },
  { value: "key", label: "Keyed", hint: "Turn a key to start" },
];
const START_LABEL: Record<StartType, string> = { pts: "push to start", key: "keyed ignition" };

const fieldLabel = "text-micro text-muted-foreground font-medium";

/**
 * The vehicle a wiring answer needs: year, make, model and start type, all of
 * them (push-to-start and keyed are wired differently). Starts from what the
 * question already said; offers the makes/models/years the DRIG wiring guide
 * or Wiresheet actually have, and falls back to typing when the lists can't load.
 */
export function VehicleClarifyForm({ clarify, onAnswer }: VehicleClarifyFormProps) {
  const known = clarify.vehicle;
  const makesQuery = useVehicleMakes();
  const makes = makesQuery.data?.makes ?? [];
  const listsAvailable = !makesQuery.isError;

  const [make, setMake] = useState<string>(known?.make ?? "");
  const resolvedMake = findIn(makes, make) ?? make;
  const modelsQuery = useVehicleModels(resolvedMake);
  const models = useMemo(() => modelsQuery.data?.models ?? [], [modelsQuery.data]);

  const [model, setModel] = useState<string>(known?.model ?? "");
  const modelOption = models.find((m) => squash(m.model) === squash(model)) ?? null;
  const [year, setYear] = useState<string>(known?.year ? String(known.year) : "");
  const [startType, setStartType] = useState<StartType | null>(known?.startType ?? null);
  const [submitted, setSubmitted] = useState(false);

  const years = modelOption?.years ?? [];
  const yearNumber = Number(year);
  const yearValid = Number.isInteger(yearNumber) && yearNumber >= 1950 && yearNumber <= 2100;
  const complete = Boolean(resolvedMake.trim() && (modelOption?.model ?? model).trim() && yearValid && startType);

  const submit = () => {
    if (!complete || !startType) return;
    setSubmitted(true);
    onAnswer(`${yearNumber} ${resolvedMake.trim()} ${(modelOption?.model ?? model).trim()}, ${START_LABEL[startType]}`);
  };

  const useSelects = listsAvailable && makes.length > 0;
  const makeInList = Boolean(findIn(makes, make));

  return (
    <section
      aria-labelledby="clarify-vehicle"
      className="border-neutral-note-border bg-neutral-note-bg rounded-2xl border p-4 sm:p-5"
    >
      <h2 id="clarify-vehicle" className="text-step font-semibold text-balance">
        {clarify.question}
      </h2>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <label className="grid gap-1.5">
          <span className={fieldLabel}>Make</span>
          {useSelects && (makeInList || !make) ? (
            <Select
              value={findIn(makes, make) ?? undefined}
              onValueChange={(value) => {
                setMake(value);
                setModel("");
                setYear("");
              }}
            >
              <SelectTrigger className="bg-background h-12 w-full">
                <SelectValue placeholder="Choose make" />
              </SelectTrigger>
              <SelectContent>
                {makes.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input value={make} onChange={(e) => setMake(e.target.value)} placeholder="e.g. Ford" className="bg-background h-12" autoComplete="off" />
          )}
        </label>

        <label className="grid gap-1.5">
          <span className={fieldLabel}>Model</span>
          {useSelects && models.length > 0 && (modelOption || !model) ? (
            <Select
              value={modelOption?.model}
              onValueChange={(value) => {
                setModel(value);
                const option = models.find((m) => m.model === value);
                if (option && year && !option.years.includes(Number(year))) setYear("");
              }}
            >
              <SelectTrigger className="bg-background h-12 w-full">
                <SelectValue placeholder={modelsQuery.isFetching ? "Loading…" : "Choose model"} />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.model} value={m.model}>
                    {m.model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={modelsQuery.isFetching ? "Loading…" : "e.g. F-150"}
              className="bg-background h-12"
              autoComplete="off"
            />
          )}
        </label>

        <label className="grid gap-1.5">
          <span className={fieldLabel}>Year</span>
          {years.length > 0 && (!year || years.includes(yearNumber)) ? (
            <Select value={year || undefined} onValueChange={setYear}>
              <SelectTrigger className="bg-background h-12 w-full">
                <SelectValue placeholder="Choose year" />
              </SelectTrigger>
              <SelectContent>
                {[...years].reverse().map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={year}
              onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
              inputMode="numeric"
              placeholder="e.g. 2019"
              className="bg-background h-12"
              autoComplete="off"
            />
          )}
        </label>
      </div>

      <fieldset className="mt-4">
        <legend className={fieldLabel}>How does it start?</legend>
        <div className="mt-1.5 grid gap-3 sm:grid-cols-2">
          {START_TYPES.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant="outline"
              aria-pressed={startType === option.value}
              onClick={() => setStartType(option.value)}
              className={cn(
                "bg-background h-auto min-h-14 justify-start rounded-xl px-4 py-3 text-left whitespace-normal",
                startType === option.value && "border-primary ring-primary/30 ring-2",
              )}
            >
              <span className="flex flex-col items-start gap-1">
                <span className="text-body font-medium">{option.label}</span>
                <span className="text-micro text-muted-foreground font-normal">{option.hint}</span>
              </span>
            </Button>
          ))}
        </div>
      </fieldset>

      <Button className="mt-5 h-12 w-full sm:w-auto" disabled={!complete || submitted} onClick={submit}>
        Look up the wiring
      </Button>
      {!listsAvailable ? (
        <p className="text-micro text-muted-foreground mt-2">The vehicle list couldn&apos;t load, so type the vehicle in.</p>
      ) : null}
    </section>
  );
}
