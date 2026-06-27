import { Link } from "react-router-dom";
import {
  ArrowRight,
  FileUp,
  Eye,
  Vote,
  Trophy,
  Sparkles,
  Scale,
  ShieldCheck,
  BarChart3,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

// Public landing page. First thing a new visitor sees. Three jobs:
//   1. Explain what ReviewArena is in one sentence
//   2. Show the 3-step user flow so they know what they're getting into
//   3. Surface the methodology cred (8 systems, blind comparison, Elo)
//      enough to feel research-grade without being a paper abstract.
// Keep the page to one scroll on a 14" laptop.

interface Step {
  icon: LucideIcon;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    icon: FileUp,
    title: "Upload a paper",
    body: "Drop a PDF or paste an arXiv URL. The paper is parsed and queued for review by two anonymous AI systems.",
  },
  {
    icon: Eye,
    title: "Read both reviews",
    body: "Two structured reviews stream in side-by-side. Identities are hidden — you judge the content, not the brand.",
  },
  {
    icon: Vote,
    title: "Vote your preference",
    body: "Pick A, B, or call it a tie — overall or per-dimension. Your vote updates each system's Elo rating on the leaderboard.",
  },
];

interface Fact {
  icon: LucideIcon;
  label: string;
  value: string;
}

const FACTS: Fact[] = [
  { icon: Sparkles, label: "Reviewer systems", value: "8 AIs" },
  { icon: Scale, label: "Scoring dimensions", value: "8 axes" },
  { icon: ShieldCheck, label: "Comparison", value: "Blind pairwise" },
  { icon: BarChart3, label: "Ranking", value: "Bootstrap Elo" },
];

export function LandingPage() {
  return (
    <div className="container max-w-5xl py-12 lg:py-20">
      {/* ─── Hero ─────────────────────────────────────────────────── */}
      <div className="flex flex-col items-start gap-6">
        <Badge variant="outline" className="gap-1.5">
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Blind pairwise comparison for AI peer reviewers
        </Badge>

        <h1 className="text-4xl font-bold leading-tight tracking-tight lg:text-5xl">
          Which AI writes the{" "}
          <span className="bg-gradient-to-br from-foreground to-foreground/60 bg-clip-text text-transparent">
            better peer review?
          </span>
        </h1>

        <p className="max-w-2xl text-base text-muted-foreground lg:text-lg">
          ReviewArena puts modern AI reviewer systems head-to-head on real
          papers. Upload a paper, read two anonymous reviews side-by-side, and
          vote which one is more useful. Your vote updates each system's Elo
          rating — a transparent, peer-driven ranking instead of marketing claims.
        </p>

        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg" className="gap-2">
            <Link to="/upload">
              Start a comparison
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="gap-2">
            <Link to="/leaderboard">
              <Trophy className="h-4 w-4" />
              See the leaderboard
            </Link>
          </Button>
        </div>
      </div>

      {/* ─── How it works ─────────────────────────────────────────── */}
      <section className="mt-16 lg:mt-24">
        <div className="mb-6 flex items-baseline justify-between gap-4">
          <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
          <span className="text-sm text-muted-foreground">
            About 2 minutes per paper
          </span>
        </div>

        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className="rounded-lg border bg-card p-5 transition-colors hover:border-foreground/20"
            >
              <div className="mb-3 flex items-center justify-between">
                <div className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background">
                  <step.icon className="h-4 w-4" />
                </div>
                <span className="text-xs font-medium text-muted-foreground">
                  Step {i + 1}
                </span>
              </div>
              <h3 className="mb-1.5 font-medium">{step.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {step.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* ─── Key facts ────────────────────────────────────────────── */}
      <section className="mt-12">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {FACTS.map((fact) => (
            <div
              key={fact.label}
              className="rounded-lg border bg-card p-4 text-center"
            >
              <fact.icon className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
              <div className="text-lg font-semibold tracking-tight">
                {fact.value}
              </div>
              <div className="text-xs text-muted-foreground">{fact.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ─── Methodology note ─────────────────────────────────────── */}
      <section className="mt-12 rounded-lg border bg-muted/30 p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-8">
          <div className="max-w-2xl">
            <h2 className="mb-2 text-base font-semibold tracking-tight">
              Built for peer-review research
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Every reviewer system sees the same canonical paper text under a
              fixed token budget (FAIRNESS contract). Pair selection mitigates
              position bias via per-pair coin-flip A/B randomization (Zheng et
              al. 2023). An LLM-as-judge scores each review across 8 dimensions
              with chain-of-thought reasoning (Liu et al. 2023, G-Eval) and
              verifies factual claims against the paper.
            </p>
          </div>
          <Button asChild variant="ghost" size="sm" className="gap-2 shrink-0">
            <Link to="/dev">
              API & methodology
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </section>

      {/* ─── Closing CTA ──────────────────────────────────────────── */}
      <div className="mt-12 flex flex-col items-center gap-3 border-t pt-10 text-center">
        <p className="text-sm text-muted-foreground">
          Ready to put the reviewers to the test?
        </p>
        <Button asChild size="lg" className="gap-2">
          <Link to="/upload">
            Upload your first paper
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
