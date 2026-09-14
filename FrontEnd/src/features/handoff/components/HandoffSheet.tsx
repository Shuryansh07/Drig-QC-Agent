import { useState } from "react";
import { useAppDispatch, useAppSelector } from "@/app/hooks";
import { uiActions } from "@/features/ui/uiSlice";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

interface HandoffSheetProps {
  onSubmit: (note: string) => void;
}

export function HandoffSheet({ onSubmit }: HandoffSheetProps) {
  const open = useAppSelector((s) => s.ui.handoffSheetOpen);
  const dispatch = useAppDispatch();
  const [note, setNote] = useState("");

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => dispatch(uiActions.handoffSheetToggled(next))}
    >
      <SheetContent side="bottom" className="max-h-[85dvh]">
        <SheetHeader className="text-left">
          <SheetTitle className="text-lead">Ask an engineer</SheetTitle>
          <SheetDescription className="text-body text-muted-foreground">
            The vehicle and everything you've already tried go with this. You don't
            need to repeat any of it.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-8">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            aria-label="Anything else the engineer should know"
            placeholder="Anything else worth knowing? Optional."
            className="text-body resize-none"
          />
          <Button
            onClick={() => {
              onSubmit(note);
              setNote("");
              dispatch(uiActions.handoffSheetToggled(false));
            }}
            className="h-touch-lg w-full text-step"
          >
            Send to an engineer
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
