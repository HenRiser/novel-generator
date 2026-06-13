import { useEffect, useMemo, useState, type FormEvent } from "react";

import type {
  ApiStatus,
  GenerationSettingsRequest,
  GenerationSettingsResponse,
  ProjectDetail,
  ProjectSummary,
} from "../types";

type GenerationModel = GenerationSettingsRequest["model"];

type ProjectSettingsPageProps = {
  selectedProject: ProjectSummary | null;
  projectDetail: ProjectDetail | null;
  projectLoading: boolean;
  projectError: string;
  apiStatus: ApiStatus;
  onSaveGenerationSettings: (settings: GenerationSettingsRequest) => Promise<GenerationSettingsResponse>;
};

type GenerationSettingsForm = {
  model: GenerationModel;
  maxTokens: string;
  temperature: string;
};

const MODEL_OPTIONS: GenerationModel[] = ["deepseek-v4-flash", "deepseek-v4-pro"];
const DEFAULT_SETTINGS: GenerationSettingsForm = {
  model: "deepseek-v4-flash",
  maxTokens: "4000",
  temperature: "0.7",
};
const MAX_TOKENS_MIN = 512;
const MAX_TOKENS_MAX = 32768;
const MAX_TOKENS_SLIDER_MIN = 1000;
const MAX_TOKENS_SLIDER_MAX = 32700;
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;

function asDisplayText(value: unknown, fallback = "未记录"): string {
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

function isGenerationModel(value: unknown): value is GenerationModel {
  return typeof value === "string" && MODEL_OPTIONS.includes(value as GenerationModel);
}

function finiteNumberValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function formFromConfig(config: Record<string, unknown> | undefined): GenerationSettingsForm {
  const model = configValue(config, "model");
  return {
    model: isGenerationModel(model) ? model : DEFAULT_SETTINGS.model,
    maxTokens: String(Math.trunc(finiteNumberValue(configValue(config, "max_tokens"), Number(DEFAULT_SETTINGS.maxTokens)))),
    temperature: String(finiteNumberValue(configValue(config, "temperature"), Number(DEFAULT_SETTINGS.temperature))),
  };
}

function validateGenerationSettings(form: GenerationSettingsForm): GenerationSettingsRequest | string {
  if (!isGenerationModel(form.model)) {
    return "模型只能选择 deepseek-v4-flash 或 deepseek-v4-pro。";
  }

  if (!form.maxTokens.trim()) {
    return "max_tokens 不能为空。";
  }
  const maxTokens = Number(form.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < MAX_TOKENS_MIN || maxTokens > MAX_TOKENS_MAX) {
    return `max_tokens 必须是 ${MAX_TOKENS_MIN} 到 ${MAX_TOKENS_MAX} 之间的整数。`;
  }

  if (!form.temperature.trim()) {
    return "temperature 不能为空。";
  }
  const temperature = Number(form.temperature);
  if (!Number.isFinite(temperature) || temperature < TEMPERATURE_MIN || temperature > TEMPERATURE_MAX) {
    return `temperature 必须是 ${TEMPERATURE_MIN} 到 ${TEMPERATURE_MAX} 之间的数字。`;
  }

  return {
    model: form.model,
    max_tokens: maxTokens,
    temperature,
  };
}

function sliderValue(maxTokensInput: string): number {
  const parsed = Number(maxTokensInput);
  if (!Number.isFinite(parsed)) {
    return Number(DEFAULT_SETTINGS.maxTokens);
  }
  const rounded = Math.round(parsed / 100) * 100;
  return Math.min(MAX_TOKENS_SLIDER_MAX, Math.max(MAX_TOKENS_SLIDER_MIN, rounded));
}

export function ProjectSettingsPage({
  selectedProject,
  projectDetail,
  projectLoading,
  projectError,
  apiStatus,
  onSaveGenerationSettings,
}: ProjectSettingsPageProps) {
  const config = projectDetail?.config;
  const [form, setForm] = useState<GenerationSettingsForm>(() => formFromConfig(config));
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  const genesisRows = useMemo(
    () =>
      [
        ["project_ref", projectDetail?.project_ref || selectedProject?.project_ref],
        ["标题", projectDetail?.title || selectedProject?.title],
        ["创作种子 / seed", configValue(config, "seed_prompt")],
        ["题材 / genre", configValue(config, "genre")],
        ["风格 / style", configValue(config, "style")],
        ["writing_mode", settingOptionValue(config, "writing_mode")],
        ["expected_chapters", settingOptionValue(config, "expected_chapters")],
        ["创建时间", configValue(config, "created_at")],
      ] as const,
    [config, projectDetail?.project_ref, projectDetail?.title, selectedProject?.project_ref, selectedProject?.title],
  );

  const recordedModel = configValue(config, "model");
  const hasUnsupportedModel = Boolean(recordedModel && !isGenerationModel(recordedModel));

  useEffect(() => {
    setForm(formFromConfig(config));
    setSaveMessage("");
    setSaveError("");
  }, [config, projectDetail?.project_ref]);

  function resetForm() {
    setForm(formFromConfig(config));
    setSaveMessage("");
    setSaveError("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validated = validateGenerationSettings(form);
    if (typeof validated === "string") {
      setSaveError(validated);
      setSaveMessage("");
      return;
    }

    setSaving(true);
    setSaveError("");
    setSaveMessage("");
    try {
      const result = await onSaveGenerationSettings(validated);
      setForm({
        model: isGenerationModel(result.config.model) ? result.config.model : validated.model,
        maxTokens: String(result.config.max_tokens),
        temperature: String(result.config.temperature),
      });
      setSaveMessage(result.message || "Generation settings saved.");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Generation settings save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="workspace-single-page" aria-labelledby="project-settings-title">
      <section className="panel page-intro-panel">
        <span className="section-kicker">Project settings</span>
        <h1 id="project-settings-title">项目配置</h1>
        <p>
          Genesis 初始设定保持长篇一致性；Generation Settings 只调整后续生成参数。
        </p>
      </section>

      {!selectedProject && <p className="empty-state">请选择一个项目后查看配置。legacy 项目字段不足时会显示为未记录。</p>}
      {projectLoading && <p className="state-text loading-text">正在加载项目配置...</p>}
      {projectError && <p className="state-text error-text">{projectError}</p>}

      {selectedProject && !projectLoading && !projectError && (
        <div className="project-settings-layout">
          <section className="panel settings-panel genesis-panel" aria-label="Genesis 初始设定">
            <div className="panel-header">
              <div>
                <span className="section-kicker">Genesis</span>
                <h2>初始设定</h2>
              </div>
            </div>
            <p className="form-note">
              初始设定用于保持长篇一致性，创建后暂不支持直接修改。
            </p>
            <div className="settings-grid">
              {genesisRows.map(([label, value]) => (
                <div className="settings-item" key={label}>
                  <span>{label}</span>
                  <strong>{asDisplayText(value)}</strong>
                </div>
              ))}
            </div>
          </section>

          <section className="panel settings-panel generation-settings-panel" aria-label="Generation Settings 生成参数">
            <div className="panel-header">
              <div>
                <span className="section-kicker">Generation Settings</span>
                <h2>生成参数</h2>
              </div>
            </div>
            <form className="generation-settings-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
              <div className="form-grid generation-settings-grid">
                <label className="form-field">
                  <span>模型</span>
                  <select
                    value={form.model}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, model: event.target.value as GenerationModel }))
                    }
                    disabled={saving}
                  >
                    {MODEL_OPTIONS.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span>temperature</span>
                  <input
                    type="number"
                    min={TEMPERATURE_MIN}
                    max={TEMPERATURE_MAX}
                    step="0.1"
                    value={form.temperature}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, temperature: event.target.value }))
                    }
                    disabled={saving}
                  />
                </label>
                <label className="form-field">
                  <span>max_tokens</span>
                  <input
                    type="number"
                    min={MAX_TOKENS_MIN}
                    max={MAX_TOKENS_MAX}
                    step="1"
                    value={form.maxTokens}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, maxTokens: event.target.value }))
                    }
                    disabled={saving}
                  />
                </label>
                <label className="form-field range-field">
                  <span>max_tokens 快捷滑条</span>
                  <input
                    type="range"
                    min={MAX_TOKENS_SLIDER_MIN}
                    max={MAX_TOKENS_SLIDER_MAX}
                    step="100"
                    value={sliderValue(form.maxTokens)}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, maxTokens: event.target.value }))
                    }
                    disabled={saving}
                  />
                  <small>数字输入框为实际保存值；滑条仅用于快速选择整百值。</small>
                </label>
              </div>

              {hasUnsupportedModel && (
                <p className="state-text warning-text">
                  当前项目记录的模型不在 React 可编辑白名单内，保存时请选择 deepseek-v4-flash 或 deepseek-v4-pro。
                </p>
              )}
              {apiStatus !== "online" && (
                <p className="state-text error-text">API Offline，暂时无法保存生成参数。</p>
              )}
              {saveMessage && <p className="state-text success-text">{saveMessage}</p>}
              {saveError && <p className="state-text error-text">{saveError}</p>}

              <div className="form-actions settings-actions">
                <button className="button subtle-button" type="button" onClick={resetForm} disabled={saving || !projectDetail}>
                  重置为当前项目值
                </button>
                <button
                  className="button primary-button"
                  type="submit"
                  disabled={saving || !projectDetail || apiStatus !== "online"}
                >
                  {saving ? "保存中..." : "保存生成参数"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
