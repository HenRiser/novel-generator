import { useEffect, useMemo, useState } from "react";
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

function localValidationErrors(form: ScenePlanDraftRequest, approvedTask: ChapterTaskSheet | null): string[] {
  const errors: string[] = [];
  if (form.scenes.length < 2 || form.scenes.length > 4) {
    errors.push("Scene Plan 必须包含 2–4 个场景。");
  }
  form.scenes.forEach((scene) => {
    if (!scene.title.trim()) {
      errors.push(`Scene ${scene.scene_no} 缺少 title。`);
    }
    if (!scene.location.trim()) {
      errors.push(`Scene ${scene.scene_no} 缺少 location。`);
    }
    if (!scene.scene_function.trim()) {
      errors.push(`Scene ${scene.scene_no} 缺少 scene_function。`);
    }
    if (!scene.emotional_shift.trim()) {
      errors.push(`Scene ${scene.scene_no} 缺少 emotional_shift。`);
    }
    if (!scene.ending_state.trim()) {
      errors.push(`Scene ${scene.scene_no} 缺少 ending_state。`);
    }
    if (scene.participants.filter((item) => item.trim()).length < 1) {
      errors.push(`Scene ${scene.scene_no} 至少需要 1 个 participant。`);
    }
    if (scene.allowed_information.filter((item) => item.trim()).length < 1) {
      errors.push(`Scene ${scene.scene_no} 至少需要 1 条 allowed_information。`);
    }
    if (scene.forbidden_information.filter((item) => item.trim()).length < 1) {
      errors.push(`Scene ${scene.scene_no} 至少需要 1 条 forbidden_information。`);
    }
    if (
      approvedTask?.canon_budget === "none" &&
      ["information_reveal", "evidence_discovery", "archive_analysis", "clue_decoding"].includes(scene.scene_function)
    ) {
      errors.push(`Scene ${scene.scene_no} 的 scene_function 与 canon_budget=none 冲突。`);
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

  const isWorkspaceProject = projectRef.startsWith("book:");
  const canUseApi = Boolean(projectRef && isWorkspaceProject && apiStatus === "online");
  const currentApprovedTask = data?.current_approved_chapter_task ?? approvedChapterTask;
  const hasApprovedPlan = Boolean(data?.approved);
  const hasServerDraft = Boolean(data?.latest_draft);
  const scenePlanStatusLabel = loading
    ? "Loading"
    : data?.approved
      ? `Approved revision ${data.approved.revision}`
      : data?.latest_draft
        ? `Draft revision ${data.latest_draft.revision}`
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
    let ignore = false;
    onScenePlanStateChange(null, null);
    setData(null);
    setForm(emptyForm(approvedChapterTask));
    setError("");
    setMessage("");
    setShowValidationErrors(false);

    if (!canUseApi || !Number.isInteger(chapterNumber) || chapterNumber < 1) {
      return () => {
        ignore = true;
      };
    }

    setLoading(true);
    void getScenePlan(projectRef, chapterNumber)
      .then((result) => {
        if (ignore) {
          return;
        }
        setData(result);
        const task = result.current_approved_chapter_task ?? approvedChapterTask;
        setForm(toForm(result.latest_draft ?? result.approved, task));
        onScenePlanStateChange(result.approved, result.latest_draft);
      })
      .catch((loadError) => {
        if (!ignore) {
          setError(safePublicMessage(loadError instanceof Error ? loadError.message : "", "Scene Plan 读取失败。"));
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
  }, [approvedChapterTask, canUseApi, chapterNumber, onScenePlanStateChange, projectRef]);

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
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await saveScenePlanDraft(projectRef, chapterNumber, normalizedForm());
      setData(result);
      setForm(toForm(result.latest_draft, result.current_approved_chapter_task ?? approvedChapterTask));
      onScenePlanStateChange(result.approved, result.latest_draft);
      setShowValidationErrors(false);
      setMessage("Scene Plan draft 已保存。draft 不会进入正文生成。");
    } catch (saveError) {
      setError(safePublicMessage(saveError instanceof Error ? saveError.message : "", "Scene Plan draft 保存失败。"));
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
      const result = await approveScenePlan(projectRef, chapterNumber, draft.id, draft.revision);
      setData(result);
      setForm(toForm(result.latest_draft ?? result.approved, result.current_approved_chapter_task ?? approvedChapterTask));
      onScenePlanStateChange(result.approved, result.latest_draft);
      setShowValidationErrors(false);
      setMessage("Scene Plan draft 已批准。approved revision 将用于正文生成。");
    } catch (approveError) {
      setError(safePublicMessage(approveError instanceof Error ? approveError.message : "", "Scene Plan 批准失败。"));
    } finally {
      setApproving(false);
    }
  }

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
            <Tag color="green">已生效 revision {data.approved.revision}</Tag>
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
        <Descriptions.Item label="生成生效">{data?.approved ? `revision ${data.approved.revision}` : "无"}</Descriptions.Item>
        <Descriptions.Item label="编辑中">{data?.latest_draft ? `revision ${data.latest_draft.revision}` : "无"}</Descriptions.Item>
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
          action={<Button size="small" onClick={bindCurrentTask} disabled={disabled}>绑定当前任务单</Button>}
          style={{ marginBottom: 12 }}
        />
      )}
      {message && <Alert type="success" showIcon message={message} style={{ marginBottom: 12 }} />}
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError("")} style={{ marginBottom: 12 }} />}
      {showValidationErrors && validationErrors.length > 0 && (
        <Alert type="warning" showIcon message={validationErrors[0]} style={{ marginBottom: 12 }} />
      )}

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
          <span style={{ fontWeight: 500 }}>来源任务单 ID</span>
          <Input
            value={form.source_chapter_task_id ?? ""}
            onChange={(event) => setForm((current) => ({ ...current, source_chapter_task_id: event.target.value || null }))}
            disabled={disabled}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
          <span style={{ fontWeight: 500 }}>来源任务单修订号</span>
          <Input
            type="number"
            min={1}
            step={1}
            value={form.source_chapter_task_revision ?? ""}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                source_chapter_task_revision: event.target.value ? Number.parseInt(event.target.value, 10) : null,
              }))
            }
            disabled={disabled}
          />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {form.scenes.map((scene, index) => (
          <Card
            key={scene.scene_no}
            size="small"
            title={`场景 ${scene.scene_no}`}
            extra={
              <Space>
                <Button size="small" onClick={() => moveScene(index, -1)} disabled={disabled || index === 0}>上移</Button>
                <Button size="small" onClick={() => moveScene(index, 1)} disabled={disabled || index === form.scenes.length - 1}>下移</Button>
                <Button size="small" danger onClick={() => deleteScene(index)} disabled={disabled || form.scenes.length <= 2}>删除</Button>
              </Space>
            }
          >
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>场景标题</span>
                <Input value={scene.title} onChange={(event) => updateScene(index, { title: event.target.value })} disabled={disabled} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>场景地点</span>
                <Input value={scene.location} onChange={(event) => updateScene(index, { location: event.target.value })} disabled={disabled} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>场景功能</span>
                <Input value={scene.scene_function} onChange={(event) => updateScene(index, { scene_function: event.target.value })} disabled={disabled} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>情绪转折</span>
                <Input value={scene.emotional_shift} onChange={(event) => updateScene(index, { emotional_shift: event.target.value })} disabled={disabled} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>出场人物（每行一个）</span>
                <Input.TextArea
                  value={listValue(scene.participants)}
                  onChange={(event) => updateScene(index, { participants: splitLines(event.target.value) })}
                  disabled={disabled}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>允许信息（每行一条）</span>
                <Input.TextArea
                  value={listValue(scene.allowed_information)}
                  onChange={(event) => updateScene(index, { allowed_information: splitLines(event.target.value) })}
                  disabled={disabled}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>禁止信息（每行一条）</span>
                <Input.TextArea
                  value={listValue(scene.forbidden_information)}
                  onChange={(event) => updateScene(index, { forbidden_information: splitLines(event.target.value) })}
                  disabled={disabled}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontWeight: 500 }}>结尾状态</span>
                <Input.TextArea
                  value={scene.ending_state}
                  onChange={(event) => updateScene(index, { ending_state: event.target.value })}
                  disabled={disabled}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Divider style={{ margin: "16px 0" }} />
      <Space>
        <Button onClick={addScene} disabled={disabled || form.scenes.length >= 4}>添加场景</Button>
        <Button onClick={() => void saveDraft()} disabled={disabled || saving} loading={saving}>保存草稿</Button>
        <Button type="primary" onClick={() => void approveDraft()} disabled={disabled || approving || !data?.latest_draft} loading={approving}>
          批准草稿
        </Button>
      </Space>
    </Card>
  );
}
