/**
 * Hand-maintained catalog of every HTTP surface ReviewArena exposes.
 *
 * Why hand-maintained rather than auto-generated (zod-to-openapi):
 * the schemas live in shared-types but the *human descriptions* + *which
 * fields are commonly tweaked* matter more for dev/demo browsing than
 * raw shape accuracy. Update this file when you add a route.
 *
 * Each entry feeds the /dev API-docs page. Safe entries (method=GET,
 * no auth) get an inline "Try it" form; unsafe ones (POST mutating
 * state, file uploads, admin-only) get a curl snippet.
 */

export type ApiSection = "node-public" | "node-admin" | "review-gen" | "modal";

export interface ApiParam {
  name: string;
  in: "path" | "query" | "header" | "body";
  required: boolean;
  description: string;
  example?: string;
}

export interface ApiEndpoint {
  section: ApiSection;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path relative to its base URL (e.g. "/papers/:id"). */
  path: string;
  summary: string;
  description: string;
  params?: ApiParam[];
  /** When true, page renders a "Try it" form; when false, shows a curl snippet. */
  safe: boolean;
  /** Tags for filtering. */
  tags?: string[];
  /** When responses are huge (SSE / binary), say so so the page doesn't try to render them inline. */
  responseNote?: string;
}

export const SECTIONS: Record<ApiSection, { label: string; baseHint: string }> = {
  "node-public": {
    label: "Node API · public",
    baseHint: "/api  (proxied to http://localhost:8000)",
  },
  "node-admin": {
    label: "Node API · admin",
    baseHint: "/api  (Bearer auth: ADMIN_TOKEN)",
  },
  "review-gen": {
    label: "review-gen (Python)",
    baseHint: "http://localhost:8001  (auto-Swagger at /docs)",
  },
  modal: {
    label: "Modal-hosted GPU services",
    baseHint: "<each service's deploy URL>  (X-Modal-Auth header)",
  },
};

// Public Node endpoints — the ones the React app actually calls.
const NODE_PUBLIC: ApiEndpoint[] = [
  {
    section: "node-public",
    method: "POST",
    path: "/papers",
    summary: "Upload a PDF paper",
    description:
      "Multipart upload. Parses via Datalab Chandra, pre-selects a 2-system pair via exposure-weighted sampling, returns the paperId. The browser then opens SSE streams to /reviews/stream/:id for each pair member.",
    params: [
      { name: "file", in: "body", required: true, description: "PDF, ≤10 MB" },
      { name: "title", in: "body", required: false, description: "Optional override title" },
    ],
    safe: false,
    tags: ["upload"],
  },
  {
    section: "node-public",
    method: "POST",
    path: "/papers/arxiv",
    summary: "Upload an arXiv URL or ID",
    description:
      "JSON body. Skips Marker and uses the arxiv2md fast-path (timf34's free hosted service) for arXiv papers that have HTML rendering.",
    params: [
      { name: "url", in: "body", required: true, description: "arXiv URL or bare ID", example: "https://arxiv.org/abs/2412.06090" },
      { name: "title", in: "body", required: false, description: "Optional override title" },
    ],
    safe: false,
    tags: ["upload"],
  },
  {
    section: "node-public",
    method: "GET",
    path: "/papers/:id",
    summary: "Paper status + chosen pair reviewIds",
    description:
      "Polled while parsing + generation runs. Once status=PARSED, the response includes `reviewIds` — the two pre-selected reviews' IDs that the browser uses to open SSE streams.",
    params: [
      { name: "id", in: "path", required: true, description: "Paper CUID" },
    ],
    safe: true,
  },
  {
    section: "node-public",
    method: "GET",
    path: "/review-systems",
    summary: "Enabled review systems",
    description:
      "List of enabled reviewer slugs. Used by the Reviewer Playground above to populate its dropdown.",
    safe: true,
  },
  {
    section: "node-public",
    method: "POST",
    path: "/reviews/playground",
    summary: "Run a review through one chosen system (parse + generate)",
    description:
      "Orchestrates parse + generate end-to-end for a single system. Multipart `file` (PDF) OR JSON-like `url` (arXiv) plus a `systemSlug`. Returns the StructuredReview. Doesn't write to the papers/reviews tables — strictly for testing reviewers.",
    params: [
      { name: "file", in: "body", required: false, description: "PDF, ≤10 MB (PDF mode)" },
      { name: "url", in: "body", required: false, description: "arXiv URL or ID (arXiv mode)" },
      { name: "systemSlug", in: "body", required: true, description: "Slug from /review-systems" },
    ],
    safe: false,
    tags: ["dev"],
  },
  {
    section: "node-public",
    method: "GET",
    path: "/pair",
    summary: "Get the chosen pair + pairToken",
    description:
      "Returns reviewA + reviewB (structured may be null if still streaming) and a HMAC-signed pairToken. The pair is frozen — refresh / reload returns the same pair if the pairToken is presented.",
    params: [
      { name: "paperId", in: "query", required: true, description: "Paper CUID" },
      { name: "pairToken", in: "query", required: false, description: "Resume token from prior /pair response" },
    ],
    safe: true,
  },
  {
    section: "node-public",
    method: "GET",
    path: "/reviews/stream/:reviewId",
    summary: "SSE stream of review tokens",
    description:
      "Server-Sent Events. Yields `event: token` + `event: done` (or `event: error`). Browser opens this twice — once per pair member. Replays the already-COMPLETED state if the review is finished.",
    params: [
      { name: "reviewId", in: "path", required: true, description: "Review CUID" },
    ],
    safe: false,
    responseNote: "text/event-stream — open in a terminal with `curl -N` or via EventSource in the browser; the page can't render this inline.",
    tags: ["streaming"],
  },
  {
    section: "node-public",
    method: "GET",
    path: "/leaderboard",
    summary: "Per-system Elo rankings with bootstrap CIs",
    description: "Replays the full vote history every call (cheap at thesis scale). Pass `dimension` for per-dimension leaderboards.",
    params: [
      { name: "dimension", in: "query", required: false, description: "One of: comprehensiveness, clarity, fairness, … (omit for overall)" },
    ],
    safe: true,
  },
  {
    section: "node-public",
    method: "POST",
    path: "/votes",
    summary: "Submit a vote on a pair",
    description: "Body includes the pairToken (server verifies HMAC + session match), the winner, and optional per-dimension preferences.",
    params: [
      { name: "pairToken", in: "body", required: true, description: "From /pair response" },
      { name: "winner", in: "body", required: true, description: "A | B | TIE" },
      { name: "decisionMs", in: "body", required: false, description: "How long the user looked at the pair (ms)" },
      { name: "dimensions", in: "body", required: false, description: "[{dimension, value (-1, 0, 1)}]" },
    ],
    safe: false,
    tags: ["vote"],
  },
  {
    section: "node-public",
    method: "GET",
    path: "/reveal/:voteId",
    summary: "Post-vote reveal payload",
    description: "Returns the un-blinded system names + per-side claim verdicts the judge produced.",
    params: [
      { name: "voteId", in: "path", required: true, description: "Vote CUID returned from POST /votes" },
    ],
    safe: true,
  },
];

const NODE_ADMIN: ApiEndpoint[] = [
  {
    section: "node-admin",
    method: "GET",
    path: "/admin/review-systems",
    summary: "List all review systems (incl. disabled)",
    description: "Admin-only view of the review_systems table. Requires Authorization: Bearer ADMIN_TOKEN.",
    safe: true,
  },
  {
    section: "node-admin",
    method: "POST",
    path: "/admin/review-systems",
    summary: "Create a review system row",
    description: "Used to register a new adapter without re-running db:seed.",
    safe: false,
  },
  {
    section: "node-admin",
    method: "POST",
    path: "/admin/review-systems/:id/toggle",
    summary: "Enable/disable a review system",
    description: "Disabled systems are skipped by the pair selector + orchestrator.",
    params: [{ name: "id", in: "path", required: true, description: "System CUID" }],
    safe: false,
  },
  {
    section: "node-admin",
    method: "DELETE",
    path: "/admin/review-systems/:id",
    summary: "Delete a review system (cascade)",
    description: "Soft option: prefer toggle. Deletion cascades to reviews + claim_checks for that system.",
    params: [{ name: "id", in: "path", required: true, description: "System CUID" }],
    safe: false,
  },
  {
    section: "node-admin",
    method: "GET",
    path: "/admin/votes",
    summary: "Vote audit log",
    description: "Recent votes with session + winner + dimensions. Useful for spot-checking user-study sessions.",
    safe: true,
  },
  {
    section: "node-admin",
    method: "POST",
    path: "/admin/papers/:id/regenerate",
    summary: "Re-generate reviews for a paper",
    description: "Wipes existing reviews + re-runs the orchestrator. Use after changing a prompt template.",
    params: [{ name: "id", in: "path", required: true, description: "Paper CUID" }],
    safe: false,
  },
  {
    section: "node-admin",
    method: "POST",
    path: "/admin/papers/:id/score",
    summary: "Re-run the judge on existing reviews",
    description: "Same as above but only re-judges, doesn't regenerate.",
    params: [{ name: "id", in: "path", required: true, description: "Paper CUID" }],
    safe: false,
  },
  {
    section: "node-admin",
    method: "GET",
    path: "/admin/export.json",
    summary: "Canonical thesis dataset (JSON)",
    description: "Joined dump: papers + reviews + votes + claim_checks + per-system ratings. The artifact thesis_eval.py reads.",
    safe: true,
    responseNote: "Can be large (~MB). Page will render the JSON pretty-printed.",
  },
  {
    section: "node-admin",
    method: "GET",
    path: "/admin/export.csv",
    summary: "Flat CSV export",
    description: "Same data as /admin/export.json but pivoted for spreadsheet inspection.",
    safe: true,
    responseNote: "text/csv — page links to download.",
  },
];

const REVIEW_GEN: ApiEndpoint[] = [
  {
    section: "review-gen",
    method: "POST",
    path: "/parse",
    summary: "PDF → ParsedPaper",
    description:
      "Multipart file upload. Routes through Datalab's hosted Chandra OCR-2 API. " +
      "Returns canonical ParsedPaper shape. Safe to call from the API docs page — " +
      "doesn't touch the DB, just round-trips the parser.",
    params: [
      { name: "file", in: "body", required: true, description: "PDF bytes" },
    ],
    safe: true,
    tags: ["parsing"],
  },
  {
    section: "review-gen",
    method: "POST",
    path: "/parse-arxiv",
    summary: "arXiv URL/ID → ParsedPaper",
    description: "JSON body. Skips the GPU entirely; uses arxiv2md.org's free hosted service.",
    params: [
      { name: "url", in: "body", required: true, description: "arXiv URL or bare ID", example: "https://arxiv.org/abs/2412.06090" },
    ],
    safe: true,
    tags: ["parsing"],
  },
  {
    section: "review-gen",
    method: "POST",
    path: "/generate",
    summary: "Non-streaming review generation",
    description: "Blocking POST. The Node SSE bridge prefers /stream-generate; this endpoint is for admin/re-score paths.",
    safe: false,
    tags: ["adapter"],
  },
  {
    section: "review-gen",
    method: "POST",
    path: "/stream-generate",
    summary: "SSE: token-level review streaming",
    description: "The endpoint Node /reviews/stream/:id forwards to. Yields token / done / error events with the same JSON payloads.",
    safe: false,
    responseNote: "text/event-stream",
    tags: ["adapter", "streaming"],
  },
  {
    section: "review-gen",
    method: "POST",
    path: "/judge",
    summary: "LLM-as-judge: claim extraction + verdicts",
    description: "Given a review + the paper text, returns per-claim SUPPORTED / CONTRADICTED / UNSUPPORTED labels with evidence snippets.",
    safe: false,
    tags: ["judge"],
  },
  {
    section: "review-gen",
    method: "GET",
    path: "/healthz",
    summary: "Liveness check",
    description: "Returns the list of registered adapter keys.",
    safe: true,
  },
];

const MODAL: ApiEndpoint[] = [
  {
    section: "modal",
    method: "POST",
    path: "/v1/chat/completions",
    summary: "DeepReviewer-7B — vLLM OpenAI-compatible",
    description: "Base URL: $DEEPREVIEWER_URL. Standard OpenAI chat-completions shape, streaming supported.",
    safe: false,
  },
  {
    section: "modal",
    method: "POST",
    path: "/v1/chat/completions",
    summary: "Llama-OpenReviewer-8B — vLLM OpenAI-compatible",
    description: "Base URL: $OPENREVIEWER_URL. Same shape as DeepReviewer.",
    safe: false,
  },
  {
    section: "modal",
    method: "POST",
    path: "/v1/chat/completions",
    summary: "CycleReviewer-8B — vLLM OpenAI-compatible",
    description: "Base URL: $CYCLEREVIEWER_URL. Same shape as DeepReviewer.",
    safe: false,
  },
  {
    section: "modal",
    method: "POST",
    path: "/v1/chat/completions",
    summary: "SEA-E — vLLM OpenAI-compatible",
    description: "Base URL: $SEA_URL. Same shape as DeepReviewer.",
    safe: false,
  },
];

export const ENDPOINTS: ApiEndpoint[] = [
  ...NODE_PUBLIC,
  ...NODE_ADMIN,
  ...REVIEW_GEN,
  ...MODAL,
];
