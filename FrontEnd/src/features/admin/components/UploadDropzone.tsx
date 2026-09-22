import { useRef, useState, type DragEvent } from "react";
import { CloudUpload } from "lucide-react";
import { cn } from "@/lib/utils";
import { ACCEPTED_FILE_TYPES } from "../types";

const ACCEPT = ACCEPTED_FILE_TYPES.join(",");

interface UploadDropzoneProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

/**
 * Drag-and-drop or click-to-choose. Validation (type, size) lives with the
 * caller so a rejected file can be reported next to the ones that were accepted.
 */
export function UploadDropzone({ onFiles, disabled = false }: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) onFiles(files);
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={cn(
        "border-border bg-card flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
        dragging && "border-primary bg-accent",
        disabled && "opacity-60",
      )}
    >
      <CloudUpload className="text-muted-foreground size-9" aria-hidden />

      <div className="space-y-1">
        <p className="text-body font-medium">Drop PDF or Word files here</p>
        <p className="text-micro text-muted-foreground">
          PDF or Word (.docx), up to 500 MB each. Scanned pages without a text layer can&apos;t be read.
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Reset so choosing the same file twice in a row still fires onChange.
          event.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />

      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/50 inline-flex h-11 items-center justify-center rounded-md px-5 text-sm font-medium outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50"
      >
        Choose files
      </button>
    </div>
  );
}
