import { request } from "undici";
import type { ParsedPaper, StructuredReview } from "@reviewarena/shared-types";

// Typed HTTP client for the Python review-gen microservice.
//
// Timeouts: Marker cold-start ~90s + parse ~30-45s = 480s budget on the
// Python side; we mirror that here (480_000) so a slow upload doesn't
// stall under the default undici timeout. Streaming endpoints set
// bodyTimeout: 0 so token-by-token reads aren't capped at the default.
//
// HEADERS timeouts have to cover Modal cold-start time, because the
// non-streaming /generate endpoint holds the response until vLLM has
// finished — no headers sent until then. A Modal cold-start of
// DeepReviewer / OpenReviewer can take 3-4 minutes (model download +
// init), so 60s is far too tight. We use 600_000 for /generate to
// match the body timeout, and a smaller 90_000 for the smaller
// endpoints (/parse-arxiv).
//
// Retries: parsePdf/parseArxiv/generate retry once on 502/503/504 (Modal
// cold-start signals) with 2s backoff. Streaming is NOT retried — the
// caller has already sent SSE headers and a retry would duplicate
// generation.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const RETRY_BACKOFF_MS = 2000;
const PARSE_TIMEOUT_MS = 480_000;
const GENERATE_TIMEOUT_MS = 600_000;
const GENERATE_HEADERS_TIMEOUT_MS = 600_000;

async function withRetry<T>(
  label: string,
  fn: () => Promise<{ statusCode: number; text: string }>,
  parseSuccess: (text: string) => T,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { statusCode, text } = await fn();
    if (statusCode < 400) return parseSuccess(text);
    if (!RETRYABLE_STATUS.has(statusCode) || attempt === 1) {
      throw new Error(`${label} ${statusCode}: ${text}`);
    }
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
  }
  // Unreachable — the loop always either returns or throws.
  throw new Error(`${label}: exhausted retries`);
}

/** Fairness token accounting returned with every generation (FAIRNESS A4). */
export interface GenerationMetrics {
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
  fairInputTokens: number;
  fairOutputTokens: number;
}

export interface GenerateResult {
  review: StructuredReview;
  rawOutput: string;
  generationMs: number;
  metrics?: GenerationMetrics | null;
}

/** SSE event types yielded by streamGenerate(). Mirrors review-gen's wire format. */
export type StreamEvent =
  | { kind: "token"; text: string }
  | {
      kind: "done";
      review: StructuredReview;
      rawOutput: string;
      generationMs: number;
      metrics?: GenerationMetrics | null;
    }
  | { kind: "error"; message: string };

/** Map review-gen's snake_case metrics block to our camelCase shape. */
function mapMetrics(m: unknown): GenerationMetrics | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, number>;
  return {
    inputTokens: o.input_tokens ?? 0,
    outputTokens: o.output_tokens ?? 0,
    contextWindow: o.context_window ?? 0,
    fairInputTokens: o.fair_input_tokens ?? 0,
    fairOutputTokens: o.fair_output_tokens ?? 0,
  };
}

export class ReviewGenClient {
  // X-API-Key forwarded on every billable request. The Python service
  // rejects with 401 if its REVIEW_GEN_API_KEY is set and ours doesn't
  // match; when the Python side runs in open mode (env unset), the
  // header is ignored. Empty string = no header sent.
  private readonly apiKey: string;

  constructor(private readonly baseUrl: string, apiKey: string = "") {
    this.apiKey = apiKey;
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { "x-api-key": this.apiKey } : {};
  }

  /**
   * Parse a PDF via the Python service's /parse endpoint (Marker on
   * Modal under the hood). Throws on 502 / network failure — callers
   * mark the paper PARSE_FAILED so the user sees the upload didn't
   * succeed. Takes the PDF as an in-memory buffer; we never write it
   * to disk.
   */
  async parsePdf(bytes: Buffer, filename: string): Promise<ParsedPaper> {
    return withRetry(
      "review-gen /parse",
      async () => {
        const form = new FormData();
        // Wrap in a Blob so undici's multipart serializer picks the right
        // content-type per FastAPI's UploadFile expectations.
        form.append(
          "file",
          new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
          filename,
        );
        const { statusCode, body } = await request(`${this.baseUrl}/parse`, {
          method: "POST",
          headers: this.authHeaders(),
          body: form,
          bodyTimeout: PARSE_TIMEOUT_MS,
          headersTimeout: 60_000,
        });
        return { statusCode, text: await body.text() };
      },
      (text) => JSON.parse(text) as ParsedPaper,
    );
  }

  /**
   * Parse an arXiv paper via the Python service's /parse-arxiv endpoint,
   * which calls timf34's hosted arxiv2md.org service. Used when the user
   * pastes an arXiv URL/ID instead of uploading a PDF — no Marker call.
   */
  async parseArxiv(url: string): Promise<ParsedPaper> {
    return withRetry(
      "review-gen /parse-arxiv",
      async () => {
        const { statusCode, body } = await request(`${this.baseUrl}/parse-arxiv`, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.authHeaders() },
          body: JSON.stringify({ url }),
          bodyTimeout: 60_000,
          headersTimeout: 30_000,
        });
        return { statusCode, text: await body.text() };
      },
      (text) => JSON.parse(text) as ParsedPaper,
    );
  }

  /**
   * Stream a review from the Python service's /stream-generate SSE
   * endpoint. Yields each token as it arrives, plus a final 'done' (or
   * 'error') event with the parsed StructuredReview. Caller is
   * responsible for persisting the result to DB on 'done'.
   */
  async *streamGenerate(
    adapterKey: string,
    paper: ParsedPaper,
    config: object = {},
    pdfBytes?: Buffer,
    signal?: AbortSignal,
    selectedSectionIds?: number[] | null,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const body: Record<string, unknown> = {
      adapter_key: adapterKey,
      paper,
      config,
    };
    if (pdfBytes) body.pdf_b64 = pdfBytes.toString("base64");
    // Only forward when the user actually picked a subset. NULL/empty =
    // default full-paper behavior on the review-gen side.
    if (selectedSectionIds && selectedSectionIds.length > 0) {
      body.selected_section_ids = selectedSectionIds;
    }

    const { statusCode, body: respBody } = await request(
      `${this.baseUrl}/stream-generate`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
        // No upstream timeout — stream may take 5+ min on long papers
        bodyTimeout: 0,
        headersTimeout: 60_000,
        // Forwarded by undici: if signal fires (browser disconnected),
        // the underlying socket closes and the upstream Python service
        // stops the model invocation. This is what prevents the
        // "user navigates away → Modal GPU keeps burning" leak.
        signal,
      },
    );
    if (statusCode >= 400) {
      const text = await respBody.text();
      yield { kind: "error", message: `review-gen /stream-generate ${statusCode}: ${text}` };
      return;
    }

    // Parse SSE chunks from the stream. SSE events are separated by
    // blank lines; each event has `event:` and `data:` lines.
    let buffer = "";
    for await (const chunk of respBody) {
      buffer += chunk.toString("utf8");
      // Process every complete event (terminated by blank line) we have so far.
      let sepIdx;
      while ((sepIdx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const evt = parseSseBlock(block);
        if (evt) yield evt;
      }
    }
    // Flush any final block.
    if (buffer.trim()) {
      const evt = parseSseBlock(buffer);
      if (evt) yield evt;
    }
  }

  async generate(
    adapterKey: string,
    paper: ParsedPaper,
    config: object = {},
    pdfBytes?: Buffer,
  ): Promise<GenerateResult> {
    // Only attach the PDF if the caller explicitly passed it through —
    // the Python side only decodes it when the chosen adapter has
    // requires_pdf_bytes=True (MARG). For everything else we skip the
    // ~MB of base64 overhead.
    const body: Record<string, unknown> = {
      adapter_key: adapterKey,
      paper,
      config,
    };
    if (pdfBytes) {
      body.pdf_b64 = pdfBytes.toString("base64");
    }
    return withRetry(
      "review-gen /generate",
      async () => {
        const { statusCode, body: respBody } = await request(`${this.baseUrl}/generate`, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.authHeaders() },
          body: JSON.stringify(body),
          bodyTimeout: GENERATE_TIMEOUT_MS,
          headersTimeout: GENERATE_HEADERS_TIMEOUT_MS,
        });
        return { statusCode, text: await respBody.text() };
      },
      (text) => {
        const parsed = JSON.parse(text) as {
          review: StructuredReview;
          raw_output: string;
          generation_ms: number;
          metrics?: unknown;
        };
        return {
          review: parsed.review,
          rawOutput: parsed.raw_output,
          generationMs: parsed.generation_ms,
          metrics: mapMetrics(parsed.metrics),
        };
      },
    );
  }
}

/** Parse a single SSE block of the form `event: <type>\ndata: <json>`. */
function parseSseBlock(block: string): StreamEvent | null {
  let eventType: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!eventType || dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  try {
    const parsed = JSON.parse(data);
    if (eventType === "token") {
      return { kind: "token", text: parsed.text ?? "" };
    }
    if (eventType === "done") {
      return {
        kind: "done",
        review: parsed.review,
        rawOutput: parsed.raw_output,
        generationMs: parsed.generation_ms ?? 0,
        metrics: mapMetrics(parsed.metrics),
      };
    }
    if (eventType === "error") {
      return { kind: "error", message: parsed.message ?? "unknown error" };
    }
  } catch {
    /* malformed JSON — skip */
  }
  return null;
}
