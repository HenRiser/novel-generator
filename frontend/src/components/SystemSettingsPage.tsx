import type { ApiStatus, GenerationStatus } from "../types";

type SystemSettingsPageProps = {
  apiStatus: ApiStatus;
  apiError: string;
  apiBaseUrl: string;
  generationStatus: GenerationStatus | null;
  generationStatusLoading: boolean;
  generationStatusError: string;
  onRefreshGenerationStatus: () => void;
  onOpenCreatePage: () => void;
};

function apiStatusText(status: ApiStatus): string {
  if (status === "online") {
    return "API Online";
  }
  if (status === "offline") {
    return "API Offline";
  }
  return "Loading";
}

export function SystemSettingsPage({
  apiStatus,
  apiError,
  apiBaseUrl,
  generationStatus,
  generationStatusLoading,
  generationStatusError,
  onRefreshGenerationStatus,
  onOpenCreatePage,
}: SystemSettingsPageProps) {
  return (
    <section className="workspace-single-page" aria-labelledby="system-settings-title">
      <section className="panel page-intro-panel">
        <span className="section-kicker">System settings</span>
        <h1 id="system-settings-title">系统设置</h1>
        <p>用于查看运行环境、API 状态和启动方式。本阶段不迁移完整 API Key 管理，也不写入 `.env`。</p>
      </section>

      <section className="system-grid">
        <article className="panel system-card">
          <span className="section-kicker">API</span>
          <h2>后端状态</h2>
          <div className={`status-pill status-${apiStatus}`}>{apiStatusText(apiStatus)}</div>
          <dl className="system-list">
            <div>
              <dt>API base URL</dt>
              <dd>
                <code>{apiBaseUrl}</code>
              </dd>
            </div>
            <div>
              <dt>health</dt>
              <dd>{apiStatus === "online" ? "ok" : apiStatus === "offline" ? "unavailable" : "checking"}</dd>
            </div>
          </dl>
          {apiStatus === "offline" && (
            <p className="state-text error-text">{apiError || "无法连接 API，请先启动 FastAPI 后端服务。"}</p>
          )}
        </article>

        <article className="panel system-card">
          <span className="section-kicker">Generation</span>
          <h2>生成状态</h2>
          <dl className="system-list">
            <div>
              <dt>running</dt>
              <dd>{generationStatus?.running ? "true" : "false"}</dd>
            </div>
            <div>
              <dt>task_type</dt>
              <dd>{generationStatus?.task_type || "-"}</dd>
            </div>
            <div>
              <dt>target</dt>
              <dd>{generationStatus?.target || "-"}</dd>
            </div>
          </dl>
          {generationStatusError && <p className="state-text error-text">{generationStatusError}</p>}
          <div className="system-actions">
            <button
              className="button secondary-button"
              type="button"
              onClick={onRefreshGenerationStatus}
              disabled={generationStatusLoading || apiStatus !== "online"}
            >
              刷新生成状态
            </button>
            <button className="button subtle-button" type="button" onClick={onOpenCreatePage}>
              打开创作页
            </button>
          </div>
        </article>

        <article className="panel system-card">
          <span className="section-kicker">Startup</span>
          <h2>启动方式</h2>
          <dl className="system-list">
            <div>
              <dt>FastAPI + React</dt>
              <dd>
                <code>start-react.bat</code>
              </dd>
            </div>
            <div>
              <dt>Streamlit legacy</dt>
              <dd>
                <code>start.bat</code>
              </dd>
            </div>
          </dl>
        </article>

        <article className="panel system-card">
          <span className="section-kicker">Reserved</span>
          <h2>后续入口</h2>
          <p className="empty-state">模型连接测试、API Key 设置入口和诊断信息将在后续低风险阶段接入。</p>
        </article>
      </section>
    </section>
  );
}
