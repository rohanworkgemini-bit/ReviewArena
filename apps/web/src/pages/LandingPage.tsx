import { Link } from "react-router-dom";
import {
  ArrowRight,
  Trophy,
  type LucideIcon,
  Layers,
  Sliders,
  Bot,
  LineChart,
} from "lucide-react";
import { ParticleBackground } from "@/components/ParticleBackground";
import { Footer } from "@/components/layout/Footer";

// Public landing page. Render-style marketing surface: bold typography,
// violet accent throughout, feature cards with a subtle dot-grid
// backdrop, drifting particle field behind everything. Now uses design
// tokens (bg-background / text-foreground / border / muted-foreground)
// so it adapts to both light + dark mode along with the rest of the
// app. Violet (the brand color) is constant across modes.

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
  link: { to: string; label: string };
}

const FEATURES: Feature[] = [
  {
    icon: Layers,
    title: "Blind pairwise comparison",
    body: "Every paper is reviewed by two anonymous AI systems chosen by exposure-weighted sampling. You read the reviews side-by-side without identities — the content does the talking, not the brand.",
    link: { to: "/upload", label: "Start a comparison" },
  },
  {
    icon: Sliders,
    title: "Eight dimensions per vote",
    body: "Beyond a single overall verdict, every vote captures preference on Comprehensiveness, Clarity, Fairness, Actionability, Constructiveness, Objectivity, Relevance and Technical Terms. Each axis gets its own Elo ladder.",
    link: { to: "/leaderboard", label: "Open the leaderboard" },
  },
  {
    icon: Bot,
    title: "LLM-as-judge auto-scoring",
    body: "An independent meta-judge scores every review with chain-of-thought reasoning (Liu et al. 2023, G-Eval), double-pass averaged and length-controlled — automatic signal layered on top of human pairwise votes.",
    link: { to: "/leaderboard", label: "See judge scores" },
  },
  {
    icon: LineChart,
    title: "Bootstrap Elo, not vibes",
    body: "Rankings are computed via Bradley–Terry MLE per dimension with bootstrap confidence intervals — a transparent, peer-driven ranking instead of marketing claims or hand-picked anecdotes.",
    link: { to: "/leaderboard", label: "View the ladder" },
  },
];

export function LandingPage() {
  // Stack order:
  //   z-0  ParticleBackground (fixed to viewport, drifts as user scrolls)
  //   z-10 page content — every section sets `relative z-10` so it
  //        floats above the dots. Sections use translucent or gradient
  //        bgs so the field shows through.
  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <ParticleBackground variant="fixed" />
      <div className="relative z-10">
        <TopBar />
        <Hero />
        <FeatureGrid />
        <ClosingCTA />
        <Footer />
      </div>
    </div>
  );
}

// ─── Top bar ───────────────────────────────────────────────────────────────

function TopBar() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2">
          <img src="/favicon-32x32.png" alt="" aria-hidden className="h-7 w-7" />
          <span className="font-semibold tracking-tight">ReviewArena</span>
        </Link>
        <nav className="hidden items-center gap-7 text-sm text-muted-foreground md:flex">
          <Link to="/leaderboard" className="transition-colors hover:text-foreground">
            Leaderboard
          </Link>
          <Link to="/admin" className="transition-colors hover:text-foreground">
            Admin
          </Link>
        </nav>
        <div className="flex items-center gap-2">
          <Link
            to="/upload"
            className="hidden rounded-md bg-violet-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-400 md:inline-block"
          >
            Start comparing
          </Link>
          <Link
            to="/upload"
            className="rounded-md bg-violet-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-400 md:hidden"
          >
            Start
          </Link>
        </div>
      </div>
    </header>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative overflow-hidden border-b">
      {/* Ambient violet glow behind the headline. Semi-transparent
          violet composites correctly over both light and dark canvases
          (just reads as a softer bloom on light). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(139, 92, 246, 0.18), transparent 60%)",
        }}
      />
      <div className="relative mx-auto max-w-7xl px-6 py-24 lg:py-32">
        <div className="flex flex-col items-center gap-8 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border bg-card/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Blind pairwise comparison for AI peer reviewers
          </span>
          <h1 className="max-w-4xl text-5xl font-bold leading-[1.05] tracking-tight md:text-6xl lg:text-7xl">
            Which AI writes the better{" "}
            <span className="bg-gradient-to-br from-violet-400 to-violet-600 bg-clip-text text-transparent">
              peer review?
            </span>
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground">
            ReviewArena puts modern AI reviewer systems head-to-head on real
            papers. Upload a paper, read two anonymous reviews side-by-side,
            and rate every dimension — your votes drive a transparent Elo
            ladder instead of marketing claims.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/upload"
              className="inline-flex items-center gap-2 rounded-md bg-violet-500 px-6 py-3 text-base font-medium text-white transition-colors hover:bg-violet-400"
            >
              Start comparing
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/leaderboard"
              className="inline-flex items-center gap-2 rounded-md border bg-card/60 px-6 py-3 text-base font-medium text-foreground backdrop-blur-sm transition-colors hover:bg-accent"
            >
              <Trophy className="h-4 w-4" />
              See the leaderboard
            </Link>
          </div>
          <StatsRow />
        </div>
      </div>
    </section>
  );
}

function StatsRow() {
  const items = [
    { value: "8", label: "Reviewer systems" },
    { value: "8", label: "Voting dimensions" },
    { value: "Bootstrap", label: "Elo CIs" },
    { value: "Blind", label: "Pair selection" },
  ];
  return (
    // gap-px + bg-border between cells gives a hairline grid effect
    // that respects the current border color in both modes.
    <div className="mt-8 grid w-full max-w-3xl grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
      {items.map((s) => (
        // Translucent fill + backdrop-blur so the drifting dots show
        // through but the numbers stay legible. bg-card/60 picks up
        // the theme so dark = #0a0a0a/60, light = white/60.
        <div
          key={s.label}
          className="bg-card/60 px-4 py-5 text-center backdrop-blur-sm"
        >
          <div className="text-2xl font-semibold tracking-tight">{s.value}</div>
          <div className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
            {s.label}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Feature grid ──────────────────────────────────────────────────────────

function FeatureGrid() {
  return (
    <section className="border-b">
      <div className="mx-auto max-w-7xl px-6 py-20 lg:py-28">
        <div className="mb-12 max-w-3xl">
          <div className="text-sm font-medium uppercase tracking-wide text-violet-500">
            How it works
          </div>
          <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">
            Research-grade evaluation, designed for thesis-scale data
          </h2>
          <p className="mt-4 text-muted-foreground">
            Every component — pair selection, voting, scoring, ranking — is
            built to produce defensible signal across hundreds of papers.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border bg-border md:grid-cols-2">
          {FEATURES.map((f) => (
            <FeatureCard key={f.title} feature={f} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({ feature }: { feature: Feature }) {
  const { icon: Icon, title, body, link } = feature;
  return (
    // Translucent so the page-wide dot field shows through; backdrop-
    // blur softens the dots inside the cards so text stays readable.
    <div className="group relative overflow-hidden bg-card/60 p-8 backdrop-blur-sm transition-colors hover:bg-accent/50 md:p-10">
      {/* Dot-grid backdrop in the upper-right corner. Uses the
          bg-dot-grid utility which reads --dot-grid-color from the
          theme variables (white-tint on dark, black-tint on light). */}
      <div
        aria-hidden
        className="bg-dot-grid pointer-events-none absolute right-0 top-0 h-48 w-1/2 opacity-60"
      />
      <div className="relative">
        <div className="mb-6 inline-flex h-10 w-10 items-center justify-center rounded-md border bg-card text-violet-500 dark:text-violet-300">
          <Icon className="h-5 w-5" />
        </div>
        <h3 className="text-2xl font-semibold leading-tight tracking-tight md:text-3xl">
          {title}
        </h3>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
        <Link
          to={link.to}
          className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-violet-500 transition-colors hover:text-violet-400 dark:text-violet-400 dark:hover:text-violet-300"
        >
          {link.label}
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </div>
  );
}

// ─── Closing CTA ───────────────────────────────────────────────────────────

function ClosingCTA() {
  return (
    <section className="border-b">
      <div className="mx-auto max-w-7xl px-6 py-20 lg:py-28">
        {/* Inline radial gradient over bg-card so the violet bloom sits
            on top of a theme-aware base (light = white card, dark =
            #0a0a0a). Two layers: violet glow first, then a transparent
            fallback so anywhere the glow fades out we see bg-card. */}
        <div
          className="relative overflow-hidden rounded-2xl border bg-card p-10 md:p-16"
          style={{
            backgroundImage:
              "radial-gradient(ellipse 70% 80% at 50% 0%, rgba(139, 92, 246, 0.20), transparent 70%)",
          }}
        >
          <div className="relative max-w-2xl">
            <h2 className="text-3xl font-bold tracking-tight md:text-5xl">
              Ready to put the reviewers to the test?
            </h2>
            <p className="mt-4 text-muted-foreground">
              Drop a PDF or paste an arXiv URL. Two reviews stream in. You
              decide which one would actually help an author improve their
              paper.
            </p>
            <div className="mt-8">
              <Link
                to="/upload"
                className="inline-flex items-center gap-2 rounded-md bg-violet-500 px-6 py-3 text-base font-medium text-white transition-colors hover:bg-violet-400"
              >
                Start comparing
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// Footer is imported from components/layout/Footer.tsx — same component
// used by the AppShell, so the chrome stays consistent across the app.
