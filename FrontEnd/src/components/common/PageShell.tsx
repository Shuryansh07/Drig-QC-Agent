import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { OfflineBanner } from "@/components/common/OfflineBanner";
import { AppSidebar } from "@/components/common/AppSidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

interface PageShellProps {
  /** Sits above the scroll area. Keep it to one line — screen space is answer space. */
  header?: ReactNode;
  /** Pinned to the bottom of the page, e.g. the chat composer. */
  dock?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Desk screens (admin) use the width; chat screens keep the centred reading column. */
  wide?: boolean;
  /** No sidebar or top bar — for the sign-in page. */
  bare?: boolean;
}

/**
 * The app shell every screen shares: a collapsible sidebar (a sheet on phones),
 * a slim top bar, a scrolling content column and an optional pinned dock.
 */
export function PageShell({ header, dock, children, className, wide = false, bare = false }: PageShellProps) {
  const column = wide ? "max-w-5xl" : "max-w-3xl";

  const content = (
    <>
      <OfflineBanner />
      {header ? <header className="border-border shrink-0 border-b">{header}</header> : null}

      <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", className)}>
        <div className={cn("mx-auto w-full px-4 py-4 sm:px-6", column)}>{children}</div>
      </div>

      {dock ? (
        <div className="shrink-0">
          <div className={cn("mx-auto w-full px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6", column)}>
            {dock}
          </div>
        </div>
      ) : null}
    </>
  );

  if (bare) return <div className="bg-background flex h-dvh flex-col">{content}</div>;

  return (
    <SidebarProvider className="h-dvh min-h-0">
      <AppSidebar />
      <SidebarInset className="min-h-0 min-w-0">
        <div className="flex h-14 shrink-0 items-center gap-2 px-3">
          <SidebarTrigger className="size-10" aria-label="Toggle sidebar" />
          <span className="text-muted-foreground text-base font-medium">DRIG Support</span>
        </div>
        {content}
      </SidebarInset>
    </SidebarProvider>
  );
}
