interface WaveformProps {
  levels: number[];
}

/** Amplitude bars, drawn from real samples. The only continuously animating
 *  thing in the app — it exists to prove the microphone is live. */
export function Waveform({ levels }: WaveformProps) {
  return (
    <div className="flex h-8 items-center justify-center gap-[3px]" aria-hidden>
      {levels.map((level, i) => (
        <span
          key={i}
          className="bg-primary-foreground/80 w-[3px] rounded-full"
          style={{ height: `${Math.max(4, Math.min(1, level) * 32)}px` }}
        />
      ))}
    </div>
  );
}
