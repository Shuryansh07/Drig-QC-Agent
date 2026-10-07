import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface FullPageLoaderProps {
  /** Message under the spinner. Pass a string, or an array to cycle through. */
  label?: string | string[];
  /** ms between cycled messages when `label` is an array. */
  messageInterval?: number;
  /** Hide the text label while keeping it accessible to screen readers. */
  hideLabel?: boolean;
  /** Show a Cancel button and get called when it's clicked. */
  onCancel?: () => void;
  className?: string;
}

/** Covers the entire viewport above everything else, including drawers and sheets. */
export function FullPageLoader({
  label = "Loading…",
  messageInterval = 2200,
  hideLabel = false,
  onCancel,
  className,
}: FullPageLoaderProps) {
  const messages = Array.isArray(label) ? label : [label];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (messages.length <= 1) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % messages.length),
      messageInterval,
    );
    return () => clearInterval(id);
  }, [messages.length, messageInterval]);

  const current = messages[index];

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        "fixed inset-0 z-[100] flex flex-col items-center justify-center gap-7 overflow-hidden",
        "bg-background/80 backdrop-blur-md",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300",
        className,
      )}
    >
      {/* Drifting gradient wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60 motion-safe:[animation:fpl-drift_12s_ease-in-out_infinite]"
        style={{
          background:
            "radial-gradient(40rem 40rem at 30% 30%, hsl(var(--primary)/0.12), transparent 60%), radial-gradient(35rem 35rem at 70% 70%, hsl(var(--primary)/0.10), transparent 60%)",
        }}
      />

      {/* Floating particles */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {PARTICLES.map((p, i) => (
          <span
            key={i}
            className="bg-primary/40 absolute size-1.5 rounded-full motion-safe:[animation:fpl-float_var(--dur)_ease-in-out_infinite]"
            style={
              {
                left: p.left,
                top: p.top,
                "--dur": p.dur,
                animationDelay: p.delay,
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      {/* Spinner: glow + dual rings + orbiting dots + pulsing core */}
      <div className="relative grid size-20 place-items-center">
        <div className="bg-primary/20 absolute inset-0 rounded-full blur-xl motion-safe:animate-pulse" />
        <div className="border-primary/15 border-t-primary absolute inset-0 rounded-full border-[3px] motion-safe:animate-spin [animation-duration:1s]" />
        <div className="border-primary/10 border-b-primary/60 absolute inset-2 rounded-full border-[3px] motion-safe:animate-spin [animation-duration:1.6s] [animation-direction:reverse]" />

        {/* Orbiting dots */}
        <div className="absolute inset-0 motion-safe:[animation:fpl-orbit_2.4s_linear_infinite]">
          <span className="bg-primary absolute left-1/2 top-0 size-2 -translate-x-1/2 rounded-full" />
        </div>
        <div className="absolute inset-0 motion-safe:[animation:fpl-orbit_2.4s_linear_infinite_reverse]">
          <span className="bg-primary/60 absolute bottom-0 left-1/2 size-1.5 -translate-x-1/2 rounded-full" />
        </div>

        <div className="bg-primary size-2.5 rounded-full motion-safe:[animation:fpl-breathe_1.8s_ease-in-out_infinite]" />
      </div>

      {hideLabel ? (
        <span className="sr-only">{current}</span>
      ) : (
        <p
          key={current}
          className={cn(
            "text-body min-h-5 bg-clip-text text-center text-transparent",
            "bg-gradient-to-r from-muted-foreground via-foreground to-muted-foreground",
            "bg-[length:200%_100%] motion-safe:[animation:fpl-shimmer_2.5s_linear_infinite]",
            "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1",
          )}
        >
          {current}
        </p>
      )}

      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring relative z-10 rounded-md px-3 py-1.5 text-sm transition-colors hover:scale-105 focus-visible:ring-2 focus-visible:outline-none"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

const PARTICLES = [
  { left: "15%", top: "25%", dur: "6s", delay: "0s" },
  { left: "80%", top: "20%", dur: "7.5s", delay: "0.8s" },
  { left: "25%", top: "75%", dur: "5.5s", delay: "1.4s" },
  { left: "70%", top: "70%", dur: "8s", delay: "0.4s" },
  { left: "50%", top: "15%", dur: "6.5s", delay: "1.1s" },
  { left: "88%", top: "55%", dur: "7s", delay: "2s" },
];