import { useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  Trophy,
  BookOpen,
  Eye,
  Scale,
  Wrench,
  Lightbulb,
  Target,
  Compass,
  Code as CodeIcon,
  FileText,
  Vote,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getLeaderboard } from "@/lib/api";
import { VOTE_DIMENSIONS, DIMENSION_LABELS, type VoteDimension } from "@reviewarena/shared-types";

// Icon-per-category lookup. Keeping the mapping local — it's presentation,
// not domain logic, so the shared-types package shouldn't know about it.
const DIMENSION_ICONS: Record<VoteDimension, LucideIcon> = {
  COMPREHENSIVENESS: BookOpen,
  CLARITY: Eye,
  FAIRNESS: Scale,
  ACTIONABILITY: Wrench,
  CONSTRUCTIVENESS: Lightbulb,
  OBJECTIVITY: Target,
  RELEVANCE: Compass,
  TECHNICAL_TERMS: CodeIcon,
};

export function LeaderboardPage() {
  const [dimension, setDimension] = useState<VoteDimension | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["leaderboard", dimension],
    queryFn: () => getLeaderboard(dimension ?? undefined),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const entries = data?.entries ?? [];

  // Shared rating range across all rows so CI bars are visually comparable.
  const { minRating, maxRating } = useMemo(() => {
    if (entries.length === 0) return { minRating: 1000, maxRating: 1000 };
    const lows = entries.map((e) => e.ratingCiLow);
    const highs = entries.map((e) => e.ratingCiHigh);
    const min = Math.min(...lows);
    const max = Math.max(...highs);
    const pad = Math.max(10, (max - min) * 0.05);
    return { minRating: min - pad, maxRating: max + pad };
  }, [entries]);

  // "Rank Spread": [best-possible-rank, worst-possible-rank].
  // Best  rank = 1 + (# systems whose ciLow strictly above this.ciHigh)
  // Worst rank = 1 + (# systems whose ciHigh strictly above this.ciLow)
  // Communicates "given the votes we have, this system could place
  // anywhere between rank X and rank Y."
  const rankSpread = useMemo(() => {
    const map = new Map<string, { best: number; worst: number }>();
    for (const e of entries) {
      let best = 1;
      let worst = 1;
      for (const other of entries) {
        if (other.systemSlug === e.systemSlug) continue;
        if (other.ratingCiLow > e.ratingCiHigh) best++;
        if (other.ratingCiHigh > e.ratingCiLow) worst++;
      }
      map.set(e.systemSlug, { best, worst });
    }
    return map;
  }, [entries]);

  const currentLabel = dimension ? DIMENSION_LABELS[dimension] : "Overall";
  const currentDescription = dimension
    ? `Ranking by ${DIMENSION_LABELS[dimension]}, computed only over votes that included a per-dimension pick for ${DIMENSION_LABELS[dimension]}.`
    : "Overall ranking across automated peer-review systems, computed from blinded pairwise human comparisons.";

  return (
    <div className="container py-6">
      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        {/* ─── Left rail: categories ───────────────────────────────────── */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-lg border bg-card">
            <div className="border-b px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Categories ({VOTE_DIMENSIONS.length + 1})
            </div>
            <nav className="p-1">
              <CategoryRow
                icon={Trophy}
                label="Overall"
                active={dimension === null}
                onClick={() => setDimension(null)}
              />
              {VOTE_DIMENSIONS.map((d) => (
                <CategoryRow
                  key={d}
                  icon={DIMENSION_ICONS[d]}
                  label={DIMENSION_LABELS[d]}
                  active={dimension === d}
                  onClick={() => setDimension(d)}
                />
              ))}
            </nav>
          </div>
        </aside>

        {/* ─── Right pane: header + table ──────────────────────────────── */}
        <section className="min-w-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">Review Arena</h1>
                <Badge variant="secondary" className="font-mono">
                  <Trophy className="mr-1 h-3 w-3" />
                  {currentLabel}
                </Badge>
              </div>
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                {currentDescription}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Vote className="h-3.5 w-3.5" />
                  <span className="font-mono text-foreground">
                    {data?.totalVotes ?? "—"}
                  </span>{" "}
                  votes
                </span>
                <span className="flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5" />
                  <span className="font-mono text-foreground">
                    {data?.totalPapers ?? "—"}
                  </span>{" "}
                  papers
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-foreground">{entries.length}</span> systems
                </span>
                {isError && (
                  <Badge variant="destructive" className="ml-2">
                    {(error as Error)?.message ?? "API error"}
                  </Badge>
                )}
              </div>
            </div>
          </div>

          <div className="mt-5 rounded-lg border bg-card">
            {isLoading ? (
              <LeaderboardSkeleton />
            ) : entries.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                <p className="mb-1">
                  No votes yet{dimension ? ` for ${DIMENSION_LABELS[dimension]}` : ""}.
                </p>
                <p className="mb-4">
                  {dimension
                    ? `Vote on a comparison and pick "A is better" or "B is better" for ${DIMENSION_LABELS[dimension]} to populate this leaderboard.`
                    : "Upload a paper and cast a vote to see systems ranked here."}
                </p>
                <Button asChild>
                  <a href="/upload">Upload a paper</a>
                </Button>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-3 pl-4 pr-3 font-medium">Rank spread</th>
                    <th className="py-3 pr-4 font-medium">System</th>
                    <th className="py-3 pr-4 font-medium text-right">Score</th>
                    <th className="py-3 pr-4 font-medium">95% CI</th>
                    <th className="py-3 pr-4 font-medium text-right">Votes</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const spread = rankSpread.get(e.systemSlug);
                    const halfCi = Math.round((e.ratingCiHigh - e.ratingCiLow) / 2);
                    return (
                      <tr
                        key={e.systemSlug}
                        className="border-b last:border-0 hover:bg-muted/30"
                      >
                        <td className="py-3 pl-4 pr-3">
                          <RankSpread best={spread?.best ?? e.rank} worst={spread?.worst ?? e.rank} />
                        </td>
                        <td className="py-3 pr-4">
                          <div className="font-medium">{e.systemName}</div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {e.systemSlug}
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-right">
                          <span className="font-mono">{Math.round(e.rating)}</span>
                          <span className="ml-1 font-mono text-xs text-muted-foreground">
                            ±{halfCi}
                          </span>
                        </td>
                        <td className="py-3 pr-4">
                          <CiBar
                            low={e.ratingCiLow}
                            rating={e.rating}
                            high={e.ratingCiHigh}
                            min={minRating}
                            max={maxRating}
                          />
                          <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                            [{Math.round(e.ratingCiLow)}, {Math.round(e.ratingCiHigh)}]
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-right font-mono text-muted-foreground">
                          {e.voteCount}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function CategoryRow({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors " +
        (active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
      {active && <span className="ml-auto text-xs">●</span>}
    </button>
  );
}

function RankSpread({ best, worst }: { best: number; worst: number }) {
  // Renders the "1 — 4" rank-range shorthand. When best == worst we just
  // show the single number so unambiguous ranks read cleanly.
  if (best === worst) {
    return <span className="font-mono text-base text-foreground">{best}</span>;
  }
  return (
    <span className="font-mono text-sm">
      <span className="text-foreground">{best}</span>
      <span className="mx-1 text-muted-foreground">–</span>
      <span className="text-muted-foreground">{worst}</span>
    </span>
  );
}

function CiBar({
  low,
  rating,
  high,
  min,
  max,
}: {
  low: number;
  rating: number;
  high: number;
  min: number;
  max: number;
}) {
  const span = Math.max(1, max - min);
  const leftPct = ((low - min) / span) * 100;
  const widthPct = Math.max(0.5, ((high - low) / span) * 100);
  const markPct = ((rating - min) / span) * 100;
  return (
    <div className="relative h-2 w-full rounded-full bg-muted">
      <div
        className="absolute top-0 h-2 rounded-full bg-primary/40"
        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
      />
      <div
        className="absolute top-[-2px] h-[12px] w-[2px] bg-primary"
        style={{ left: `calc(${markPct}% - 1px)` }}
        title={`Rating ${Math.round(rating)}`}
      />
    </div>
  );
}

// Eight skeleton rows that match the real table's height so the page
// doesn't reflow when data arrives. Better than a centred "Loading…"
// line, which makes the layout jump.
function LeaderboardSkeleton() {
  return (
    <div className="divide-y">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="h-4 w-6 rounded bg-muted animate-pulse" />
          <div className="h-4 w-40 rounded bg-muted animate-pulse" />
          <div className="ml-auto h-2 w-48 rounded-full bg-muted animate-pulse" />
          <div className="h-4 w-12 rounded bg-muted animate-pulse" />
        </div>
      ))}
    </div>
  );
}
