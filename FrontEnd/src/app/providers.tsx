import type { ReactNode } from "react";
import { Provider as ReduxProvider } from "react-redux";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { store } from "@/app/store";
import { queryClient } from "@/lib/query-client";
import { ThemeProvider } from "@/app/theme";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ReduxProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            {/* delayDuration 0: there is no hover on a phone, so tooltips are
                tap-to-reveal and must not wait for an intent timer. */}
            <TooltipProvider delayDuration={0}>
              <ErrorBoundary>{children}</ErrorBoundary>
              <Toaster position="top-center" expand richColors={false} />
            </TooltipProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ReduxProvider>
  );
}
