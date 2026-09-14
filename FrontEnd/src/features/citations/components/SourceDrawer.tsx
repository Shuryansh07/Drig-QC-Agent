import { useAppDispatch, useAppSelector } from "@/app/hooks";
import { uiActions } from "@/features/ui/uiSlice";
import { useCitation } from "@/features/citations/api/queries";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * A bottom sheet, not a dialog — reachable with the thumb of the hand already
 * holding the phone. Renders the document at the cited page, the wiring row, or
 * the call card with audio.
 */
export function SourceDrawer() {
  const chunkId = useAppSelector((s) => s.ui.activeCitationId);
  const dispatch = useAppDispatch();
  const { data: citation, isPending, isError } = useCitation(chunkId);

  return (
    <Drawer
      open={Boolean(chunkId)}
      onOpenChange={(open) => !open && dispatch(uiActions.citationClosed())}
    >
      <DrawerContent className="max-h-[85dvh]">
        <DrawerHeader className="text-left">
          <DrawerTitle className="text-lead">
            {citation?.label ?? "Source"}
          </DrawerTitle>
          <DrawerDescription className="text-body text-muted-foreground">
            {citation?.locator ?? "Loading the passage this step came from"}
          </DrawerDescription>
        </DrawerHeader>

        <div className="overflow-y-auto px-4 pb-8">
          {isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-11/12" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : isError ? (
            <p className="text-body text-muted-foreground">
              This source needs a connection. It will open once you are back on signal.
            </p>
          ) : (
            <>
              {citation?.excerpt ? (
                <blockquote className="border-primary bg-muted text-step text-answer-fg border-l-4 p-4">
                  {citation.excerpt}
                </blockquote>
              ) : null}

              {/* TODO: PDF page render, wiring-sheet row, or call card with audio,
                  selected on citation.kind. Needs the document service. */}
              <div className="border-border text-body text-muted-foreground mt-4 rounded-lg border border-dashed p-6 text-center">
                Document view is not built yet
              </div>
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
