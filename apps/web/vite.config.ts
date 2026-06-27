import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";

// Pull REVIEW_GEN_API_KEY for the dev-only /py-api proxy. We try (in
// order): a real environment variable, then the project-root .env file.
// The key stays on the Vite dev server — it's never exposed to the
// browser bundle because we only use it inside `configure(proxy)` below.
function loadReviewGenApiKey(): string {
  if (process.env.REVIEW_GEN_API_KEY) return process.env.REVIEW_GEN_API_KEY;
  // Walk up from apps/web to the repo root and read .env directly.
  // loadEnv() only finds VITE_-prefixed vars; this one isn't prefixed
  // because it's a server-side secret, not a browser var.
  try {
    const envPath = path.resolve(__dirname, "../../.env");
    const text = readFileSync(envPath, "utf8");
    const match = text.match(/^REVIEW_GEN_API_KEY\s*=\s*"?([^"\n\r]+)"?/m);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

export default defineConfig(({ mode }) => {
  // Touch loadEnv so the Vite cache picks up VITE_-prefixed vars; not
  // strictly required for the key load above.
  loadEnv(mode, process.cwd(), "");
  const reviewGenApiKey = loadReviewGenApiKey();

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: process.env.VITE_API_URL ?? "http://localhost:8000",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ""),
        },
        // Direct passthrough to the Python review-gen service so the
        // /dev API docs page can hit it without going through the Node
        // API. Same shape as the /api proxy — strip prefix, forward to
        // the FastAPI port. Devtools-only; production doesn't need it.
        //
        // We inject X-API-Key here so the browser never sees the secret.
        // Without this, the playground 401s against the auth gate added
        // for production-readiness (services/review-gen/app/main.py).
        "/py-api": {
          target: process.env.VITE_REVIEW_GEN_URL ?? "http://localhost:8001",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/py-api/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (reviewGenApiKey) {
                proxyReq.setHeader("X-API-Key", reviewGenApiKey);
              }
            });
          },
        },
      },
    },
  };
});
