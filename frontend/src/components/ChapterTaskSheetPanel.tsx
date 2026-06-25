import { useEffect, useMemo, useState } from "react";

import {
  approveChapterTask,
  getChapterTask,
  saveChapterTaskDraft,
  safePublicMessage,
} from "../api";
import type {
  ApiStatus,
  ChapterTaskDraftRequest,
  ChapterTaskFunction,
  ChapterTaskResponse,
  ChapterTaskSheet,
} from "../types";


const FUNCTION_OPTIONS: Array<{ value: ChapterTaskFunction; label: string }> = [
  { value: "relationship_progress", label: "关系推进" },
  { value: "emotional_aftermath", label: "情绪余波" },
  { value: "action_progress", label: "行动推进" },
  { value: "information_reveal", label: "信息揭示" },
  { value: "foreshadowing_setup", label: "伏笔设置" },
  { value: "foreshadowing_payoff", label: "伏笔回收" },
  { value: "reward_delivery", label: "回报兑现" },
  { value: "suspense_maintenance", label: "悬念维持" },
  { value: "transition", label: "过渡" },
];
const NONE_BUDGET_INCOMPATIBLE_FUNCTIONS = new Set<ChapterTaskFunction>([
  "information_reveal",
  "foreshadowing_setup",
]);

const EMPTY_FORM: ChapterTaskDraftRequest = {
  primary_function: "transition",
  secondary_functions: [],
  intensity: "medium",
  canon_budget: "normal",
  must_carry: [],
  allowed_advances: [],
  forbidden_advances: [],
  required_characters: [],
  relationship_goal: "",
  decision_goal: "",
  allowed_scene_types: [],
  forbidden_scene_drivers: [],
  ending_state: "",
  notes: "",
};

type ListField =
  | "must_carry"
  | "allowed_advances"
  | "forbidden_advances"
  | "required_characters"
  | "allowed_scene_types"
  | "forbidden_scene_drivers";

type TextField = "relationship_goal" | "decision_goal" | "ending_state" | "notes";

function toForm(task: ChapterTaskSheet | null): ChapterTaskDraftRequest {
  if (!task) {
    return { ...EMPTY_FORM };
  }
  return {
    id: task.id,
    revision: task.status === "draft" ? task.revision : undefined,
    primary_function: task.primary_function,
    secondary_functions: [...task.secondary_functions],
    intensity: task.intensity,
    canon_budget: task.canon_budget,
    must_carry: [...task.must_carry],
    allowed_advances: [...task.allowed_advances],
    forbidden_advances: [...task.forbidden_advances],
    required_characters: [...task.required_characters],
    relationship_goal: task.relationship_goal,
    decision_goal: task.decision_goal,
    allowed_scene_types: [...task.allowed_scene_types],
    forbidden_scene_drivers: [...task.forbidden_scene_drivers],
    ending_state: task.ending_state,
    notes: task.notes,
  };
}

function splitLines(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function listValue(values: string[]): string {
  return values.join("\n");
}

function comparisonKey(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/ß/g, "ss");
}

function advanceConflicts(allowed: string[], forbidden: string[]): string[] {
  const forbiddenKeys = new Set(forbidden.map(comparisonKey).filter(Boolean));
  const seen = new Set<string>();
  return allowed.filter((item) => {
    const key = comparisonKey(item);
    if (!key || !forbiddenKeys.has(key) || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formConsistencyErrors(form: ChapterTaskDraftRequest): string[] {
  const errors: string[] = [];
  if (
    form.canon_budget === "none" &&
    NONE_BUDGET_INCOMPATIBLE_FUNCTIONS.has(form.primary_function)
  ) {
    errors.push(
      `主要功能 ${form.primary_function} 与新正典预算 none 不兼容；请修改章节功能或提高新正典预算。`,
    );
  }
  const incompatibleSecondary = form.secondary_functions.filter(
    (item) =>
      form.canon_budget === "none" && NONE_BUDGET_INCOMPATIBLE_FUNCTIONS.has(item),
  );
  if (incompatibleSecondary.length > 0) {
    errors.push(
      `次要功能 ${incompatibleSecondary.join("、")} 与新正典预算 none 不兼容；请修改章节功能或提高新正典预算。`,
    );
  }
  if (form.secondary_functions.includes(form.primary_function)) {
    errors.push("主要功能不能在次要功能中重复选择。");
  }
  const conflicts = advanceConflicts(form.allowed_advances, form.forbidden_advances);
  if (conflicts.length > 0) {
    errors.push(`允许推进与禁止推进存在相同项：${conflicts.join("、")}。`);
  }
  return errors;
}

export function ChapterTaskSheetPanel({
  projectRef,
  chapterNumber,
  apiStatus,
  disabled,
  onApprovedTaskChange,
}: {
  projectRef: string;
  chapterNumber: number;
  apiStatus: ApiStatus;
  disabled: boolean;
  onApprovedTaskChange: (task: ChapterTaskSheet | null) => void;
}) {
  const [data, setData] = useState<ChapterTaskResponse | null>(null);
  const [form, setForm] = useState<ChapterTaskDraftRequest>({ ...EMPTY_FORM });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const editableSource = data?.latest_draft ?? data?.approved ?? null;
  const isWorkspaceProject = projectRef.startsWith("book:");
  const canUseApi = Boolean(projectRef && isWorkspaceProject && apiStatus === "online");
  const consistencyErrors = useMemo(() => formConsistencyErrors(form), [form]);
  const historySummary = useMemo(
    () => (data?.history ?? []).map((task) => `r${task.revision} ${task.status}`).join(" · "),
    [data],
  );

  useEffect(() => {
    let ignore = false;
    onApprovedTaskChange(null);
    setData(null);
    setForm({ ...EMPTY_FORM });
    setError("");
    setMessage("");

    if (!canUseApi || !Number.isInteger(chapterNumber) || chapterNumber < 1) {
      return () => {
        ignore = true;
      };
    }

    setLoading(true);
    void getChapterTask(projectRef, chapterNumber)
      .then((result) => {
        if (ignore) {
          return;
        }
        setData(result);
        setForm(toForm(result.latest_draft ?? result.approved));
        onApprovedTaskChange(result.approved);
      })
      .catch((loadError) => {
        if (!ignore) {
          setError(safePublicMessage(loadError instanceof Error ? loadError.message : "", "任务单读取失败。"));
        }
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [canUseApi, chapterNumber, onApprovedTaskChange, projectRef]);

  function updateList(field: ListField, value: string) {
    setForm((current) => ({ ...current, [field]: splitLines(value) }));
    setMessage("");
  }

  function updateText(field: TextField, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setMessage("");
  }

  function toggleSecondary(value: ChapterTaskFunction) {
    setForm((current) => ({
      ...current,
      secondary_functions: current.secondary_functions.includes(value)
        ? current.secondary_functions.filter((item) => item !== value)
        : [...current.secondary_functions, value],
    }));
    setMessage("");
  }

  async function saveDraft() {
    if (!canUseApi) {
      return;
    }
    if (consistencyErrors.length > 0) {
      setError(consistencyErrors[0]);
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await saveChapterTaskDraft(projectRef, chapterNumber, form);
      setData(result);
      setForm(toForm(result.latest_draft));
      onApprovedTaskChange(result.approved);
      setMessage("草稿已保存。草稿不会进入正文生成。");
    } catch (saveError) {
      setError(safePublicMessage(saveError instanceof Error ? saveError.message : "", "任务单草稿保存失败。"));
    } finally {
      setSaving(false);
    }
  }

  async function approveDraft() {
    const draft = data?.latest_draft;
    if (!canUseApi || !draft) {
      return;
    }
    setApproving(true);
    setError("");
    setMessage("");
    try {
      const result = await approveChapterTask(projectRef, chapterNumber, draft.id, draft.revision);
      setData(result);
      setForm(toForm(result.approved));
      onApprovedTaskChange(result.approved);
      setMessage(`revision ${result.approved?.revision ?? draft.revision} 已批准，将用于本章正文生成。`);
    } catch (approveError) {
      setError(safePublicMessage(approveError instanceof Error ? approveError.message : "", "任务单批准失败。"));
    } finally {
      setApproving(false);
    }
  }

  const fieldsDisabled = !canUseApi || disabled || loading || saving || approving;

  return (
    <section className="panel chapter-task-panel">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Chapter Task Sheet</span>
          <h2>章节任务单</h2>
        </div>
        <span className={`status-badge ${data?.approved ? "status-badge-online" : ""}`}>
          {loading ? "Loading" : data?.approved ? "Approved active" : data?.latest_draft ? "Draft only" : "Not created"}
        </span>
      </div>

      {!projectRef && <p className="empty-state">选择 workspace 项目后创建章节任务单。</p>}
      {projectRef && !isWorkspaceProject && (
        <p className="state-text warning-text">Chapter Task Sheet v1 仅支持 workspace book 项目。</p>
      )}

      <dl className="chapter-task-version-status" aria-label="章节任务单版本状态">
        <div>
          <dt>生成生效</dt>
          <dd>{data?.approved ? `approved revision ${data.approved.revision}` : "无"}</dd>
        </div>
        <div>
          <dt>编辑中</dt>
          <dd>{data?.latest_draft ? `draft revision ${data.latest_draft.revision}` : "无"}</dd>
        </div>
      </dl>

      <div className="chapter-task-form">
        <label className="field-stack">
          <span>章节号</span>
          <input type="number" value={chapterNumber} readOnly disabled />
        </label>
        <label className="field-stack">
          <span>主要功能</span>
          <select
            value={form.primary_function}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                primary_function: event.target.value as ChapterTaskFunction,
              }))
            }
            disabled={fieldsDisabled}
          >
            {FUNCTION_OPTIONS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={
                  form.canon_budget === "none" &&
                  NONE_BUDGET_INCOMPATIBLE_FUNCTIONS.has(option.value)
                }
              >
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-stack">
          <span>强度</span>
          <select
            value={form.intensity}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                intensity: event.target.value as ChapterTaskDraftRequest["intensity"],
              }))
            }
            disabled={fieldsDisabled}
          >
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
        </label>
        <label className="field-stack">
          <span>新正典预算</span>
          <select
            value={form.canon_budget}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                canon_budget: event.target.value as ChapterTaskDraftRequest["canon_budget"],
              }))
            }
            disabled={fieldsDisabled}
          >
            <option value="none">无</option>
            <option value="minor">少量</option>
            <option value="normal">正常</option>
          </select>
        </label>

        <fieldset className="chapter-task-secondary field-stack-wide" disabled={fieldsDisabled}>
          <legend>次要功能</legend>
          <div>
            {FUNCTION_OPTIONS.map((option) => (
              <label className="checkbox-row" key={option.value}>
                <input
                  type="checkbox"
                  checked={form.secondary_functions.includes(option.value)}
                  onChange={() => toggleSecondary(option.value)}
                  disabled={
                    fieldsDisabled ||
                    (!form.secondary_functions.includes(option.value) &&
                      (option.value === form.primary_function ||
                        (form.canon_budget === "none" &&
                          NONE_BUDGET_INCOMPATIBLE_FUNCTIONS.has(option.value))))
                  }
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {(
          [
            ["must_carry", "必须承接"],
            ["allowed_advances", "允许推进"],
            ["forbidden_advances", "禁止推进"],
            ["required_characters", "必须出现人物"],
            ["allowed_scene_types", "允许场景类型"],
            ["forbidden_scene_drivers", "禁止场景驱动力"],
          ] as Array<[ListField, string]>
        ).map(([field, label]) => (
          <label className="field-stack" key={field}>
            <span>{label}（每行一项）</span>
            <textarea
              value={listValue(form[field])}
              onChange={(event) => updateList(field, event.target.value)}
              disabled={fieldsDisabled}
            />
          </label>
        ))}

        {(
          [
            ["relationship_goal", "关系目标"],
            ["decision_goal", "小决定目标"],
            ["ending_state", "结尾状态"],
            ["notes", "备注"],
          ] as Array<[TextField, string]>
        ).map(([field, label]) => (
          <label className={`field-stack ${field === "notes" ? "field-stack-wide" : ""}`} key={field}>
            <span>{label}</span>
            <textarea
              value={form[field]}
              onChange={(event) => updateText(field, event.target.value)}
              disabled={fieldsDisabled}
            />
          </label>
        ))}
      </div>

      <div className="chapter-task-actions">
        <button
          className="button secondary-button"
          type="button"
          onClick={() => void saveDraft()}
          disabled={fieldsDisabled || consistencyErrors.length > 0}
        >
          {saving
            ? "保存中..."
            : data?.latest_draft
              ? "保存草稿"
              : data?.approved
                ? "创建新草稿修订"
                : "保存草稿"}
        </button>
        <button
          className="button primary-button"
          type="button"
          onClick={() => void approveDraft()}
          disabled={fieldsDisabled || consistencyErrors.length > 0 || !data?.latest_draft}
        >
          {approving ? "批准中..." : "批准草稿"}
        </button>
      </div>

      {editableSource?.status === "draft" && (
        <p className="state-text warning-text">当前是 draft revision {editableSource.revision}：草稿不会进入正文生成。</p>
      )}
      {consistencyErrors.length > 0 && (
        <div className="chapter-task-conflicts" role="alert">
          <strong>请先修正任务单冲突：</strong>
          <ul>
            {consistencyErrors.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {data?.approved && (
        <p className="state-text success-text">
          正文生成将使用 approved revision {data.approved.revision}（{data.approved.id}）。
        </p>
      )}
      {historySummary && <p className="chapter-task-history">历史：{historySummary}</p>}
      {message && <p className="state-text success-text">{message}</p>}
      {error && <p className="state-text error-text">{error}</p>}
    </section>
  );
}
