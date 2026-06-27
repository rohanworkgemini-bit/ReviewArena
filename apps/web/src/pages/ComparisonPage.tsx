import { useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { ApiError, getPair, getPaperStatus, submitVote } from "@/lib/api";
import { useReviewStream } from "@/hooks/useReviewStream";
import {
  DimensionProgress,
  DimensionRow,
  GeneratingPanel,
  StreamingReviewPanel,
} from "@/components/comparison";
import {
  VOTE_DIMENSIONS,
  DIMENSION_LABELS,
  DIMENSION_DESCRIPTIONS,
  type VoteDimension,
  type PairResponse,
  type StructuredReview,
} from "@reviewarena/shared-types";

// DEV-ONLY visual fallback. Lets us hit /compare?paperId=... with no
// real data and see the layout (column widths, sticky vote bar, scoring
// dimensions). In production we never render this — the page either
// shows the real pair, the GeneratingPanel, or redirects to /upload.
const PLACEHOLDER_REVIEW_A: StructuredReview = {
  summary: "The paper proposes a method for X using Y. Experiments on Z show improvements over baselines.",
  strengths: [
    "Clear problem formulation tied to a real downstream task.",
    "Ablations cover the key design decisions.",
  ],
  weaknesses: [
    "Results on Z are statistically marginal (no confidence intervals reported).",
    "Comparison to prior work A and B is missing.",
  ],
  questions: [
    "How sensitive is the method to the choice of hyperparameter λ?",
    "Have the authors considered domain shift to dataset Q?",
  ],
  soundness: 3,
  presentation: 4,
  contribution: 3,
  overallRating: 6,
  confidence: 4,
};

const PLACEHOLDER_REVIEW_B: StructuredReview = {
  summary: "Authors tackle X with a Y-based approach and report gains over baseline B.",
  strengths: ["The empirical setup is reproducible."],
  weaknesses: [
    "The motivation is underspecified — why is this problem worth solving?",
    "Related work omits several core references.",
    "Figures 2 and 4 are difficult to read at the printed scale.",
  ],
  questions: ["Could the method be applied without supervised labels on Z?"],
  soundness: 2,
  presentation: 2,
  contribution: 2,
  overallRating: 4,
  confidence: 3,
};

const PLACEHOLDER_PAIR: PairResponse = {
  paper: { id: "placeholder", title: "On the Utility of LLMs for Code Review" },
  reviewA: { reviewId: "rev-a", structured: PLACEHOLDER_REVIEW_A },
  reviewB: { reviewId: "rev-b", structured: PLACEHOLDER_REVIEW_B },
  pairToken: "placeholder",
};

export function ComparisonPage() {
  const [params] = useSearchParams();
  const paperId = params.get("paperId") ?? "";
  const navigate = useNavigate();

  // /compare is only reachable via an upload — no standalone nav entry.
  // If someone lands here without a paperId, send them to /upload.
  useEffect(() => {
    if (!paperId) navigate("/upload", { replace: true });
  }, [paperId, navigate]);

  const startedAt = useMemo(() => Date.now(), [paperId]);
  const [dimensionValues, setDimensionValues] = useState<Partial<Record<VoteDimension, number>>>({});
  const [refineOpen, setRefineOpen] = useState(false);

  // Resume the in-flight round on reload. The pair is held stable from the
  // moment it's picked until the user votes — refreshing should never
  // re-roll. We persist the pairToken in sessionStorage keyed by
  // paperId and send it back on the next /pair call; the server honors it
  // if the HMAC + session match. Cleared in voteMutation.onSuccess so the
  // next round (next paper / explicit "next comparison") picks fresh.
  const PAIR_STORAGE_KEY = `pair-token:${paperId}`;
  const pairQuery = useQuery({
    queryKey: ["pair", paperId],
    queryFn: () => {
      const stored =
        typeof window !== "undefined"
          ? window.sessionStorage.getItem(PAIR_STORAGE_KEY) ?? undefined
          : undefined;
      return getPair(paperId, stored);
    },
    enabled: paperId.length > 0,
    retry: (failureCount, err) =>
      failureCount < 60 && err instanceof ApiError && err.code === "NotReady",
    retryDelay: 2000,
  });

  useEffect(() => {
    const token = pairQuery.data?.pairToken;
    if (token && typeof window !== "undefined") {
      window.sessionStorage.setItem(PAIR_STORAGE_KEY, token);
    }
  }, [pairQuery.data?.pairToken, PAIR_STORAGE_KEY]);

  // While reviews are still being generated, the API responds with
  // NotReady — drive a progress bar from /papers/:id so the user sees
  // generation move along rather than staring at a generic spinner.
  const pairError = pairQuery.error;
  const isGenerating =
    paperId.length > 0 &&
    !pairQuery.data &&
    (pairQuery.isPending ||
      (pairError instanceof ApiError && pairError.code === "NotReady"));

  const statusQuery = useQuery({
    queryKey: ["paper-status", paperId],
    queryFn: () => getPaperStatus(paperId),
    enabled: isGenerating,
    refetchInterval: isGenerating ? 1500 : false,
  });

  // Placeholder is dev-only — production must never show mock review data
  // (it'd skew Elo and confuse voters). In prod, if pair isn't ready and
  // we're not actively generating, send the user back to /upload below.
  const allowPlaceholder = import.meta.env.DEV;
  const pair = pairQuery.data ?? (allowPlaceholder ? PLACEHOLDER_PAIR : null);
  const usingPlaceholder = !pairQuery.data && !isGenerating && allowPlaceholder;

  // Production guard: no real pair, not generating, no dev placeholder →
  // something went wrong (pair API failed silently, link was stale).
  // Redirect rather than render a broken empty page.
  useEffect(() => {
    if (!pair && !isGenerating && paperId.length > 0) {
      navigate("/upload", { replace: true });
    }
  }, [pair, isGenerating, paperId, navigate]);

  if (!pair) {
    // Render nothing while the redirect effect above runs.
    return null;
  }

  const voteMutation = useMutation({
    mutationFn: (winner: "A" | "B" | "TIE") =>
      submitVote({
        pairToken: pair.pairToken,
        winner,
        decisionMs: Date.now() - startedAt,
        dimensions: Object.entries(dimensionValues).map(([dimension, value]) => ({
          dimension: dimension as VoteDimension,
          value: value!,
        })),
      }),
    onSuccess: (data) => {
      // Vote landed — release the stored pair so the next /compare visit
      // (from the reveal screen's "Next comparison" button) gets a fresh
      // sample instead of trying to resume this now-spent round.
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(PAIR_STORAGE_KEY);
      }
      const state = encodeURIComponent(JSON.stringify(data.reveal));
      navigate(`/reveal?voteId=${data.voteId}&state=${state}`);
    },
  });

  const refinedCount = Object.keys(dimensionValues).length;
  const submitting = voteMutation.isPending;

  // Open streams here (not in the panels) so we can gate the vote bar
  // on "both done" at the parent level. The hook returns INITIAL state
  // when reviewId is undefined and short-circuits when the structured
  // payload was already in the /pair response.
  const streamA = useReviewStream(
    pairQuery.data && !pairQuery.data.reviewA.structured
      ? pairQuery.data.reviewA.reviewId
      : undefined,
  );
  const streamB = useReviewStream(
    pairQuery.data && !pairQuery.data.reviewB.structured
      ? pairQuery.data.reviewB.reviewId
      : undefined,
  );

  // bothReady = both reviews are in a TERMINAL state — either:
  //   (a) /pair returned structured outright (review COMPLETED before
  //       this page mounted),
  //   (b) the SSE stream emitted 'done' with structured, or
  //   (c) the stream errored (treated terminal so the user isn't stuck;
  //       the panel surfaces a Retry button so they can try again).
  // Voting while one side has errored is allowed — it counts as the
  // model "failing to review" which is real signal.
  const aReady =
    !!pairQuery.data?.reviewA.structured || streamA.done || !!streamA.error;
  const bReady =
    !!pairQuery.data?.reviewB.structured || streamB.done || !!streamB.error;
  const bothReady = aReady && bReady;

  // Keyboard shortcuts for power-users. 1 / 2 / 3 map to A / Tie / B.
  // Only fires when both reviews are ready and no input is focused.
  // ArrowLeft/Right as an alternate for muscle memory.
  useEffect(() => {
    if (!bothReady || submitting || isGenerating) return;
    const cast = (winner: "A" | "B" | "TIE") => voteMutation.mutate(winner);
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "1" || e.key === "ArrowLeft") {
        e.preventDefault();
        cast("A");
      } else if (e.key === "2") {
        e.preventDefault();
        cast("TIE");
      } else if (e.key === "3" || e.key === "ArrowRight") {
        e.preventDefault();
        cast("B");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bothReady, submitting, isGenerating, voteMutation]);

  return (
    // pb-32 so the sticky bottom bar never covers the last review section.
    <div className="container py-6 pb-32 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight truncate">
            {pair.paper.title ?? "Untitled paper"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Read both reviews. Decide which is more useful — or call it a tie.
          </p>
        </div>
        {usingPlaceholder && (
          <Badge variant="outline" className="shrink-0">placeholder</Badge>
        )}
      </div>

      {isGenerating ? (
        <GeneratingPanel
          completed={statusQuery.data?.completedReviewCount ?? 0}
          expected={statusQuery.data?.expectedReviewCount ?? 0}
          parseFailed={statusQuery.data?.status === "PARSE_FAILED"}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <StreamingReviewPanel
            label="Review A"
            structured={pair.reviewA.structured ?? null}
            stream={streamA}
          />
          <StreamingReviewPanel
            label="Review B"
            structured={pair.reviewB.structured ?? null}
            stream={streamB}
          />
        </div>
      )}

      {/* Optional per-dimension picks. Hidden by default so the verdict
          decision isn't drowned in 8 extra controls — "vote first, refine
          later" flow. Inside the panel each dimension is a single
          segmented split-button (matrix-style survey pattern) instead of
          two separate buttons — clearer mutual-exclusion + cleaner
          vertical rhythm. */}
      <div className="rounded-lg border bg-card">
        <button
          type="button"
          onClick={() => setRefineOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-muted/30"
        >
          <div className="flex items-center gap-2">
            <span className="font-medium">Refine by dimension</span>
            <span className="text-xs text-muted-foreground">(optional)</span>
          </div>
          <div className="flex items-center gap-3">
            <DimensionProgress
              count={refinedCount}
              total={VOTE_DIMENSIONS.length}
            />
            <span
              aria-hidden
              className={cn(
                "text-muted-foreground transition-transform duration-150",
                refineOpen && "rotate-90",
              )}
            >
              ▸
            </span>
          </div>
        </button>
        {refineOpen && (
          <div className="border-t px-4 py-4">
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
              {VOTE_DIMENSIONS.map((d) => {
                const v = dimensionValues[d];
                const pick = (next: -1 | 1) =>
                  setDimensionValues((prev) => {
                    const copy = { ...prev };
                    if (copy[d] === next) delete copy[d];
                    else copy[d] = next;
                    return copy;
                  });
                return (
                  <DimensionRow
                    key={d}
                    label={DIMENSION_LABELS[d]}
                    question={DIMENSION_DESCRIPTIONS[d]}
                    value={v}
                    onPickA={() => pick(-1)}
                    onPickB={() => pick(1)}
                  />
                );
              })}
            </div>
            {refinedCount > 0 && (
              <button
                type="button"
                onClick={() => setDimensionValues({})}
                className="mt-4 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Clear all picks
              </button>
            )}
          </div>
        )}
      </div>

      {voteMutation.isError && (
        <p className="text-sm text-destructive">{(voteMutation.error as Error).message}</p>
      )}

      {/* Sticky vote bar — the single primary action on the page. */}
      <div
        className="fixed bottom-0 right-0 z-30 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 left-0 lg:[left:var(--sidebar-w)]"
      >
        <div className="container flex items-center gap-3 py-3">
          <span className="hidden text-xs uppercase tracking-wide text-muted-foreground md:inline">
            Your verdict
          </span>
          <div className="flex flex-1 gap-2">
            <Button
              size="lg"
              className="flex-1"
              variant="outline"
              disabled={submitting || isGenerating || !bothReady}
              onClick={() => voteMutation.mutate("A")}
              title="Shortcut: 1 or ←"
            >
              <span>A is better</span>
              <kbd className="ml-2 hidden rounded border bg-muted px-1.5 text-[10px] font-mono text-muted-foreground md:inline">1</kbd>
            </Button>
            <Button
              size="lg"
              className="flex-1"
              variant="outline"
              disabled={submitting || isGenerating || !bothReady}
              onClick={() => voteMutation.mutate("TIE")}
              title="Shortcut: 2"
            >
              <span>Tie</span>
              <kbd className="ml-2 hidden rounded border bg-muted px-1.5 text-[10px] font-mono text-muted-foreground md:inline">2</kbd>
            </Button>
            <Button
              size="lg"
              className="flex-1"
              variant="outline"
              disabled={submitting || isGenerating || !bothReady}
              onClick={() => voteMutation.mutate("B")}
              title="Shortcut: 3 or →"
            >
              <span>B is better</span>
              <kbd className="ml-2 hidden rounded border bg-muted px-1.5 text-[10px] font-mono text-muted-foreground md:inline">3</kbd>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
