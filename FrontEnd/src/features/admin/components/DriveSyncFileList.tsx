import { useState } from "react";
import {
  CircleCheck,
  CircleDashed,
  Copy,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DriveSyncFile, DriveSyncFileStatus } from "../types";

const STATUS: Record<
  DriveSyncFileStatus,
  { label: string; icon: typeof CircleCheck; className: string }
> = {
  waiting: {
    label: "Waiting",
    icon: CircleDashed,
    className: "text-muted-foreground",
  },
  downloading: {
    label: "Downloading…",
    icon: LoaderCircle,
    className: "text-foreground",
  },
  queued: {
    label: "Sent for processing",
    icon: CircleCheck,
    className: "text-foreground",
  },
  duplicate: {
    label: "Already imported",
    icon: Copy,
    className: "text-muted-foreground",
  },
  failed: {
    label: "Failed",
    icon: TriangleAlert,
    className: "text-destructive",
  },
};

type Filter = "all" | DriveSyncFileStatus;
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "queued", label: "Sent" },
  { value: "duplicate", label: "Already imported" },
  { value: "failed", label: "Failed" },
  { value: "waiting", label: "Waiting" },
];

interface DriveSyncFileListProps {
  files: DriveSyncFile[];
  /** Jumps the document list to this file, to follow its processing there. */
  onShowDocument: (name: string) => void;
}

/** Each file of the running (or last) Drive sync and what happened to it. */
export function DriveSyncFileList({
  files,
  onShowDocument,
}: DriveSyncFileListProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const count = (value: Filter) =>
    value === "all"
      ? files.length
      : files.filter((f) => f.status === value).length;
  // "Waiting" also covers the one file being downloaded right now.
  const shown =
    filter === "all"
      ? files
      : files.filter(
          (f) =>
            f.status === filter ||
            (filter === "waiting" && f.status === "downloading"),
        );

  return (
    <div className="space-y-2">
      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label="Filter synced files"
      >
        {FILTERS.map(({ value, label }) => {
          const c =
            value === "waiting"
              ? count("waiting") + count("downloading")
              : count(value);
          if (value !== "all" && c === 0) return null;
          return (
            <Button
              key={value}
              variant={filter === value ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
              <span className="text-muted-foreground tabular-nums">
                {c.toLocaleString()}
              </span>
            </Button>
          );
        })}
      </div>

      <ul className="border-border divide-border max-h-96 divide-y overflow-y-auto rounded-lg border">
        {shown.map((file, i) => {
          const status = STATUS[file.status];
          const Icon = status.icon;
          return (
            <li
              key={`${file.folder}/${file.name}-${i}`}
              className="flex items-start gap-3 px-3 py-2"
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  status.className,
                  file.status === "downloading" && "animate-spin",
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-micro font-medium break-words">
                  {file.name}
                </p>
                <p className="text-micro text-muted-foreground break-words">
                  {file.folder || "Main folder"} · {file.type} ·{" "}
                  <span className={status.className}>{status.label}</span>
                </p>
                {file.message ? (
                  <p className="text-micro text-destructive break-words">
                    {file.message}
                  </p>
                ) : null}
              </div>
              {file.document_id ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => onShowDocument(file.name)}
                >
                  View
                </Button>
              ) : null}
            </li>
          );
        })}
        {shown.length === 0 ? (
          <li className="text-micro text-muted-foreground px-3 py-2">
            No files here.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
