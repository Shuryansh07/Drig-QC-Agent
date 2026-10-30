import { useState } from "react";
import { BookOpen, Cable, CircleHelp, ShieldCheck } from "lucide-react";
import { PageShell } from "@/components/common/PageShell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ManualsPanel } from "./components/ManualsPanel";
import { WiringGuidePanel } from "./components/WiringGuidePanel";
import { UnansweredPanel } from "./components/UnansweredPanel";

type Section = "drig" | "wiring" | "general" | "unanswered";

const SECTION_KEY = "drig.admin.section";
const SECTIONS: ReadonlySet<string> = new Set(["drig", "wiring", "general", "unanswered"]);

const initialSection = (): Section => {
  try {
    const saved = localStorage.getItem(SECTION_KEY);
    return saved && SECTIONS.has(saved) ? (saved as Section) : "drig";
  } catch {
    return "drig";
  }
};

/**
 * Knowledge-base admin, in three separate places so DRIG's own documentation
 * is never mixed up with everything else:
 *   DRIG Standard manuals — DRIG's installation manuals; the assistant answers from these first
 *   DRIG wiring guide     — the vehicle wiring workbook; looked up before Wiresheet
 *   Other manuals         — vendor manuals and everything else, used when DRIG's don't answer
 * plus Unanswered questions: what technicians asked that none of it answered.
 */
export default function AdminKnowledgeScreen() {
  const [section, setSection] = useState<Section>(initialSection);

  const changeSection = (value: string) => {
    if (!SECTIONS.has(value)) return;
    setSection(value as Section);
    try {
      localStorage.setItem(SECTION_KEY, value);
    } catch {
      // Remembering the tab is a convenience only.
    }
  };

  return (
    <PageShell
      wide
      header={
        <div className="px-5 py-4">
          <h1 className="text-title font-semibold tracking-tight">Knowledge base</h1>
          <p className="text-micro text-muted-foreground mt-1">
            DRIG&apos;s own manuals and wiring guide always come first. The other manuals and Wiresheet are only used where DRIG&apos;s
            documentation has no answer.
          </p>
        </div>
      }
    >
      <Tabs value={section} onValueChange={changeSection} className="gap-6">
        <TabsList className="h-auto w-full flex-wrap sm:w-fit">
          <TabsTrigger value="drig" className="min-h-9">
            <ShieldCheck aria-hidden />
            DRIG Standard manuals
          </TabsTrigger>
          <TabsTrigger value="wiring" className="min-h-9">
            <Cable aria-hidden />
            DRIG wiring guide
          </TabsTrigger>
          <TabsTrigger value="general" className="min-h-9">
            <BookOpen aria-hidden />
            Other manuals
          </TabsTrigger>
          <TabsTrigger value="unanswered" className="min-h-9">
            <CircleHelp aria-hidden />
            Unanswered questions
          </TabsTrigger>
        </TabsList>

        <TabsContent value="drig" className="space-y-4">
          <p className="text-micro text-muted-foreground">
            DRIG&apos;s installation manuals (PDF, Word or image). Every question is searched here first; another manual is only used
            when none of these answers it.
          </p>
          <ManualsPanel collection="drig" />
        </TabsContent>

        <TabsContent value="wiring">
          <WiringGuidePanel />
        </TabsContent>

        <TabsContent value="general" className="space-y-4">
          <p className="text-micro text-muted-foreground">
            Vendor manuals and guides. A PDF or Word file is split by section and paragraph; a standalone image (JPG/PNG) is described
            by an AI model, so a labeled diagram or nameplate photo becomes searchable too.
          </p>
          <ManualsPanel collection="general" />
        </TabsContent>

        <TabsContent value="unanswered">
          <UnansweredPanel />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
