import { createContext, use, useMemo, type ReactNode } from "react";

export interface Technician {
  personId: string;
  name: string;
  orgId: string;
  role: "technician" | "engineer";
}

interface AuthContextValue {
  technician: Technician | null;
  signedIn: boolean;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  technician: null,
  signedIn: false,
  signOut: () => {},
});

/**
 * Skeleton. Sign-in is not built — there is no backend to sign into yet. The
 * shape is here so screens can read `useAuth()` without being rewritten later.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const value = useMemo<AuthContextValue>(
    () => ({
      technician: null,
      signedIn: false,
      signOut: () => localStorage.removeItem("drig.token"),
    }),
    [],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  return use(AuthContext);
}
