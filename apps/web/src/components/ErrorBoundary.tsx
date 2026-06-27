import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Catches render errors anywhere in the route subtree so a single
// component crash doesn't unmount the entire app (white screen). React
// has no functional-component equivalent — class component is the only
// way to implement the error boundary lifecycle hooks.
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log to the console for dev visibility; in prod, a real error
    // tracker (Sentry, etc.) would go here. We keep this dependency-free
    // for the thesis launch.
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  private handleGoHome = (): void => {
    // Full reload to drop any corrupted in-memory state (Zustand stores,
    // react-query cache, etc.) along with the error.
    window.location.href = "/";
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="container py-16">
        <div className="mx-auto max-w-md rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
          <h2 className="text-lg font-semibold">Something went wrong</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The page hit an unexpected error. You can try again, or go back to the
            home page.
          </p>
          <pre className="mt-3 overflow-auto rounded bg-muted/40 p-2 text-xs">
            {this.state.error.message}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.handleGoHome}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
            >
              Go home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
