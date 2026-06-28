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

// Public landing page. Render-style marketing surface: pure-black
// canvas, large bold typography, violet accents, feature cards with a
// subtle dot-grid background. Forced dark regardless of the user's
// theme — this page is a landing surface and should always read the
// same way. Other routes still honour the light/dark toggle via the
// shell layout in App.tsx.

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

// Subtle dot-grid background, matches the dotted-pixel pattern in the
// Render screenshot. Applied via inline style so it can be composed
// with Tailwind classes without polluting tailwind.config.
const DOT_GRID_STYLE = {
  backgroundImage:
    "radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)",
  backgroundSize: "16px 16px",
};

export function LandingPage() {
  return (
    // `dark` class is redundant globally now (site is always dark) but
    // kept on this root so the page is self-contained if ever rendered
    // outside the main app shell.
    //
    // Stack order:
    //   z-0  ParticleBackground (fixed to viewport, drifts as user scrolls)
    //   z-10 page content — every section sets `relative z-10` so it
    //        floats above the dots. Sections use translucent or
    //        gradient bgs so the field shows through.
    <div className="dark relative min-h-screen bg-black text-white">
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
    <header className="sticky top-0 z-40 border-b border-white/10 bg-black/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-violet-500 text-[10px] font-bold text-white">
            RA
          </span>
          <span className="font-semibold tracking-tight">ReviewArena</span>
        </Link>
        <nav className="hidden items-center gap-7 text-sm text-white/70 md:flex">
          <Link to="/leaderboard" className="transition-colors hover:text-white">
            Leaderboard
          </Link>
          <Link to="/admin" className="transition-colors hover:text-white">
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
    <section className="relative overflow-hidden border-b border-white/10">
      {/* Ambient violet glow behind the headline — sits above the
          page-wide particle canvas so the bloom tints the dots near
          the centre. The canvas itself lives at the page root. */}
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
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-white/70">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Blind pairwise comparison for AI peer reviewers
          </span>
          <h1 className="max-w-4xl text-5xl font-bold leading-[1.05] tracking-tight md:text-6xl lg:text-7xl">
            Which AI writes the better{" "}
            <span className="bg-gradient-to-br from-violet-300 to-violet-500 bg-clip-text text-transparent">
              peer review?
            </span>
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed text-white/70">
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
              className="inline-flex items-center gap-2 rounded-md border border-white/20 bg-white/5 px-6 py-3 text-base font-medium text-white transition-colors hover:bg-white/10"
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
    <div className="mt-8 grid w-full max-w-3xl grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 md:grid-cols-4">
      {items.map((s) => (
        // Translucent fill + backdrop-blur so the drifting dots show
        // through but the numbers stay legible.
        <div
          key={s.label}
          className="bg-black/40 px-4 py-5 text-center backdrop-blur-sm"
        >
          <div className="text-2xl font-semibold tracking-tight">{s.value}</div>
          <div className="mt-1 text-xs uppercase tracking-wide text-white/50">
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
    <section className="border-b border-white/10">
      <div className="mx-auto max-w-7xl px-6 py-20 lg:py-28">
        <div className="mb-12 max-w-3xl">
          <div className="text-sm font-medium uppercase tracking-wide text-violet-400">
            How it works
          </div>
          <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">
            Research-grade evaluation, designed for thesis-scale data
          </h2>
          <p className="mt-4 text-white/60">
            Every component — pair selection, voting, scoring, ranking — is
            built to produce defensible signal across hundreds of papers.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 md:grid-cols-2">
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
    <div className="group relative overflow-hidden bg-black/40 p-8 backdrop-blur-sm transition-colors hover:bg-white/[0.04] md:p-10">
      {/* Dot-grid backdrop in the upper-right corner, matching the
          Render aesthetic. Pointer-events-none so the link below is
          still clickable across the whole card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 top-0 h-48 w-1/2 opacity-60"
        style={DOT_GRID_STYLE}
      />
      <div className="relative">
        <div className="mb-6 inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/10 bg-white/5 text-violet-300">
          <Icon className="h-5 w-5" />
        </div>
        <h3 className="text-2xl font-semibold leading-tight tracking-tight md:text-3xl">
          {title}
        </h3>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-white/60">
          {body}
        </p>
        <Link
          to={link.to}
          className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-violet-400 transition-colors hover:text-violet-300"
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
    <section className="border-b border-white/10">
      <div className="mx-auto max-w-7xl px-6 py-20 lg:py-28">
        <div
          className="relative overflow-hidden rounded-2xl border border-white/10 p-10 md:p-16"
          style={{
            background:
              "radial-gradient(ellipse 70% 80% at 50% 0%, rgba(139, 92, 246, 0.20), transparent 70%), #0a0a0a",
          }}
        >
          <div className="relative max-w-2xl">
            <h2 className="text-3xl font-bold tracking-tight md:text-5xl">
              Ready to put the reviewers to the test?
            </h2>
            <p className="mt-4 text-white/60">
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

// ─── Footer ────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t border-white/5">
      <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-3 px-6 py-8 text-xs text-white/40 md:flex-row md:items-center">
        <div>ReviewArena · thesis build · single-tenant</div>
        <div className="flex items-center gap-5">
          <Link to="/leaderboard" className="transition-colors hover:text-white/70">
            Leaderboard
          </Link>
          <Link to="/admin" className="transition-colors hover:text-white/70">
            Admin
          </Link>
        </div>
      </div>
    </footer>
  );
}
