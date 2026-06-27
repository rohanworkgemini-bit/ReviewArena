import { useCallback, useEffect, useRef, useState } from "react";
import type { StructuredReview } from "@reviewarena/shared-types";

/**
 * Subscribe to an SSE stream of review tokens from
 * /api/reviews/stream/:reviewId. Accumulates text chunks, surfaces a
 * final structured review on done, error message on failure.
 *
 * Disconnect handling:
 *   - 'done' → close, mark done=true, no auto-reconnect.
 *   - 'error' with payload → surface message, mark error, close.
 *   - 'error' without payload (transport hiccup) → tolerate up to
 *     STALL_MS of silence, then surface as a stall error so the UI can
 *     offer a retry instead of spinning forever.
 *   - The hook exposes a `retry` function the UI calls to rebuild the
 *     EventSource from scratch after an error.
 *
 * Disabled when reviewId is undefined (e.g. before the pair is known).
 */
export interface ReviewStreamState {
  text: string;
  done: boolean;
  structured: StructuredReview | null;
  error: string | null;
  /** Trigger a fresh EventSource for the same reviewId. No-op if streaming. */
  retry: () => void;
}

const STALL_MS = 90_000; // give Modal cold-start (≤90 s) before declaring stalled

const INITIAL = {
  text: "",
  done: false,
  structured: null as StructuredReview | null,
  error: null as string | null,
};

export function useReviewStream(
  reviewId: string | undefined,
): ReviewStreamState {
  const [state, setState] = useState(INITIAL);
  // Bumping this re-runs the effect → new EventSource. Decoupled from
  // reviewId so the parent doesn't have to remount the panel.
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  // Latest stall-watchdog timer; cleared on each token / unmount.
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!reviewId) {
      setState(INITIAL);
      return;
    }
    setState(INITIAL);

    const es = new EventSource(`/api/reviews/stream/${reviewId}`, {
      withCredentials: true,
    });

    const armStall = () => {
      if (stallTimer.current) clearTimeout(stallTimer.current);
      stallTimer.current = setTimeout(() => {
        setState((prev) => ({
          ...prev,
          error: prev.error ?? "Stream stalled — no tokens for 90s",
        }));
        es.close();
      }, STALL_MS);
    };
    armStall();

    es.addEventListener("token", (e) => {
      armStall();
      try {
        const payload = JSON.parse((e as MessageEvent).data) as { text?: string };
        if (payload.text) {
          setState((prev) => ({ ...prev, text: prev.text + payload.text }));
        }
      } catch {
        /* malformed JSON — skip */
      }
    });

    es.addEventListener("done", (e) => {
      if (stallTimer.current) clearTimeout(stallTimer.current);
      try {
        const payload = JSON.parse((e as MessageEvent).data) as {
          review?: StructuredReview;
          raw_output?: string;
        };
        setState((prev) => ({
          text: payload.raw_output ?? prev.text,
          done: true,
          structured: payload.review ?? null,
          error: null,
        }));
      } catch {
        setState((prev) => ({ ...prev, done: true }));
      }
      es.close();
    });

    es.addEventListener("error", (e) => {
      // Server-side errors carry a JSON payload with a message. Transport
      // hiccups are bare events (the EventSource may auto-reconnect on
      // its own; the stall watchdog catches the "stuck reconnecting"
      // case).
      let msg: string | null = null;
      try {
        const payload = JSON.parse((e as MessageEvent).data ?? "{}") as {
          message?: string;
        };
        msg = payload.message ?? null;
      } catch {
        /* transport-level error event — bare, no JSON */
      }
      if (msg) {
        if (stallTimer.current) clearTimeout(stallTimer.current);
        setState((prev) => ({ ...prev, error: msg }));
        es.close();
      }
    });

    return () => {
      if (stallTimer.current) clearTimeout(stallTimer.current);
      es.close();
    };
  }, [reviewId, retryNonce]);

  return { ...state, retry };
}
