import { Component, type ReactNode } from "react";
import { Link } from "react-router";
import { OrbitMark } from "../components/brand";
import { Button, buttonClass } from "../components/ui";

function Message({ title, body, action }: { title: string; body: string; action: ReactNode }) {
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <OrbitMark size={40} tone="mono" className="mx-auto text-line-strong" />
      <h1 className="mt-5 text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-ink-soft">{body}</p>
      <div className="mt-6">{action}</div>
    </div>
  );
}

export function NotFound() {
  return (
    <Message
      title="Nothing at this address"
      body="The page may have moved, or the link is mistyped."
      action={<Link to="/" className={buttonClass("primary")}>Go to overview</Link>}
    />
  );
}

/** Catches render errors so one broken page doesn't blank the whole console. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Message
        title="This page hit an error"
        body={this.state.error.message || "Something unexpected happened while showing this page."}
        action={<Button variant="primary" onClick={() => window.location.reload()}>Reload</Button>}
      />
    );
  }
}
