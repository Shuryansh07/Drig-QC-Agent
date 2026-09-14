import { Skeleton } from "@/components/ui/skeleton";

/** Shown while a lazily loaded route chunk arrives. */
export function SkeletonRouteFallback() {
  return (
    <div className="mx-auto w-full max-w-[42rem] space-y-4 px-5 py-8">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-5/6" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
