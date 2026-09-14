import { createContext, use, useEffect, type ReactNode } from "react";
import { useAppDispatch, useAppSelector } from "@/app/hooks";
import { uiActions, type ThemePreference } from "@/features/ui/uiSlice";

interface ThemeContextValue {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  setTheme: () => {},
});

/**
 * Replaces `next-themes`, which shadcn pulls in by default. This is a Vite PWA;
 * the preference already lives in the ui slice, so a second store for it would
 * be one more thing to keep in sync.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useAppSelector((s) => s.ui.theme);
  const dispatch = useAppDispatch();

  useEffect(() => {
    const root = document.documentElement;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");

    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mql.matches);
      root.classList.toggle("dark", dark);
      root.style.colorScheme = dark ? "dark" : "light";
    };

    apply();
    if (theme !== "system") return;
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, [theme]);

  return (
    <ThemeContext
      value={{ theme, setTheme: (next) => dispatch(uiActions.themeChanged(next)) }}
    >
      {children}
    </ThemeContext>
  );
}

export function useTheme(): ThemeContextValue {
  return use(ThemeContext);
}
