import { Component, Suspense, type ReactNode } from "react";
import { Button, Spin } from "antd";

class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="route-error" role="alert"><h2>这个页面暂时未能打开</h2><p>可以尝试重新加载，或从导航前往其他创作空间。</p><Button onClick={() => window.location.reload()}>重新加载</Button></div>;
    return this.props.children;
  }
}
export default function PageBoundary({ children }: { children: ReactNode }) {
  return <PageErrorBoundary><Suspense fallback={<div className="route-loading" role="status"><Spin /><p>正在展开创作空间…</p></div>}>{children}</Suspense></PageErrorBoundary>;
}
