# Types

`generated/` is produced from the shared `/contracts` JSON Schemas and is
git-ignored (§7, §8 of `Plan/FRONTEND_DESIGN.md`). The frame and answer shapes
are the same objects the backend gates validate. Hand-writing them here
guarantees eventual drift, and drift in the answer contract means citations
silently stop rendering.

Until `/contracts` exists, `contracts.ts` holds provisional shapes. Every one of
them is a placeholder to be deleted the moment generation is wired up — do not
build anything on them that you would not be happy to regenerate.
