import { useMemo } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
} from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  VOTE_DIMENSIONS,
  DIMENSION_LABELS,
  type SubmitVoteResponse,
  type RevealSide,
} from "@reviewarena/shared-types";
import { getReveal } from "@/lib/api";

type RevealHeader = SubmitVoteResponse["reveal"];

const PLACEHOLDER_HEADER: RevealHeader = {
  reviewA: {
    reviewId: "rev-a",
    systemSlug: "gpt-5-mini",
    systemName: "GPT-5-mini",
    eloBefore: 1100,
    eloAfter: 1112,
  },
  reviewB: {
    reviewId: "rev-b",
    systemSlug: "gemini-2.5-flash",
    systemName: "Gemini 2.5 Flash",
    eloBefore: 1080,
    eloAfter: 1068,
  },
};

export function RevealPage() {
  const [params] = useSearchParams();
  const voteId = params.get("voteId");

  const header = useMemo<RevealHeader>(() => {
    const raw = params.get("state");
    if (!raw) return PLACEHOLDER_HEADER;
    try {
      return JSON.parse(decodeURIComponent(raw)) as RevealHeader;
    } catch {
      return PLACEHOLDER_HEADER;
    }
  }, [params]);

  // ClaimChecks + per-dimension judge scores are fetched by voteId. The
  // score job may still be running when the user lands here — refetch every
  // 3s while empty, then stop.
  const revealQuery = useQuery({
    queryKey: ["reveal", voteId],
    queryFn: () => getReveal(voteId!),
    enabled: !!voteId,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return 3000;
      const hasAnyData =
        d.reviewA.claims.length > 0 ||
        d.reviewB.claims.length > 0 ||
        d.reviewA.judgeDimensions ||
        d.reviewB.judgeDimensions;
      return hasAnyData ? false : 3000;
    },
    retry: 1,
  });

  const usingPlaceholder = !params.get("state");
  const detail = revealQuery.data;
  const scoringPending = !!voteId && (!detail || !detail.reviewA.judgeDimensions);

  const radarData = VOTE_DIMENSIONS.map((d) => ({
    dimension: DIMENSION_LABELS[d],
    A: detail?.reviewA.judgeDimensions?.[d] ?? 0,
    B: detail?.reviewB.judgeDimensions?.[d] ?? 0,
  }));

  const aDelta = header.reviewA.eloAfter - header.reviewA.eloBefore;
  const winnerLabel =
    Math.abs(aDelta) < 0.01
      ? "Tie"
      : aDelta > 0
      ? `${header.reviewA.systemName} (A)`
      : `${header.reviewB.systemName} (B)`;

  return (
    <div className="container py-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Vote recorded · you preferred
          </div>
          <h1 className="text-3xl font-semibold tracking-tight mt-1">{winnerLabel}</h1>
          <p className="text-muted-foreground mt-2">
            Systems revealed below, along with how the LLM-as-judge sees the same
            reviews.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {usingPlaceholder && <Badge variant="outline">placeholder</Badge>}
          <Button asChild>
            <Link to="/compare">Next comparison →</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <RevealCard slot="A" reveal={header.reviewA} detail={detail?.reviewA} />
        <RevealCard slot="B" reveal={header.reviewB} detail={detail?.reviewB} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">LLM-as-judge dimension scores</CardTitle>
          <CardDescription>
            {scoringPending
              ? "Scoring in progress — this will populate within a few seconds."
              : "0–10 per dimension from the judge model. Higher is better."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[420px]">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={radarData}>
                <PolarGrid />
                <PolarAngleAxis dataKey="dimension" />
                <PolarRadiusAxis angle={30} domain={[0, 10]} />
                {/* Neutral A/B palette — blue + amber. Using `--destructive`
                    red for Review B mis-signals "B is worse" before the user
                    has read either side. */}
                <Radar
                  name="Review A"
                  dataKey="A"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.3}
                />
                <Radar
                  name="Review B"
                  dataKey="B"
                  stroke="#f59e0b"
                  fill="#f59e0b"
                  fillOpacity={0.2}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Paper-grounded verifiability</CardTitle>
          <CardDescription>
            Each claim each review makes, checked by an LLM-as-judge against the
            paper text.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <ClaimList label="Review A" side={detail?.reviewA} pending={scoringPending} />
          <ClaimList label="Review B" side={detail?.reviewB} pending={scoringPending} />
        </CardContent>
      </Card>

      <div className="flex justify-between gap-3 pt-2">
        <Button variant="outline" asChild>
          <Link to="/leaderboard">← Back to leaderboard</Link>
        </Button>
        <Button asChild>
          <Link to="/compare">Next comparison →</Link>
        </Button>
      </div>
    </div>
  );
}

function RevealCard({
  slot,
  reveal,
  detail,
}: {
  slot: "A" | "B";
  reveal: RevealHeader["reviewA"];
  detail?: RevealSide;
}) {
  const delta = reveal.eloAfter - reveal.eloBefore;
  const positive = delta >= 0;
  const verifPct =
    detail?.verifiabilityFraction != null
      ? Math.round(detail.verifiabilityFraction * 100)
      : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs uppercase">
              {slot}
            </span>
            <span>{reveal.systemName}</span>
          </div>
          <Badge variant="secondary">{reveal.systemSlug}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-baseline gap-3">
          <div className="font-mono text-3xl">{Math.round(reveal.eloAfter)}</div>
          <div
            className={`font-mono text-sm ${
              positive ? "text-emerald-600" : "text-destructive"
            }`}
          >
            {positive ? "+" : ""}
            {delta.toFixed(1)} Elo
          </div>
          <div className="ml-auto font-mono text-xs text-muted-foreground">
            was {Math.round(reveal.eloBefore)}
          </div>
        </div>

        {(detail?.judgeOverall != null || verifPct != null) && (
          <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <div>
              <div className="text-xs uppercase text-muted-foreground">Judge overall</div>
              <div className="font-mono">
                {detail?.judgeOverall != null
                  ? `${detail.judgeOverall.toFixed(1)} / 10`
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">Verifiable claims</div>
              <div className="font-mono">{verifPct != null ? `${verifPct}%` : "—"}</div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const VERDICT_STYLES: Record<RevealSide["claims"][number]["verdict"], string> = {
  SUPPORTED: "bg-emerald-100 text-emerald-900 border-emerald-300",
  CONTRADICTED: "bg-red-100 text-red-900 border-red-300",
  UNSUPPORTED: "bg-amber-100 text-amber-900 border-amber-300",
};

const VERDICT_SHORT: Record<RevealSide["claims"][number]["verdict"], string> = {
  SUPPORTED: "✓",
  CONTRADICTED: "✗",
  UNSUPPORTED: "?",
};

function ClaimList({
  label,
  side,
  pending,
}: {
  label: string;
  side?: RevealSide;
  pending: boolean;
}) {
  const counts =
    side?.claims.reduce<Record<string, number>>(
      (acc, c) => ({ ...acc, [c.verdict]: (acc[c.verdict] ?? 0) + 1 }),
      {},
    ) ?? {};
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">{label}</div>
        {side && side.claims.length > 0 && (
          <div className="flex gap-1 text-xs">
            {(["SUPPORTED", "CONTRADICTED", "UNSUPPORTED"] as const).map((k) =>
              counts[k] ? (
                <span
                  key={k}
                  className={`rounded border px-1.5 py-0.5 font-mono ${VERDICT_STYLES[k]}`}
                  title={k}
                >
                  {VERDICT_SHORT[k]} {counts[k]}
                </span>
              ) : null,
            )}
          </div>
        )}
      </div>
      {!side || side.claims.length === 0 ? (
        <div className="rounded-md border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
          {pending ? "Judging claims…" : "No claims extracted."}
        </div>
      ) : (
        <ul className="space-y-2">
          {side.claims.map((c, i) => (
            <li key={i} className="rounded-md border px-3 py-2 text-sm">
              <div className="flex items-start gap-2">
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-xs ${VERDICT_STYLES[c.verdict]}`}
                  title={c.verdict}
                >
                  {VERDICT_SHORT[c.verdict]}
                </span>
                <div className="flex-1">{c.claim}</div>
              </div>
              {c.evidence && (
                <div className="mt-2 border-l-2 border-muted-foreground/20 pl-3 text-xs text-muted-foreground">
                  {c.evidence}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
