import type { ProjectDetail, ProjectSummary } from "../types";

type ProjectSettingsPageProps = {
  selectedProject: ProjectSummary | null;
  projectDetail: ProjectDetail | null;
  projectLoading: boolean;
  projectError: string;
};

function asDisplayText(value: unknown, fallback = "未填写"): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

function configValue(config: Record<string, unknown> | undefined, key: string): unknown {
  return config ? config[key] : undefined;
}

function settingOptionValue(config: Record<string, unknown> | undefined, key: string): unknown {
  const options = configValue(config, "setting_generation_options");
  if (options && typeof options === "object" && key in options) {
    return (options as Record<string, unknown>)[key];
  }
  return undefined;
}

export function ProjectSettingsPage({
  selectedProject,
  projectDetail,
  projectLoading,
  projectError,
}: ProjectSettingsPageProps) {
  const config = projectDetail?.config;
  const rows = [
    ["project_ref", projectDetail?.project_ref || selectedProject?.project_ref],
    ["标题", projectDetail?.title || selectedProject?.title],
    ["创作种子 / seed", configValue(config, "seed_prompt")],
    ["题材", configValue(config, "genre")],
    ["风格", configValue(config, "style")],
    ["模型", configValue(config, "model")],
    ["max_tokens", configValue(config, "max_tokens")],
    ["temperature", configValue(config, "temperature")],
    ["writing_mode", settingOptionValue(config, "writing_mode")],
    ["expected_chapters", settingOptionValue(config, "expected_chapters")],
  ] as const;

  return (
    <section className="workspace-single-page" aria-labelledby="project-settings-title">
      <section className="panel page-intro-panel">
        <span className="section-kicker">Project settings</span>
        <h1 id="project-settings-title">项目配置</h1>
        <p>
          当前阶段以只读展示为主。初始设定创建后默认锁定，避免创作中随意修改题材、文风和创作种子。
        </p>
      </section>

      {!selectedProject && <p className="empty-state">请选择一个项目后查看配置。legacy 项目字段不足时会显示为未填写。</p>}
      {projectLoading && <p className="state-text loading-text">正在加载项目配置...</p>}
      {projectError && <p className="state-text error-text">{projectError}</p>}

      {selectedProject && !projectLoading && !projectError && (
        <section className="panel settings-panel" aria-label="项目配置只读字段">
          <div className="settings-grid">
            {rows.map(([label, value]) => (
              <div className="settings-item" key={label}>
                <span>{label}</span>
                <strong>{asDisplayText(value)}</strong>
              </div>
            ))}
          </div>
          <p className="form-note">本页不提供保存按钮，不写入配置文件。max_tokens slider 和安全编辑入口留到后续阶段。</p>
        </section>
      )}
    </section>
  );
}
