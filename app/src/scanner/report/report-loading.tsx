import { Skeleton } from '@/src/ui/primitives/skeleton';

export function ReportLoading() {
  return (
    <div
      role="status"
      aria-label="Preparing report"
      aria-live="polite"
      aria-busy="true"
      className="min-h-[20rem] rounded-panel border border-hairline bg-panel p-4 sm:p-5"
    >
      <div className="space-y-4">
        <div className="min-h-[9rem] rounded-control border border-hairline bg-raised/30 p-4">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="mt-2 h-3 w-2/3" />
          <Skeleton className="mt-5 h-12 w-full" />
        </div>
        <div className="min-h-[4rem] rounded-control border border-hairline bg-raised/30 p-4">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="mt-2 h-3 w-3/4" />
        </div>
        <div className="min-h-[5rem] rounded-control border border-hairline bg-raised/30 p-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-2 h-5 w-full" />
        </div>
      </div>
    </div>
  );
}
