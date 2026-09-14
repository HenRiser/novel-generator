import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Divider,
  Input,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";

import {
  approveScenePlan,
  getScenePlan,
  safePublicMessage,
  saveScenePlanDraft,
} from "../api";
import type {
  ApiStatus,
  ChapterTaskSheet,
  ScenePlan,
  ScenePlanDraftRequest,
  ScenePlanResponse,
  ScenePlanScene,
} from "../types";


const EMPTY_SCENE: Omit<ScenePlanScene, "scene_no"> = {
  title: "",
  location: "",
  participants: [""],
  scene_function: "relationship_dialogue",
  allowed_information: [""],
  forbidden_information: ["不释放新正典信息"],
  emotional_shift: "",
  ending_state: "",
};

function withSceneNumbers(scenes: Array<Omit<ScenePlanScene, "scene_no"> | ScenePlanScene>): ScenePlanScene[] {
  return scenes.map((scene, index) => ({
    scene_no: index + 1,
    title: scene.title,
    location: scene.location,
    participants: [...scene.participants],
    scene_function: scene.scene_function,
    allowed_information: [...scene.allowed_information],
    forbidden_information: [...scene.forbidden_information],
    emotional_shift: scene.emotional_shift,
    ending_state: scene.ending_state,
  }));
}

function emptyForm(task: ChapterTaskSheet | null): ScenePlanDraftRequest {
  return {
    source_chapter_task_id: task?.id ?? null,
    source_chapter_task_revision: task?.revision ?? null,
    scenes: withSceneNumbers([
      { ...EMPTY_SCENE },
      { ...EMPTY_SCENE },
    ]),
  };
}

function toForm(plan: ScenePlan | null, task: ChapterTaskSheet | null): ScenePlanDraftRequest {
  if (!plan) {
    return emptyForm(task);
  }
  return {
    id: plan.id,
    revision: plan.status === "draft" ? plan.revision : undefined,
    source_chapter_task_id: plan.source_chapter_task_id,
    source_chapter_task_revision: plan.source_chapter_task_revision,
    scenes: withSceneNumbers(plan.scenes),
  };
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/);
}

function listValue(values: string[]): string {
  return values.join("\n");
}

function localValidationErrors(form: ScenePlanDraftRequest, approvedTask: ChapterTaskSheet | null): string[] {
  const errors: string[] = [];
  if (form.scenes.length < 2 || form.scenes.length > 4) {
    errors.push("场景计划 必须包含 2–4 个场景。");
  }
  form.scenes.forEach((scene) => {
    if (!scene.title.trim()) {
      errors.push(`场景 ${scene.scene_no} 缺少场景标题。`);
    }
    if (!scene.location.trim()) {
      errors.push(`场景 ${scene.scene_no} 缺少场景地点。`);
    }
    if (!scene.scene_function.trim()) {
      errors.push(`场景 ${scene.scene_no} 缺少场景功能。`);
    }
    if (!scene.emotional_shift.trim()) {
      errors.push(`场景 ${scene.scene_no} 缺少情绪转折。`);
    }
    if (!scene.ending_state.trim()) {
      errors.push(`场景 ${scene.scene_no} 缺少结尾状态。`);
    }
    if (scene.participants.filter((item) => item.trim()).length < 1) {
      errors.push(`场景 ${scene.scene_no} 至少需要 1 个出场人物。`);
    }
    if (scene.allowed_information.filter((item) => item.trim()).length < 1) {
      errors.push(`场景 ${scene.scene_no} 至少需要 1 条允许信息。`);
    }
    if (scene.forbidden_information.filter((item) => item.trim()).length < 1) {
      errors.push(`场景 ${scene.scene_no} 至少需要 1 条禁止信息。`);
    }
    if (
      approvedTask?.canon_budget === "none" &&
      ["information_reveal", "evidence_discovery", "archive_analysis", "clue_decoding"].includes(scene.scene_function)
    ) {
      errors.push(`场景 ${scene.scene_no} 的场景功能与“不增加新设定”的预算冲突。`);
    }
  });
  return errors;
}

export function ScenePlanPanel({
  projectRef,
  chapterNumber,
  apiStatus,
  disabled,
  approvedChapterTask,
  onScenePlanStateChange,
}: {
  projectRef: string;
  chapterNumber: number;
  apiStatus: ApiStatus;
  disabled: boolean;
  approvedChapterTask: ChapterTaskSheet | null;
  onScenePlanStateChange: (approved: ScenePlan | null, latestDraft: ScenePlan | null) => void;
}) {
  const [data, setData] = useState<ScenePlanResponse | null>(null);
  const [form, setForm] = useState<ScenePlanDraftRequest>(emptyForm(approvedChapterTask));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [showValidationErrors, setShowValidationErrors] = useState(false);
  const lifecycleRef = useRef(0);
  const loadedScopeRef = useRef<string | null>(null);
  const savedFormRef = useRef(JSON.stringify(emptyForm(approvedChapterTask)));
  const callbacksRef = useRef({ onScenePlanStateChange, approvedChapterTask });
  callbacksRef.current = { onScenePlanStateChange, approvedChapterTask };
  const scope = `${projectRef}:${chapterNumber}`;
  const activeScopeRef = useRef(scope);
  activeScopeRef.current = scope;
  const hasUnsavedChanges = JSON.stringify(form) !== savedFormRef.current;

  const isWorkspaceProject = projectRef.startsWith("book:");
  const canUseApi = Boolean(projectRef && isWorkspaceProject && apiStatus === "online");
  const currentApprovedTask = approvedChapterTask ?? data?.current_approved_chapter_task ?? null;
  const hasApprovedPlan = Boolean(data?.approved);
  const hasServerDraft = Boolean(data?.latest_draft);
  const scenePlanStatusLabel = loading
    ? "Loading"
    : data?.approved
      ? `已生效版本 ${data.approved.revision}`
      : data?.latest_draft
        ? `草稿版本 ${data.latest_draft.revision}`
        : "Not created";
  const validationErrors = useMemo(
    () => localValidationErrors(form, currentApprovedTask),
    [currentApprovedTask, form],
  );
  const historySummary = useMemo(
    () => (data?.history ?? []).map((plan) => `r${plan.revision} ${plan.status}`).join(" → "),
    [data],
  );
  const unboundTaskWarning = Boolean(
    currentApprovedTask &&
      (!form.source_chapter_task_id ||
        form.source_chapter_task_id !== currentApprovedTask.id ||
        form.source_chapter_task_revision !== currentApprovedTask.revision),
  );

  useEffect(() => {
    lifecycleRef.current += 1;
    loadedScopeRef.current = null;
    callbacksRef.current.onScenePlanStateChange(null, null);
    setData(null);
    const nextForm = emptyForm(callbacksRef.current.approvedChapterTask);
    savedFormRef.current = JSON.stringify(nextForm);
    setForm(nextForm);
    setError("");
    setMessage("");
    setShowValidationErrors(false);
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
    // Connectivity and task updates are not instructions to discard local edits.
    if (loadedScopeRef.current === scope) {
      return;
    }
    setLoading(true);
    setError("");
    void getScenePlan(projectRef, chapterNumber)
      .then((result) => {
        if (ignore || activeScopeRef.current !== scope) {
          return;
        }
        loadedScopeRef.current = scope;
        setData(result);
        const task = result.current_approved_chapter_task ?? callbacksRef.current.approvedChapterTask;
        const nextForm = toForm(result.latest_draft ?? result.approved, task);
        savedFormRef.current = JSON.stringify(nextForm);
        setForm(nextForm);
        callbacksRef.current.onScenePlanStateChange(result.approved, result.latest_draft);
      })
      .catch((loadError) => {
        if (!ignore && activeScopeRef.current === scope) {
          setError(safePublicMessage(loadError instanceof Error ? loadError.message : "", "场景计划读取失败。"));
        }
      })
      .finally(() => {
        if (!ignore && activeScopeRef.current === scope) {
          setLoading(false);
        }
      });
    return () => { ignore = true; };
  }, [canUseApi, chapterNumber, projectRef, scope]);

  function updateScene(index: number, patch: Partial<ScenePlanScene>) {
    setForm((current) => ({
      ...current,
      scenes: withSceneNumbers(current.scenes.map((scene, sceneIndex) => (sceneIndex === index ? { ...scene, ...patch } : scene))),
    }));
    setMessage("");
  }

  function addScene() {
    setForm((current) => {
      if (current.scenes.length >= 4) {
        return current;
      }
      return {
        ...current,
        scenes: withSceneNumbers([...current.scenes, { ...EMPTY_SCENE }]),
      };
    });
    setMessage("");
  }

  function deleteScene(index: number) {
    setForm((current) => {
      if (current.scenes.length <= 2) {
        return current;
      }
      return {
        ...current,
        scenes: withSceneNumbers(current.scenes.filter((_, sceneIndex) => sceneIndex !== index)),
      };
    });
    setMessage("");
  }

  function moveScene(index: number, direction: -1 | 1) {
    setForm((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.scenes.length) {
        return current;
      }
      const scenes = [...current.scenes];
      [scenes[index], scenes[target]] = [scenes[target], scenes[index]];
      return { ...current, scenes: withSceneNumbers(scenes) };
    });
    setMessage("");
  }

  function bindCurrentTask() {
    setForm((current) => ({
      ...current,
      source_chapter_task_id: currentApprovedTask?.id ?? null,
      source_chapter_task_revision: currentApprovedTask?.revision ?? null,
    }));
    setMessage("");
  }

  function normalizedForm(): ScenePlanDraftRequest {
    return {
      ...form,
      source_chapter_task_id: form.source_chapter_task_id || null,
      source_chapter_task_revision: form.source_chapter_task_id ? form.source_chapter_task_revision ?? null : null,
      scenes: withSceneNumbers(
        form.scenes.map((scene) => ({
          ...scene,
          title: scene.title.trim(),
          location: scene.location.trim(),
          scene_function: scene.scene_function.trim(),
          participants: scene.participants.map((item) => item.trim()).filter(Boolean),
          allowed_information: scene.allowed_information.map((item) => item.trim()).filter(Boolean),
          forbidden_information: scene.forbidden_information.map((item) => item.trim()).filter(Boolean),
          emotional_shift: scene.emotional_shift.trim(),
          ending_state: scene.ending_state.trim(),
        })),
      ),
    };
  }

  async function saveDraft() {
    if (!canUseApi) {
      return;
    }
    setShowValidationErrors(true);
    if (validationErrors.length > 0) {
      setError("");
      return;
    }
    const lifecycle = lifecycleRef.current;
    const isCurrent = () => lifecycleRef.current === lifecycle && activeScopeRef.current === scope;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await saveScenePlanDraft(projectRef, chapterNumber, normalizedForm());
      if (!isCurrent()) return;
      setData(result);
      const nextForm = toForm(result.latest_draft, result.current_approved_chapter_task ?? callbacksRef.current.approvedChapterTask);
      savedFormRef.current = JSON.stringify(nextForm);
      setForm(nextForm);
      callbacksRef.current.onScenePlanStateChange(result.approved, result.latest_draft);
      setShowValidationErrors(false);
      setMessage("场景计划草稿已保存。批准后才会进入正文生成。");
    } catch (saveError) {
      if (!isCurrent()) return;
      setError(safePublicMessage(saveError instanceof Error ? saveError.message : "", "场景计划 draft 保存失败。"));
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
      const result = await approveScenePlan(projectRef, chapterNumber, draft.id, draft.revision);
      if (!isCurrent()) return;
      setData(result);
      const nextForm = toForm(result.latest_draft ?? result.approved, result.current_approved_chapter_task ?? callbacksRef.current.approvedChapterTask);
      savedFormRef.current = JSON.stringify(nextForm);
      setForm(nextForm);
      callbacksRef.current.onScenePlanStateChange(result.approved, result.latest_draft);
      setShowValidationErrors(false);
      setMessage("场景计划已批准，将用于本章正文生成。");
    } catch (approveError) {
      if (!isCurrent()) return;
      setError(safePublicMessage(approveError instanceof Error ? approveError.message : "", "场景计划 批准失败。"));
    } finally {
      if (isCurrent()) setApproving(false);
    }
  }

  const fieldsDisabled = !canUseApi || disabled || loading || saving || approving;

  if (!isWorkspaceProject) {
    return null;
  }

  return (
    <Card
      size="small"
      title={
        <Space>
          <Typography.Text strong>场景计划</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            把任务单拆成 2–4 个场景，仅已批准的场景计划会进入正文生成
          </Typography.Text>
        </Space>
      }
      extra={
        <Space>
          {data?.approved ? (
            <Tag color="green">已生效 版本 {data.approved.revision}</Tag>
          ) : data?.latest_draft ? (
            <Tag color="orange">仅草稿</Tag>
          ) : (
            <Tag>未创建</Tag>
          )}
          {loading && <Spin size="small" />}
        </Space>
      }
    >
      <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
        <Descriptions.Item label="生成生效">{data?.approved ? `版本 ${data.approved.revision}` : "无"}</Descriptions.Item>
        <Descriptions.Item label="编辑中">{data?.latest_draft ? `版本 ${data.latest_draft.revision}` : "无"}</Descriptions.Item>
      </Descriptions>

      {historySummary && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
          历史：{historySummary}
        </Typography.Text>
      )}
      {hasServerDraft && !hasApprovedPlan && (
        <Alert type="warning" showIcon message="场景计划只有草稿，当前不会进入正文生成。" style={{ marginBottom: 12 }} />
      )}
      {unboundTaskWarning && (
        <Alert
          type="warning"
          showIcon
          message="当前场景计划未绑定当前已生效的任务单。"
          action={<Button size="small" onClick={bindCurrentTask} disabled={fieldsDisabled}>绑定当前任务单</Button>}
          style={{ marginBottom: 12 }}
        />
      )}
      {message && <Alert type="success" showIcon message={message} style={{ marginBottom: 12 }} />}
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError("")} style={{ marginBottom: 12 }} />}
      {showValidationErrors && validationErrors.length > 0 && (
        <Alert type="warning" showIcon message={validationErrors[0]} style={{ marginBottom: 12 }} />
      )}

      <div className="scene-task-binding">
        <span>关联章节任务</span>
        <strong>{form.source_chapter_task_id ? `第 ${chapterNumber} 章 · 任务版本 ${form.source_chapter_task_revision}` : "尚未关联任务单"}</strong>
        <small>使用已批准的任务单，确保场景与本章目标一致。</small>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {form.scenes.map((scene, index) => (
          <Card
            key={scene.scene_no}
            size="small"
            title={`场景 ${scene.scene_no}`}
            extra={
              <Space>
                <Button size="small" onClick={() => moveScene(index, -1)} disabled={fieldsDisabled || index === 0}>上移</Button>
                <Button size="small" onClick={() => moveScene(index, 1)} disabled={fieldsDisabled || index === form.scenes.length - 1}>下移</Button>
                <Button size="small" danger onClick={() => deleteScene(index)} disabled={fieldsDisabled || form.scenes.length <= 2}>删除</Button>
              </Space>
            }
          >
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))", gap: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>场景标题</span>
                <Input aria-label={`场景 ${scene.scene_no} · 场景标题`} value={scene.title} onChange={(event) => updateScene(index, { title: event.target.value })} disabled={fieldsDisabled} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>场景地点</span>
                <Input aria-label={`场景 ${scene.scene_no} · 场景地点`} value={scene.location} onChange={(event) => updateScene(index, { location: event.target.value })} disabled={fieldsDisabled} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>场景功能</span>
                <Input aria-label={`场景 ${scene.scene_no} · 场景功能`} value={scene.scene_function} onChange={(event) => updateScene(index, { scene_function: event.target.value })} disabled={fieldsDisabled} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>情绪转折</span>
                <Input aria-label={`场景 ${scene.scene_no} · 情绪转折`} value={scene.emotional_shift} onChange={(event) => updateScene(index, { emotional_shift: event.target.value })} disabled={fieldsDisabled} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>出场人物（每行一个）</span>
                <Input.TextArea
                  aria-label={`场景 ${scene.scene_no} · 出场人物`}
                  value={listValue(scene.participants)}
                  onChange={(event) => updateScene(index, { participants: splitLines(event.target.value) })}
                  disabled={fieldsDisabled}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>允许信息（每行一条）</span>
                <Input.TextArea
                  aria-label={`场景 ${scene.scene_no} · 允许信息`}
                  value={listValue(scene.allowed_information)}
                  onChange={(event) => updateScene(index, { allowed_information: splitLines(event.target.value) })}
                  disabled={fieldsDisabled}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>禁止信息（每行一条）</span>
                <Input.TextArea
                  aria-label={`场景 ${scene.scene_no} · 禁止信息`}
                  value={listValue(scene.forbidden_information)}
                  onChange={(event) => updateScene(index, { forbidden_information: splitLines(event.target.value) })}
                  disabled={fieldsDisabled}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>结尾状态</span>
                <Input.TextArea
                  aria-label={`场景 ${scene.scene_no} · 结尾状态`}
                  value={scene.ending_state}
                  onChange={(event) => updateScene(index, { ending_state: event.target.value })}
                  disabled={fieldsDisabled}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
              </div>
            </div>
          </Card>
        ))}
      </div>

      {hasUnsavedChanges && <Alert type="info" showIcon message="有未保存的修改，请先保存草稿，再批准当前内容。" style={{ marginTop: 16 }} />}
      <Divider style={{ margin: "16px 0" }} />
      <Space>
        <Button onClick={addScene} disabled={fieldsDisabled || form.scenes.length >= 4}>添加场景</Button>
        <Button onClick={() => void saveDraft()} disabled={fieldsDisabled || saving} loading={saving}>保存草稿</Button>
        <Button type="primary" onClick={() => void approveDraft()} disabled={fieldsDisabled || approving || !data?.latest_draft || hasUnsavedChanges} loading={approving}>
          批准草稿
        </Button>
      </Space>
    </Card>
  );
}
