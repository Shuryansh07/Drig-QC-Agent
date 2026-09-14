import { useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  const mql = window.matchMedia(query);

  return useSyncExternalStore(
    (onChange) => {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => mql.matches,
    () => false,
  );
}

/** Bench work on a tablet gets the wider layout; everything else is phone-first. */
export function useIsWideScreen(): boolean {
  return useMediaQuery("(min-width: 768px)");
}
