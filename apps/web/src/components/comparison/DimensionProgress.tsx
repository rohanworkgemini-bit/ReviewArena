/**
 * Tiny progress chip rendered next to "Refine by dimension" — gives
 * users a live count of how many of the 8 they've picked without
 * expanding the panel. Matches the "matrix question" UX best practice
 * of always showing completion progress.
 */
export function DimensionProgress({ count, total }: { count: number; total: number }) {
  const pct = (count / total) * 100;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <div className="h-1 w-14 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono tabular-nums">
        {count}/{total}
      </span>
    </div>
  );
}
