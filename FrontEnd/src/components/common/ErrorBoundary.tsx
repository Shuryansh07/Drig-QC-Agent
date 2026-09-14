import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // TODO: forward to the incident log once the backend exists.
    console.error("Unhandled UI error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="mx-auto flex min-h-dvh max-w-[34rem] flex-col justify-center gap-6 px-5">
        <div className="space-y-3">
          <h1 className="text-title font-semibold tracking-tight">This screen stopped</h1>
          <p className="text-body text-muted-foreground">
            Reloading usually clears it. Your queued questions are saved and will send
            when you are back on signal.
          </p>
        </div>
        <Button
          size="lg"
          className="h-touch-lg text-step"
          onClick={() => window.location.reload()}
        >
          Reload the app
        </Button>
      </div>
    );
  }
}
