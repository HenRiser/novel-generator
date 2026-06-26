import { useEffect, useMemo, useState } from "react";

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

  const isWorkspaceProject = projectRef.startsWith("book:");
  const canUseApi = Boolean(projectRef && isWorkspaceProject && apiStatus === "online");
  const currentApprovedTask = data?.current_approved_chapter_task ?? approvedChapterTask;
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
    if (validationErrors.length > 0) {
      setError(validationErrors[0]);
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
    <section className="panel scene-plan-panel">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Scene Plan</span>
          <h2>Scene Plan Foundation</h2>
          <p>把任务单拆成 2–4 个 approved 场景。只有 approved Scene Plan 会进入正文生成。</p>
        </div>
        <span className="status-badge">{loading ? "Loading" : data?.approved ? "Approved" : "Draft only"}</span>
      </div>

      <div className="chapter-task-version-status">
        <span>生成生效：{data?.approved ? `approved revision ${data.approved.revision}` : "无"}</span>
        <span>编辑中：{data?.latest_draft ? `draft revision ${data.latest_draft.revision}` : "无"}</span>
      </div>
      {historySummary && <p className="muted-text">History: {historySummary}</p>}
      {data?.latest_draft && !data.approved && (
        <p className="state-text warning-text">Scene Plan 只有 draft，当前不会进入正文生成。</p>
      )}
      {unboundTaskWarning && (
        <div className="hint-box warning-box">
          <p>当前 Scene Plan 未绑定当前 approved Chapter Task Sheet。</p>
          <button className="button subtle-button compact-button" type="button" onClick={bindCurrentTask} disabled={disabled}>
            绑定当前任务单
          </button>
        </div>
      )}

      <div className="task-form-grid">
        <label>
          <span>source_chapter_task_id</span>
          <input
            value={form.source_chapter_task_id ?? ""}
            onChange={(event) => setForm((current) => ({ ...current, source_chapter_task_id: event.target.value || null }))}
            disabled={disabled}
          />
        </label>
        <label>
          <span>source_chapter_task_revision</span>
          <input
            type="number"
            min="1"
            step="1"
            value={form.source_chapter_task_revision ?? ""}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                source_chapter_task_revision: event.target.value ? Number.parseInt(event.target.value, 10) : null,
              }))
            }
            disabled={disabled}
          />
        </label>
      </div>

      <div className="scene-plan-scenes">
        {form.scenes.map((scene, index) => (
          <fieldset className="scene-plan-scene" key={scene.scene_no}>
            <legend>Scene {scene.scene_no}</legend>
            <div className="scene-plan-scene-actions">
              <button className="button subtle-button compact-button" type="button" onClick={() => moveScene(index, -1)} disabled={disabled || index === 0}>
                上移
              </button>
              <button className="button subtle-button compact-button" type="button" onClick={() => moveScene(index, 1)} disabled={disabled || index === form.scenes.length - 1}>
                下移
              </button>
              <button className="button subtle-button compact-button" type="button" onClick={() => deleteScene(index)} disabled={disabled || form.scenes.length <= 2}>
                删除
              </button>
            </div>
            <div className="task-form-grid">
              <label>
                <span>title</span>
                <input value={scene.title} onChange={(event) => updateScene(index, { title: event.target.value })} disabled={disabled} />
              </label>
              <label>
                <span>location</span>
                <input value={scene.location} onChange={(event) => updateScene(index, { location: event.target.value })} disabled={disabled} />
              </label>
              <label>
                <span>scene_function</span>
                <input value={scene.scene_function} onChange={(event) => updateScene(index, { scene_function: event.target.value })} disabled={disabled} />
              </label>
              <label>
                <span>emotional_shift</span>
                <input value={scene.emotional_shift} onChange={(event) => updateScene(index, { emotional_shift: event.target.value })} disabled={disabled} />
              </label>
              <label className="wide-field">
                <span>participants（每行一个）</span>
                <textarea value={listValue(scene.participants)} onChange={(event) => updateScene(index, { participants: splitLines(event.target.value) })} disabled={disabled} />
              </label>
              <label className="wide-field">
                <span>allowed_information（每行一条）</span>
                <textarea value={listValue(scene.allowed_information)} onChange={(event) => updateScene(index, { allowed_information: splitLines(event.target.value) })} disabled={disabled} />
              </label>
              <label className="wide-field">
                <span>forbidden_information（每行一条）</span>
                <textarea value={listValue(scene.forbidden_information)} onChange={(event) => updateScene(index, { forbidden_information: splitLines(event.target.value) })} disabled={disabled} />
              </label>
              <label className="wide-field">
                <span>ending_state</span>
                <textarea value={scene.ending_state} onChange={(event) => updateScene(index, { ending_state: event.target.value })} disabled={disabled} />
              </label>
            </div>
          </fieldset>
        ))}
      </div>

      <div className="chapter-task-actions">
        <button className="button subtle-button" type="button" onClick={addScene} disabled={disabled || form.scenes.length >= 4}>
          添加 scene
        </button>
        <button className="button secondary-button" type="button" onClick={() => void saveDraft()} disabled={disabled || saving}>
          {saving ? "保存中..." : "保存草稿"}
        </button>
        <button className="button primary-button" type="button" onClick={() => void approveDraft()} disabled={disabled || approving || !data?.latest_draft}>
          {approving ? "批准中..." : "批准草稿"}
        </button>
      </div>

      {validationErrors.length > 0 && <p className="state-text warning-text">{validationErrors[0]}</p>}
      {message && <p className="state-text success-text">{message}</p>}
      {error && <p className="state-text error-text">{error}</p>}
    </section>
  );
}
