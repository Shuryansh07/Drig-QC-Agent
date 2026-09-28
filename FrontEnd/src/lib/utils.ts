import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Without this, tailwind-merge reads the custom font sizes (text-step, text-body…
// from globals.css) as text COLOURS and drops the real colour, e.g. a Button's
// text-primary-foreground, leaving invisible text.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["micro", "body", "step", "lead", "title"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
