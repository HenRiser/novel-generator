import type { ReactNode } from "react";

type DebugDrawerProps = {
  children: ReactNode;
};

export function DebugDrawer({ children }: DebugDrawerProps) {
  return (
    <details className="panel debug-drawer">
      <summary>
        <span>
          <span className="section-kicker">Advanced Debug</span>
          <strong>Raw inputs, payloads, and fallback controls</strong>
        </span>
      </summary>
      <div className="debug-drawer-body">{children}</div>
    </details>
  );
}
