// Dev-only error boundary that surfaces the actual error message in the DOM.
// Remove after migration is settled.

import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
     
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "#fff",
            color: "#222",
            padding: 24,
            font: "14px/1.5 -apple-system, sans-serif",
            overflow: "auto",
            zIndex: 9999,
          }}
        >
          <h2>App crashed: {this.state.error.message}</h2>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
