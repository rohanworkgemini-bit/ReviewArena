import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2, Check } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getPaperStatus, setPaperScope, type PaperStatus } from "@/lib/api";
import { cn } from "@/lib/cn";

// Matches FAIR_INPUT_TOKENS in services/review-gen/app/adapters/_budget.py.
// If the canonical budget changes server-side this should change too —
// keep them in sync. (Could be exposed via /healthz if we want to skip
// the duplication later.)
const FAIR_INPUT_TOKENS = 11_000;
// Reserve ~800 tokens for title + abstract + scope notice + a small slack
// so the picker is honest about what the model will actually fit.
const SCOPE_OVERHEAD_TOKENS = 800;
const SECTIONS_BUDGET = FAIR_INPUT_TOKENS - SCOPE_OVERHEAD_TOKENS;

// Sections to pre-select when we first land on the page: anything that
// looks like introduction / method / result / conclusion. Tuned to be
// good defaults for an academic paper — user can toggle freely.
const DEFAULT_INCLUDE_PATTERNS = [
  /introduction/i,
  /method/i,
  /approach/i,
  /architecture/i,
  /experiment/i,
  /result/i,
  /finding/i,
  /conclusion/i,
  /discussion/i,
  /limitation/i,
  /summary/i,
];

function shouldDefaultInclude(heading: string): boolean {
  return DEFAULT_INCLUDE_PATTERNS.some((re) => re.test(heading));
}

function pickDefaults(sections: PaperStatus["sections"]): Set<number> {
  // First pass: include anything matching a default pattern.
  const initial = new Set<number>();
  for (const s of sections) {
    if (shouldDefaultInclude(s.heading)) initial.add(s.id);
  }
  // If the matching set fits the budget, use it.
  // Otherwise drop the lowest-priority matches (we treat document-order
  // late sections as lower priority — appendices come last).
  const total = sections.reduce((sum, s) => sum + (initial.has(s.id) ? s.approxTokens : 0), 0);
  if (total <= SECTIONS_BUDGET) return initial;
  // Trim from the back until under budget.
  const ordered = [...initial].sort((a, b) => b - a);   // largest id first
  let running = total;
  for (const id of ordered) {
    if (running <= SECTIONS_BUDGET) break;
    const sec = sections.find((s) => s.id === id);
    if (!sec) continue;
    initial.delete(id);
    running -= sec.approxTokens;
  }
  return initial;
}

export function ScopePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const paperId = params.get("paperId");

  const queryRes = useQuery({
    queryKey: ["paper-scope", paperId],
    queryFn: () => getPaperStatus(paperId!),
    enabled: !!paperId,
    // Poll while the paper is still being parsed — sections only land
    // once status flips to PARSED.
    refetchInterval: (q) =>
      q.state.data?.status === "PARSED" || q.state.data?.status === "FAILED" ? false : 1500,
  });
  const paper = queryRes.data;

  const [picked, setPicked] = useState<Set<number> | null>(null);
  // When the paper first finishes parsing, seed the picker with smart defaults.
  useEffect(() => {
    if (paper && paper.status === "PARSED" && picked === null && paper.sections.length > 0) {
      setPicked(pickDefaults(paper.sections));
    }
  }, [paper, picked]);

  // Dedup-hit short-circuit: if this paper already has completed reviews
  // (e.g. the user navigated back from /compare after they finished), the
  // scope can no longer be changed — the model already saw what it saw.
  // Skip the picker and route the user straight to the comparison view.
  useEffect(() => {
    if (!paper || !paperId) return;
    if (paper.completedReviewCount > 0) {
      navigate(`/compare?paperId=${paperId}`, { replace: true });
    }
  }, [paper, paperId, navigate]);

  const totalTokens = useMemo(() => {
    if (!paper || !picked) return 0;
    return paper.sections.reduce(
      (sum, s) => sum + (picked.has(s.id) ? s.approxTokens : 0),
      0,
    );
  }, [paper, picked]);

  const overBudget = totalTokens > SECTIONS_BUDGET;
  const pickedCount = picked?.size ?? 0;

  const scopeMutation = useMutation({
    mutationFn: async (ids: number[] | null) => {
      if (!paperId) throw new Error("paperId missing");
      return setPaperScope(paperId, ids);
    },
    onSuccess: () => {
      navigate(`/compare?paperId=${paperId}`);
    },
  });

  if (!paperId) {
    return (
      <div className="container max-w-2xl py-10">
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Missing paperId — start from <a className="underline" href="/upload">/upload</a>.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!paper || paper.status === "PROCESSING" || paper.status === "PENDING" || paper.status === "PARSING") {
    return (
      <div className="container max-w-2xl py-10">
        <Card>
          <CardContent className="py-10 flex flex-col items-center gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <div className="text-sm text-muted-foreground">
              Parsing your paper… this usually takes 5–30 seconds.
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (paper.status === "PARSE_FAILED" || paper.status === "FAILED") {
    return (
      <div className="container max-w-2xl py-10">
        <Card>
          <CardContent className="py-8 text-center space-y-3">
            <div className="text-destructive font-medium">Parse failed</div>
            <div className="text-sm text-muted-foreground">
              Couldn't extract usable text from this paper. Try a different
              paper, or upload the PDF directly if you submitted an arXiv link
              (or vice versa).
            </div>
            <Button variant="outline" onClick={() => navigate("/upload")}>
              Back to upload
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (paper.sections.length === 0) {
    // PARSED but with no sections — short paper or unusual structure.
    // Skip the picker; just send the full paper.
    return (
      <div className="container max-w-2xl py-10">
        <Card>
          <CardContent className="py-8 space-y-3 text-center">
            <div className="text-sm text-muted-foreground">
              No sections detected — the reviewer will see the full paper.
            </div>
            <Button
              onClick={() => scopeMutation.mutate(null)}
              disabled={scopeMutation.isPending}
            >
              {scopeMutation.isPending ? "Starting…" : "Generate review"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  function togglePick(id: number) {
    setPicked((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    if (!paper) return;
    setPicked(new Set(paper.sections.map((s) => s.id)));
  }

  function selectNone() {
    setPicked(new Set());
  }

  function selectDefaults() {
    if (!paper) return;
    setPicked(pickDefaults(paper.sections));
  }

  return (
    <div className="container max-w-3xl py-10 pb-32 space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Pick sections to review
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {paper.title ?? "Untitled paper"} · {paper.pageCount ?? "?"} pages ·
          {" "}
          {paper.sections.length} sections detected
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Both reviewing systems will see the <strong>same selection</strong>,
          at full fidelity. Sections you uncheck are listed for the model in a
          scope notice so it knows to limit its review and not speculate about
          omitted content.
        </p>
      </div>

      {/* Budget meter */}
      <Card>
        <CardContent className="py-4 space-y-2">
          <div className="flex items-baseline justify-between gap-4">
            <div className="text-sm">
              <span className={cn("font-mono tabular-nums", overBudget && "text-destructive")}>
                {totalTokens.toLocaleString()}
              </span>
              <span className="text-muted-foreground"> / {SECTIONS_BUDGET.toLocaleString()} tokens used</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {pickedCount} of {paper.sections.length} sections selected
            </div>
          </div>
          <div className="h-2 w-full overflow-hidden rounded bg-muted">
            <div
              className={cn(
                "h-full transition-all",
                overBudget ? "bg-destructive" : "bg-primary",
              )}
              style={{
                width: `${Math.min(100, (totalTokens / SECTIONS_BUDGET) * 100)}%`,
              }}
            />
          </div>
          {overBudget && (
            <div className="text-xs text-destructive">
              Over budget — deselect sections until under the line. The
              reviewer would otherwise drop tail content silently.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick presets */}
      <div className="flex gap-2 text-sm">
        <Button variant="outline" size="sm" onClick={selectAll}>Select all</Button>
        <Button variant="outline" size="sm" onClick={selectNone}>Select none</Button>
        <Button variant="outline" size="sm" onClick={selectDefaults}>Smart defaults</Button>
      </div>

      {/* Section list */}
      <Card>
        <CardContent className="py-2 px-0 divide-y divide-border">
          {paper.sections.map((s) => {
            const checked = picked?.has(s.id) ?? false;
            const indent = Math.max(0, s.level - 2) * 16;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => togglePick(s.id)}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50",
                  checked && "bg-muted/30",
                )}
              >
                <div
                  className={cn(
                    "h-5 w-5 flex-shrink-0 rounded border-2 transition-colors",
                    checked
                      ? "border-primary bg-primary text-primary-foreground flex items-center justify-center"
                      : "border-muted-foreground/40",
                  )}
                >
                  {checked && <Check className="h-3.5 w-3.5" />}
                </div>
                <div
                  className="flex-1 min-w-0"
                  style={{ paddingLeft: `${indent}px` }}
                >
                  <div className="font-medium truncate">{s.heading}</div>
                </div>
                <Badge variant="secondary" className="font-mono tabular-nums text-xs">
                  ~{s.approxTokens.toLocaleString()} tk
                </Badge>
              </button>
            );
          })}
        </CardContent>
      </Card>

      {/* Sticky action bar */}
      <div className="fixed bottom-0 left-[var(--sidebar-w)] right-0 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="container max-w-3xl py-3 flex items-center justify-between gap-4">
          <div className="text-xs text-muted-foreground">
            Title + abstract always included. {SCOPE_OVERHEAD_TOKENS} tokens
            reserved for scope notice & overhead.
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => scopeMutation.mutate(null)}
              disabled={scopeMutation.isPending}
            >
              Review whole paper
            </Button>
            <Button
              onClick={() => {
                if (!picked) return;
                scopeMutation.mutate([...picked].sort((a, b) => a - b));
              }}
              disabled={
                scopeMutation.isPending ||
                overBudget ||
                pickedCount === 0
              }
            >
              {scopeMutation.isPending ? "Starting reviews…" : "Generate reviews"}
            </Button>
          </div>
        </div>
      </div>

      {scopeMutation.isError && (
        <div className="text-sm text-destructive">
          {(scopeMutation.error as Error).message || "Failed to set scope."}
        </div>
      )}
    </div>
  );
}
