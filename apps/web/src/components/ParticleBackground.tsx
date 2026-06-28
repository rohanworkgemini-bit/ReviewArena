import { useEffect, useRef } from "react";

// Drifting dot field for the landing surface. Canvas-based so we get
// hundreds of dots cheap — one DOM node, one rAF loop, no per-particle
// reflow. The look matches the Render / Inngest hero pattern: most dots
// are dim white with a smaller fraction tinted violet so the field
// reads as a starfield through the brand color.
//
// Two layout modes, controlled by `variant`:
//   - "absolute" (default): canvas fills its nearest positioned parent.
//     Use inside a `relative` section so the dots are scoped there.
//   - "fixed": canvas pins to the viewport, so the field stays put
//     while the page scrolls. ONE viewport-sized canvas keeps it cheap
//     regardless of page length.
//
// Honors prefers-reduced-motion: when set, dots render in a single
// static frame and the rAF loop never starts.

interface Particle {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  // Twinkle phase so opacity oscillates per-particle out of sync.
  phase: number;
  speed: number;
  // 0 = white/gray, 1 = violet. Drawn lookup; never changes.
  hue: 0 | 1;
}

const COUNT_PER_MEGAPIXEL = 110;     // dots scale with viewport area
const MIN_COUNT = 80;                 // floor for tiny viewports
const MAX_COUNT = 260;                // ceiling — avoid pegging CPU on 4K
const VIOLET_RATIO = 0.32;            // share of dots tinted violet
const DRIFT_PX_PER_SEC = 6;           // top speed of dot drift

export function ParticleBackground({
  variant = "absolute",
}: {
  variant?: "absolute" | "fixed";
} = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let particles: Particle[] = [];
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let rafId = 0;
    let lastTs = 0;
    let running = true;

    const seed = (w: number, h: number) => {
      const mp = (w * h) / 1_000_000;
      const target = Math.max(
        MIN_COUNT,
        Math.min(MAX_COUNT, Math.round(mp * COUNT_PER_MEGAPIXEL)),
      );
      particles = Array.from({ length: target }, () => {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * DRIFT_PX_PER_SEC;
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          // Mostly small (1–1.6px), with a long tail of brighter "near"
          // dots (up to ~3px) — gives the field perceived depth.
          r: Math.random() < 0.85
            ? 0.6 + Math.random() * 1.0
            : 1.6 + Math.random() * 1.4,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          phase: Math.random() * Math.PI * 2,
          speed: 0.4 + Math.random() * 0.8, // twinkle rate
          hue: Math.random() < VIOLET_RATIO ? 1 : 0,
        };
      });
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed(rect.width, rect.height);
    };

    const draw = (w: number, h: number, tSec: number) => {
      // Re-read the theme each frame — cheap (one classList read) and
      // means we react instantly to the toggle without restarting the
      // rAF loop or re-seeding the particles.
      const isDark = document.documentElement.classList.contains("dark");
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        // Per-particle opacity sits in 0.25–1.0, drifting with a slow
        // sin wave. Bigger dots stay brighter so they read as "close."
        const base = 0.35 + Math.min(0.45, (p.r - 0.6) * 0.5);
        const twinkle = 0.25 * Math.sin(tSec * p.speed + p.phase);
        const alpha = Math.max(0.08, Math.min(1, base + twinkle));
        if (isDark) {
          if (p.hue === 1) {
            // violet-400 (#A78BFA) — pops on the black canvas.
            ctx.fillStyle = `rgba(167, 139, 250, ${alpha})`;
          } else {
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.85})`;
          }
        } else {
          // Light mode: black + violet-600 dots, capped at lower
          // opacity so the field is felt rather than seen on the
          // light-gray canvas.
          if (p.hue === 1) {
            // violet-600 (#7C3AED) — darker so it has contrast on light.
            ctx.fillStyle = `rgba(124, 58, 237, ${alpha * 0.6})`;
          } else {
            // True black, low opacity so dots read as soft texture.
            ctx.fillStyle = `rgba(0, 0, 0, ${alpha * 0.35})`;
          }
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const step = (ts: number) => {
      if (!running) return;
      const rect = canvas.getBoundingClientRect();
      const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
      lastTs = ts;

      // Advance + wrap around the canvas so the field is seamless.
      for (const p of particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < -2) p.x = rect.width + 2;
        else if (p.x > rect.width + 2) p.x = -2;
        if (p.y < -2) p.y = rect.height + 2;
        else if (p.y > rect.height + 2) p.y = -2;
      }
      draw(rect.width, rect.height, ts / 1000);
      rafId = requestAnimationFrame(step);
    };

    // ResizeObserver tracks the parent's size — covers layout changes
    // (sidebar collapse, font load, viewport rotate) without spamming
    // window.resize listeners.
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
    resize();

    // When the theme toggles, redraw so colors switch immediately. The
    // animated path picks this up automatically on the next frame; the
    // reduced-motion path needs an explicit nudge since there's no rAF
    // loop running.
    const themeObserver = new MutationObserver(() => {
      const rect = canvas.getBoundingClientRect();
      draw(rect.width, rect.height, performance.now() / 1000);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    if (reduceMotion) {
      // Single static frame; no rAF loop. Honors OS-level motion pref.
      const rect = canvas.getBoundingClientRect();
      draw(rect.width, rect.height, 0);
      return () => {
        ro.disconnect();
        themeObserver.disconnect();
      };
    } else {
      // Pause the loop while tab is hidden — saves battery on idle
      // tabs without leaving a stale frame around when the user
      // returns (we redraw immediately on resume).
      const onVisibility = () => {
        if (document.hidden) {
          running = false;
          cancelAnimationFrame(rafId);
        } else if (!running) {
          running = true;
          lastTs = 0;
          rafId = requestAnimationFrame(step);
        }
      };
      document.addEventListener("visibilitychange", onVisibility);
      rafId = requestAnimationFrame(step);
      return () => {
        running = false;
        cancelAnimationFrame(rafId);
        ro.disconnect();
        themeObserver.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
      };
    }
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={
        variant === "fixed"
          ? "pointer-events-none fixed inset-0 z-0 h-full w-full"
          : "pointer-events-none absolute inset-0 h-full w-full"
      }
    />
  );
}
