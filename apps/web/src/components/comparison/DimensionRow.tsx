import { cn } from "@/lib/cn";

/**
 * Single dimension row in the "Refine by dimension" panel —
 * segmented split-button instead of two separate outline buttons.
 * Clicking the already-selected side deselects (returns the dimension
 * to "no opinion"). Compact two-line layout (label + question above
 * the control) keeps 8 rows from filling the viewport.
 */
export function DimensionRow({
  label,
  question,
  value,
  onPickA,
  onPickB,
}: {
  label: string;
  question: string;
  value: number | undefined;
  onPickA: () => void;
  onPickB: () => void;
}) {
  const aActive = value === -1;
  const bActive = value === 1;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-[11px] text-muted-foreground">{question}</span>
      </div>
      <div
        className="grid grid-cols-2 overflow-hidden rounded-md border bg-background"
        role="radiogroup"
        aria-label={`${label} preference`}
      >
        <button
          type="button"
          role="radio"
          aria-checked={aActive}
          onClick={onPickA}
          className={cn(
            "flex items-center justify-center gap-1.5 border-r px-3 py-2 text-sm transition-colors",
            aActive
              ? "bg-primary font-medium text-primary-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <span
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold",
              aActive ? "bg-primary-foreground/20" : "bg-muted",
            )}
          >
            A
          </span>
          <span>is better</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={bActive}
          onClick={onPickB}
          className={cn(
            "flex items-center justify-center gap-1.5 px-3 py-2 text-sm transition-colors",
            bActive
              ? "bg-primary font-medium text-primary-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <span
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold",
              bActive ? "bg-primary-foreground/20" : "bg-muted",
            )}
          >
            B
          </span>
          <span>is better</span>
        </button>
      </div>
    </div>
  );
}
