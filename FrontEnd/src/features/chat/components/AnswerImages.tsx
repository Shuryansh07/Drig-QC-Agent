import type { AnswerImage } from "@/types/contracts";

interface AnswerImagesProps {
  images: AnswerImage[];
}

/**
 * The diagram(s) or photo(s) the answer was actually grounded on — the same
 * evidence image the model read, not a generic document icon. Rendered large
 * enough to read directly; tapping opens the full-resolution original in a new
 * tab, since a wiring diagram's small print is exactly what a constrained card
 * width can't show. The URL is presigned and expires, so this is never cached
 * past the session it arrived in.
 */
export function AnswerImages({ images }: AnswerImagesProps) {
  if (images.length === 0) return null;

  return (
    <div className="space-y-3">
      {images.map((image) => (
        <a
          key={image.url}
          href={image.url}
          target="_blank"
          rel="noopener noreferrer"
          className="border-border bg-card block overflow-hidden rounded-2xl border"
        >
          <img src={image.url} alt={image.label} className="max-h-[28rem] w-full object-contain" />
          <p className="text-micro text-muted-foreground border-border border-t px-3 py-2">{image.label}</p>
        </a>
      ))}
    </div>
  );
}
