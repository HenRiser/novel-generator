import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Divider,
  Input,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from "antd";

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
  return value.split(/\r?\n/);
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
      `主要功能 ${form.primary_function} 与新增设定预算 none 不兼容；请修改章节功能或提高新增设定预算。`,
    );
  }
  const incompatibleSecondary = form.secondary_functions.filter(
    (item) =>
      form.canon_budget === "none" && NONE_BUDGET_INCOMPATIBLE_FUNCTIONS.has(item),
  );
  if (incompatibleSecondary.length > 0) {
    errors.push(
      `次要功能 ${incompatibleSecondary.join("、")} 与新增设定预算 none 不兼容；请修改章节功能或提高新增设定预算。`,
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
  onTaskStateChange,
}: {
  projectRef: string;
  chapterNumber: number;
  apiStatus: ApiStatus;
  disabled: boolean;
  onApprovedTaskChange: (task: ChapterTaskSheet | null) => void;
  onTaskStateChange?: (approved: ChapterTaskSheet | null, latestDraft: ChapterTaskSheet | null) => void;
}) {
  const [data, setData] = useState<ChapterTaskResponse | null>(null);
  const [form, setForm] = useState<ChapterTaskDraftRequest>({ ...EMPTY_FORM });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lifecycleRef = useRef(0);
  const loadedScopeRef = useRef<string | null>(null);
  const savedFormRef = useRef(JSON.stringify(EMPTY_FORM));
  const callbacksRef = useRef({ onApprovedTaskChange, onTaskStateChange });
  callbacksRef.current = { onApprovedTaskChange, onTaskStateChange };
  const scope = `${projectRef}:${chapterNumber}`;
  const activeScopeRef = useRef(scope);
  activeScopeRef.current = scope;
  const hasUnsavedChanges = JSON.stringify(form) !== savedFormRef.current;

  const editableSource = data?.latest_draft ?? data?.approved ?? null;
  const isWorkspaceProject = projectRef.startsWith("book:");
  const canUseApi = Boolean(projectRef && isWorkspaceProject && apiStatus === "online");
  const consistencyErrors = useMemo(() => formConsistencyErrors(form), [form]);
  const historySummary = useMemo(
    () => (data?.history ?? []).map((task) => `r${task.revision} ${task.status}`).join(" · "),
    [data],
  );

  useEffect(() => {
    lifecycleRef.current += 1;
    loadedScopeRef.current = null;
    callbacksRef.current.onApprovedTaskChange(null);
    callbacksRef.current.onTaskStateChange?.(null, null);
    setData(null);
    savedFormRef.current = JSON.stringify(EMPTY_FORM);
    setForm({ ...EMPTY_FORM });
    setError("");
    setMessage("");
    setLoading(false);
    setSaving(false);
    setApproving(false);
    return () => { lifecycleRef.current += 1; };
  }, [scope]);

  useEffect(() => {
    let ignore = false;
    if (!canUseApi || !Number.isInteger(chapterNumber) || chapterNumber < 1) {
      setLoading(false);
      return;
    }
    // A health-check reconnect must not replace an already loaded local draft.
    if (loadedScopeRef.current === scope) {
      return;
    }
    setLoading(true);
    setError("");
    void getChapterTask(projectRef, chapterNumber)
      .then((result) => {
        if (ignore || activeScopeRef.current !== scope) {
          return;
        }
        loadedScopeRef.current = scope;
        setData(result);
        const nextForm = toForm(result.latest_draft ?? result.approved);
        savedFormRef.current = JSON.stringify(nextForm);
        setForm(nextForm);
        callbacksRef.current.onApprovedTaskChange(result.approved);
        callbacksRef.current.onTaskStateChange?.(result.approved, result.latest_draft);
      })
      .catch((loadError) => {
        if (!ignore && activeScopeRef.current === scope) {
          setError(safePublicMessage(loadError instanceof Error ? loadError.message : "", "任务单读取失败。"));
        }
      })
      .finally(() => {
        if (!ignore && activeScopeRef.current === scope) {
          setLoading(false);
        }
      });
    return () => { ignore = true; };
  }, [canUseApi, chapterNumber, projectRef, scope]);

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
    const lifecycle = lifecycleRef.current;
    const isCurrent = () => lifecycleRef.current === lifecycle && activeScopeRef.current === scope;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const payload = { ...form };
      const listFields: ListField[] = ["must_carry", "allowed_advances", "forbidden_advances", "required_characters", "allowed_scene_types", "forbidden_scene_drivers"];
      for (const field of listFields) {
        payload[field] = [...new Set(form[field].map((item) => item.trim()).filter(Boolean))];
      }
      const result = await saveChapterTaskDraft(projectRef, chapterNumber, payload);
      if (!isCurrent()) return;
      setData(result);
      const nextForm = toForm(result.latest_draft);
      savedFormRef.current = JSON.stringify(nextForm);
      setForm(nextForm);
      callbacksRef.current.onApprovedTaskChange(result.approved);
      callbacksRef.current.onTaskStateChange?.(result.approved, result.latest_draft);
      setMessage("草稿已保存。草稿不会进入正文生成。");
    } catch (saveError) {
      if (!isCurrent()) return;
      setError(safePublicMessage(saveError instanceof Error ? saveError.message : "", "任务单草稿保存失败。"));
    } finally {
      if (isCurrent()) setSaving(false);
    }
  }

  async function approveDraft() {
    const draft = data?.latest_draft;
    if (!canUseApi || !draft || hasUnsavedChanges) {
      return;
    }
    const lifecycle = lifecycleRef.current;
    const isCurrent = () => lifecycleRef.current === lifecycle && activeScopeRef.current === scope;
    setApproving(true);
    setError("");
    setMessage("");
    try {
      const result = await approveChapterTask(projectRef, chapterNumber, draft.id, draft.revision);
      if (!isCurrent()) return;
      setData(result);
      const nextForm = toForm(result.approved);
      savedFormRef.current = JSON.stringify(nextForm);
      setForm(nextForm);
      callbacksRef.current.onApprovedTaskChange(result.approved);
      callbacksRef.current.onTaskStateChange?.(result.approved, result.latest_draft);
      setMessage(`版本 ${result.approved?.revision ?? draft.revision} 已批准，将用于本章正文生成。`);
    } catch (approveError) {
      if (!isCurrent()) return;
      setError(safePublicMessage(approveError instanceof Error ? approveError.message : "", "任务单批准失败。"));
    } finally {
      if (isCurrent()) setApproving(false);
    }
  }

  const fieldsDisabled = !canUseApi || disabled || loading || saving || approving;

  const statusTag =
    data?.approved ? <Tag color="green">已生效（版本 {data.approved.revision}）</Tag>
    : data?.latest_draft ? <Tag color="orange">仅草稿</Tag>
    : <Tag>未创建</Tag>;

  return (
    <Card
      size="small"
      title={
        <Space>
          <Typography.Text strong>章节任务单</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            明确本章功能与约束，正文生成前可反复修订
          </Typography.Text>
        </Space>
      }
      extra={
        <Space>
          {statusTag}
          {loading && <Spin size="small" />}
        </Space>
      }
    >
      {!projectRef && <Alert type="info" showIcon message="选择 workspace 项目后创建章节任务单。" />}
      {projectRef && !isWorkspaceProject && (
        <Alert type="warning" showIcon message="章节任务单 v1 仅支持 workspace book 项目。" />
      )}

      <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
        <Descriptions.Item label="生成生效">{data?.approved ? `版本 ${data.approved.revision}` : "无"}</Descriptions.Item>
        <Descriptions.Item label="编辑中">{data?.latest_draft ? `版本 ${data.latest_draft.revision}` : "无"}</Descriptions.Item>
      </Descriptions>

      {editableSource?.status === "draft" && (
        <Alert type="warning" showIcon message={`当前是草稿 版本 ${editableSource.revision}：草稿不会进入正文生成。`} style={{ marginBottom: 12 }} />
      )}
      {data?.approved && (
        <Alert type="success" showIcon message={`正文生成将使用已生效 版本 ${data.approved.revision}。`} style={{ marginBottom: 12 }} />
      )}
      {historySummary && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
          历史：{historySummary}
        </Typography.Text>
      )}
      {message && <Alert type="success" showIcon message={message} style={{ marginBottom: 12 }} />}
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError("")} style={{ marginBottom: 12 }} />}
      {consistencyErrors.length > 0 && (
        <Alert
          type="error"
          showIcon
          message="请先修正任务单冲突："
          description={<ul style={{ margin: 0, paddingLeft: 18 }}>{consistencyErrors.map((item) => <li key={item}>{item}</li>)}</ul>}
          style={{ marginBottom: 12 }}
        />
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontWeight: 500 }}>章节号</span>
          <Input aria-label="章节号" value={chapterNumber} readOnly disabled />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontWeight: 500 }}>主要功能</span>
          <Select
            aria-label="主要功能"
            value={form.primary_function}
            onChange={(value) => setForm((current) => ({ ...current, primary_function: value as ChapterTaskFunction }))}
            options={FUNCTION_OPTIONS}
            disabled={fieldsDisabled}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontWeight: 500 }}>强度</span>
          <Select
            aria-label="推进强度"
            value={form.intensity}
            onChange={(value) => setForm((current) => ({ ...current, intensity: value as ChapterTaskDraftRequest["intensity"] }))}
            options={[
              { value: "low", label: "低" },
              { value: "medium", label: "中" },
              { value: "high", label: "高" },
            ]}
            disabled={fieldsDisabled}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontWeight: 500 }}>新增设定预算</span>
          <Select
            aria-label="新增设定预算"
            value={form.canon_budget}
            onChange={(value) => setForm((current) => ({ ...current, canon_budget: value as ChapterTaskDraftRequest["canon_budget"] }))}
            options={[
              { value: "none", label: "无" },
              { value: "minor", label: "少量" },
              { value: "normal", label: "正常" },
            ]}
            disabled={fieldsDisabled}
          />
        </div>

        <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontWeight: 500 }}>次要功能（可多选）</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {FUNCTION_OPTIONS.map((option) => (
              <Checkbox
                key={option.value}
                checked={form.secondary_functions.includes(option.value)}
                onChange={() => toggleSecondary(option.value)}
                disabled={
                  fieldsDisabled ||
                  (!form.secondary_functions.includes(option.value) &&
                    (option.value === form.primary_function ||
                      (form.canon_budget === "none" &&
                        NONE_BUDGET_INCOMPATIBLE_FUNCTIONS.has(option.value))))
                }
              >
                {option.label}
              </Checkbox>
            ))}
          </div>
        </div>

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
          <div key={field} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontWeight: 500 }}>{label}（每行一项）</span>
            <Input.TextArea
              aria-label={label}
              value={listValue(form[field])}
              onChange={(event) => updateList(field, event.target.value)}
              disabled={fieldsDisabled}
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </div>
        ))}

        {(
          [
            ["relationship_goal", "关系目标"],
            ["decision_goal", "小决定目标"],
            ["ending_state", "结尾状态"],
            ["notes", "备注"],
          ] as Array<[TextField, string]>
        ).map(([field, label]) => (
          <div key={field} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontWeight: 500 }}>{label}</span>
            <Input.TextArea
              aria-label={label}
              value={form[field]}
              onChange={(event) => updateText(field, event.target.value)}
              disabled={fieldsDisabled}
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </div>
        ))}
      </div>

      {hasUnsavedChanges && <Alert type="info" showIcon message="有未保存的修改，请先保存草稿，再批准当前内容。" style={{ marginTop: 16 }} />}
      <Divider style={{ margin: "16px 0" }} />
      <Space>
        <Button
          type="default"
          onClick={() => void saveDraft()}
          disabled={fieldsDisabled || consistencyErrors.length > 0}
          loading={saving}
        >
          {data?.latest_draft ? "保存草稿" : data?.approved ? "创建新草稿修订" : "保存草稿"}
        </Button>
        <Button
          type="primary"
          onClick={() => void approveDraft()}
          disabled={fieldsDisabled || consistencyErrors.length > 0 || !data?.latest_draft || hasUnsavedChanges}
          loading={approving}
        >
          批准草稿
        </Button>
      </Space>
    </Card>
  );
}
