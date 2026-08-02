import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Input,
  List,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";

import {
  acceptKnowledgeDraftChange,
  getKnowledgeDraft,
  listKnowledgeDrafts,
  rejectKnowledgeDraftChange,
  safePublicMessage,
} from "../../api";
import type {
  ApiStatus,
  CandidateChange,
  KnowledgeDraft,
  NarrativeGraphDocument,
  ProjectSummary,
} from "../../types";

type KnowledgeDraftReviewPanelProps = {
  apiStatus: ApiStatus;
  graph: NarrativeGraphDocument | null;
  onGraphUpdated: (graph: NarrativeGraphDocument) => void;
  selectedProject: ProjectSummary;
};

const SUPPORTED_ACCEPT_OPERATIONS = new Set(["create_node", "create_edge"]);
const TERMINAL_STATUSES = new Set(["accepted", "rejected", "superseded"]);
const PENDING_STATUSES = new Set(["pending", "pending_review"]);

function normalizedStatus(status: unknown): string {
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

function isPendingStatus(status: unknown): boolean {
  return PENDING_STATUSES.has(normalizedStatus(status));
}

function formatJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function changeStatus(change: CandidateChange): string {
  return change.status || "pending_review";
}

function canReview(change: CandidateChange): boolean {
  return !TERMINAL_STATUSES.has(changeStatus(change));
}

function canAccept(change: CandidateChange): boolean {
  return canReview(change) && SUPPORTED_ACCEPT_OPERATIONS.has(change.operation);
}

function statusLabel(status: string): string {
  const normalized = normalizedStatus(status);
  if (normalized === "pending" || normalized === "pending_review") {
    return "待审核";
  }
  if (normalized === "accepted") {
    return "已接受";
  }
  if (normalized === "rejected") {
    return "已拒绝";
  }
  if (normalized === "failed") {
    return "合并失败";
  }
  if (normalized === "superseded") {
    return "已替换";
  }
  if (normalized === "completed") {
    return "已完成";
  }
  if (status === "accepted") {
    return "已接受";
  }
  if (status === "rejected") {
    return "已拒绝";
  }
  if (status === "failed") {
    return "合并失败";
  }
  if (status === "superseded") {
    return "已替换";
  }
  return "待审核";
}

function confidenceLabel(confidence: number | undefined): string {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return "-";
  }
  return `${Math.round(confidence * 100)}%`;
}

function changeResult(change: CandidateChange): string {
  const result = change.result;
  if (!result) {
    return "";
  }
  if (result.created_node_id) {
    return `created_node_id: ${result.created_node_id}`;
  }
  if (result.created_edge_id) {
    return `created_edge_id: ${result.created_edge_id}`;
  }
  if (result.error) {
    return `error: ${result.error}`;
  }
  return "";
}

const NODE_TYPE_LABELS: Record<string, string> = {
  character: "人物",
  event: "事件",
  scene: "场景",
  foreshadowing: "伏笔",
  world_fact: "世界规则",
  plot_direction: "剧情方向",
  relationship_note: "关系备注",
  item: "物品",
  organization: "组织",
};

const EDGE_TYPE_LABELS: Record<string, string> = {
  appears_in: "出现在",
  causes: "导致",
  leads_to: "引向",
  reveals: "揭示",
  foreshadows: "埋下伏笔",
  monitors: "监视",
  constrains: "限制",
  protects: "保护",
  threatens: "威胁",
  located_at: "位于",
  related_to: "相关",
  changes_status_of: "改变状态",
};

const STORY_STATUS_LABELS: Record<string, string> = {
  active: "活跃",
  confirmed: "已确认",
  planned: "计划中",
  draft: "草稿",
  deprecated: "已废弃",
  completed: "已完成",
};

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return "未标注";
}

function readableNodeType(type: string): string {
  return NODE_TYPE_LABELS[type] || type || "故事资料";
}

function readableEdgeType(type: string): string {
  return EDGE_TYPE_LABELS[type] || type || "关系";
}

function readableStoryStatus(status: string): string {
  if (!status) {
    return "未指定";
  }
  return STORY_STATUS_LABELS[status] || status;
}

function payloadLabel(change: CandidateChange): string {
  return (
    textValue(change.payload.label) ||
    textValue(change.payload.name) ||
    textValue(change.payload.title) ||
    textValue(change.payload.summary) ||
    "未命名故事资料"
  );
}

function payloadSummary(change: CandidateChange): string {
  return (
    textValue(change.payload.summary) ||
    textValue(change.payload.description) ||
    textValue(change.payload.notes) ||
    textValue(change.evidence) ||
    "暂无说明。"
  );
}

function payloadStatus(change: CandidateChange): string {
  return readableStoryStatus(textValue(change.payload.status) || textValue(change.payload.suggested_status));
}

function graphNodeLabels(graph: NarrativeGraphDocument | null): Map<string, string> {
  const nodes = graph?.graph.nodes ?? [];
  return new Map(nodes.map((node) => [node.id, node.label || node.id]));
}

function draftCandidateLabels(draft: KnowledgeDraft | null): Map<string, string> {
  const labels = new Map<string, string>();
  for (const change of draft?.candidate_changes ?? []) {
    if (change.operation !== "create_node") {
      continue;
    }
    labels.set(change.id, payloadLabel(change));
    const createdNodeId = change.result?.created_node_id;
    if (createdNodeId) {
      labels.set(createdNodeId, payloadLabel(change));
    }
  }
  return labels;
}

function endpointLabel(
  change: CandidateChange,
  endpoint: "source" | "target",
  draftLabels: Map<string, string>,
  nodeLabels: Map<string, string>,
): string {
  const changeRef = textValue(change.payload[`${endpoint}_change_id`]);
  if (changeRef && draftLabels.has(changeRef)) {
    return draftLabels.get(changeRef) || "未知节点";
  }
  const directRef = textValue(change.payload[endpoint]) || textValue(change.payload[`${endpoint}_node_id`]);
  if (directRef && nodeLabels.has(directRef)) {
    return nodeLabels.get(directRef) || "未知节点";
  }
  if (directRef && draftLabels.has(directRef)) {
    return draftLabels.get(directRef) || "未知节点";
  }
  return "未知节点";
}

function summarizeDraft(draft: KnowledgeDraft): string {
  const changes = draft.candidate_changes ?? [];
  const pending = changes.filter((change) => isPendingStatus(changeStatus(change))).length;
  const accepted = changes.filter((change) => changeStatus(change) === "accepted").length;
  const rejected = changes.filter((change) => changeStatus(change) === "rejected").length;
  const failed = changes.filter((change) => changeStatus(change) === "failed").length;
  return `${changes.length} changes · ${pending} pending · ${accepted} accepted · ${rejected} rejected · ${failed} failed`;
}

function hasPendingCandidateChange(draft: KnowledgeDraft): boolean {
  return (draft.candidate_changes ?? []).some((change) => isPendingStatus(changeStatus(change)));
}

function isPendingDraft(draft: KnowledgeDraft): boolean {
  return isPendingStatus(draft.status) || hasPendingCandidateChange(draft);
}

function draftTimestamp(draft: KnowledgeDraft): number {
  const draftWithUpdatedAt = draft as KnowledgeDraft & { updated_at?: string };
  const rawTimestamp = textValue(draftWithUpdatedAt.updated_at) || textValue(draft.created_at);
  const timestamp = Date.parse(rawTimestamp);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function draftChapterNumber(draft: KnowledgeDraft): number {
  return typeof draft.chapter_number === "number" && Number.isFinite(draft.chapter_number)
    ? draft.chapter_number
    : 0;
}

function compareDraftsLatestFirst(left: KnowledgeDraft, right: KnowledgeDraft): number {
  const timestampDiff = draftTimestamp(right) - draftTimestamp(left);
  if (timestampDiff !== 0) {
    return timestampDiff;
  }

  const chapterDiff = draftChapterNumber(right) - draftChapterNumber(left);
  if (chapterDiff !== 0) {
    return chapterDiff;
  }

  return String(right.id || "").localeCompare(String(left.id || ""));
}

function sortDraftsLatestFirst(drafts: KnowledgeDraft[]): KnowledgeDraft[] {
  return [...drafts].sort(compareDraftsLatestFirst);
}

function pickDefaultDraft(drafts: KnowledgeDraft[]): KnowledgeDraft | null {
  const sorted = sortDraftsLatestFirst(drafts);
  return sorted.find((item) => isPendingDraft(item)) || sorted[0] || null;
}

export function KnowledgeDraftReviewPanel({
  apiStatus,
  graph,
  onGraphUpdated,
  selectedProject,
}: KnowledgeDraftReviewPanelProps) {
  const [drafts, setDrafts] = useState<KnowledgeDraft[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [draft, setDraft] = useState<KnowledgeDraft | null>(null);
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [busyChangeId, setBusyChangeId] = useState("");
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [selectionHint, setSelectionHint] = useState("");
  const selectedDraftIdRef = useRef("");

  const projectRef = selectedProject.project_ref;

  useEffect(() => {
    selectedDraftIdRef.current = selectedDraftId;
  }, [selectedDraftId]);

  useEffect(() => {
    selectedDraftIdRef.current = "";
    setSelectedDraftId("");
    setDraft(null);
    setSelectionHint("");
  }, [projectRef]);

  useEffect(() => {
    let ignore = false;

    async function loadDrafts() {
      setLoadingDrafts(true);
      setError("");
      setMessage("");
      try {
        const response = await listKnowledgeDrafts(projectRef);
        if (ignore) {
          return;
        }
        const nextDrafts = response.drafts;
        const currentSelection = selectedDraftIdRef.current;
        const currentStillExists = Boolean(currentSelection && nextDrafts.some((item) => item.id === currentSelection));
        const defaultDraft = pickDefaultDraft(nextDrafts);
        setDrafts(nextDrafts);
        if (currentStillExists) {
          setSelectedDraftId(currentSelection);
          setSelectionHint("");
        } else {
          setSelectedDraftId(defaultDraft?.id || "");
          setSelectionHint(defaultDraft && isPendingDraft(defaultDraft) ? "已自动定位到最新待审核草稿。" : "");
        }
        if (response.drafts.length === 0) {
          setDraft(null);
        }
      } catch (loadError) {
        if (!ignore) {
          setError(safePublicMessage(loadError instanceof Error ? loadError.message : "", "Knowledge Drafts 加载失败。"));
          setDrafts([]);
          setDraft(null);
          setSelectedDraftId("");
          setSelectionHint("");
        }
      } finally {
        if (!ignore) {
          setLoadingDrafts(false);
        }
      }
    }

    if (apiStatus === "online") {
      void loadDrafts();
    } else {
      setDrafts([]);
      setDraft(null);
      setSelectedDraftId("");
      setSelectionHint("");
    }

    return () => {
      ignore = true;
    };
  }, [apiStatus, projectRef, reloadToken]);

  useEffect(() => {
    let ignore = false;

    async function loadDraftDetail() {
      if (!selectedDraftId || apiStatus !== "online") {
        setDraft(null);
        return;
      }
      setLoadingDraft(true);
      setError("");
      try {
        const response = await getKnowledgeDraft(projectRef, selectedDraftId);
        if (!ignore) {
          setDraft(response.draft);
        }
      } catch (loadError) {
        if (!ignore) {
          setError(safePublicMessage(loadError instanceof Error ? loadError.message : "", "Knowledge Draft 详情加载失败。"));
          setDraft(null);
        }
      } finally {
        if (!ignore) {
          setLoadingDraft(false);
        }
      }
    }

    void loadDraftDetail();

    return () => {
      ignore = true;
    };
  }, [apiStatus, projectRef, reloadToken, selectedDraftId]);

  const sortedDrafts = useMemo(
    () => sortDraftsLatestFirst(drafts),
    [drafts],
  );
  const recommendedDraftId = useMemo(
    () => sortedDrafts.find((item) => isPendingDraft(item))?.id || "",
    [sortedDrafts],
  );
  const nodeLabels = useMemo(() => graphNodeLabels(graph), [graph]);
  const draftLabels = useMemo(() => draftCandidateLabels(draft), [draft]);

  function updateDraftState(nextDraft: KnowledgeDraft): void {
    setDraft(nextDraft);
    setDrafts((current) => current.map((item) => (item.id === nextDraft.id ? nextDraft : item)));
  }

  async function handleAccept(change: CandidateChange) {
    if (!canAccept(change)) {
      return;
    }
    setBusyChangeId(change.id);
    setError("");
    setMessage("");
    try {
      const response = await acceptKnowledgeDraftChange(projectRef, draft?.id || "", change.id, {
        review_note: reviewNotes[change.id] || "",
      });
      updateDraftState(response.draft);
      if (response.graph) {
        onGraphUpdated(response.graph);
      }
      setMessage("Candidate change accepted and merged into Narrative Graph.");
    } catch (acceptError) {
      setError(safePublicMessage(acceptError instanceof Error ? acceptError.message : "", "Candidate change accept failed."));
    } finally {
      setBusyChangeId("");
    }
  }

  async function handleReject(change: CandidateChange) {
    if (!canReview(change)) {
      return;
    }
    setBusyChangeId(change.id);
    setError("");
    setMessage("");
    try {
      const response = await rejectKnowledgeDraftChange(projectRef, draft?.id || "", change.id, {
        review_note: reviewNotes[change.id] || "",
      });
      updateDraftState(response.draft);
      setMessage("Candidate change rejected. Narrative Graph was not modified.");
    } catch (rejectError) {
      setError(safePublicMessage(rejectError instanceof Error ? rejectError.message : "", "Candidate change reject failed."));
    } finally {
      setBusyChangeId("");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card
        size="small"
        title={
          <Space>
            <Typography.Text strong>知识草稿审核</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              接受会写入正式叙事图谱，拒绝仅更新审核状态
            </Typography.Text>
          </Space>
        }
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => setReloadToken((value) => value + 1)}
            disabled={apiStatus !== "online" || loadingDrafts || Boolean(busyChangeId)}
          >
            刷新
          </Button>
        }
      >
        {selectionHint && <Alert type="info" showIcon message={selectionHint} style={{ marginBottom: 8 }} />}
        {message && <Alert type="success" showIcon message={message} style={{ marginBottom: 8 }} />}
        {error && <Alert type="error" showIcon message={error} closable onClose={() => setError("")} style={{ marginBottom: 8 }} />}
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 0.42fr) minmax(0, 1fr)", gap: 12, alignItems: "start" }}>
        <Card
          size="small"
          title="草稿列表"
          styles={{ body: { maxHeight: "calc(100vh - 360px)", overflowY: "auto" } }}
        >
          {loadingDrafts ? (
            <div style={{ textAlign: "center", padding: 24 }}><Spin /></div>
          ) : sortedDrafts.length === 0 ? (
            <Empty description="当前项目暂无知识草稿。" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <List
              size="small"
              dataSource={sortedDrafts}
              renderItem={(item) => {
                const pendingDraft = isPendingDraft(item);
                const recommendedDraft = recommendedDraftId === item.id;
                const selected = selectedDraftId === item.id;
                return (
                  <List.Item
                    style={{
                      cursor: "pointer",
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: selected ? "1px solid #d8a24a" : "1px solid transparent",
                      background: selected ? "#faf3e3" : "transparent",
                    }}
                    onClick={() => {
                      setSelectionHint("");
                      setSelectedDraftId(item.id);
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <Typography.Text strong>第 {item.chapter_number || "-"} 章</Typography.Text>
                        <Space size={4}>
                          {pendingDraft ? <Tag color="orange">待审核</Tag> : <Tag color="default">{statusLabel(item.status || "")}</Tag>}
                          {recommendedDraft && <Tag color="blue">推荐审核</Tag>}
                        </Space>
                      </div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.id}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{summarizeDraft(item)}</Typography.Text>
                    </div>
                  </List.Item>
                );
              }}
            />
          )}
        </Card>

        <Card
          size="small"
          title={draft ? `草稿详情 · 第 ${draft.chapter_number || "-"} 章` : "草稿详情"}
          styles={{ body: { maxHeight: "calc(100vh - 360px)", overflowY: "auto" } }}
        >
          {loadingDraft && <div style={{ textAlign: "center", padding: 24 }}><Spin /></div>}
          {!loadingDraft && !draft && <Empty description="请选择一个知识草稿。" image={Empty.PRESENTED_IMAGE_SIMPLE} />}

          {draft && (
            <>
              <Descriptions size="small" column={2} bordered style={{ marginBottom: 12 }}>
                <Descriptions.Item label="草稿 ID">{draft.id}</Descriptions.Item>
                <Descriptions.Item label="来源分析 ID">{draft.source_delta_id || "-"}</Descriptions.Item>
                <Descriptions.Item label="状态">{draft.status || "待审核"}</Descriptions.Item>
                <Descriptions.Item label="创建时间">{draft.created_at || "-"}</Descriptions.Item>
              </Descriptions>

              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {(draft.candidate_changes ?? []).map((change) => {
                  const status = changeStatus(change);
                  const supported = SUPPORTED_ACCEPT_OPERATIONS.has(change.operation);
                  const pendingReview = canReview(change);
                  const busy = busyChangeId === change.id;
                  const resultText = changeResult(change);
                  const nodeType = readableNodeType(textValue(change.payload.type) || textValue(change.payload.node_type));
                  const edgeType = readableEdgeType(textValue(change.payload.type));
                  const sourceLabel = endpointLabel(change, "source", draftLabels, nodeLabels);
                  const targetLabel = endpointLabel(change, "target", draftLabels, nodeLabels);
                  const cardTitle =
                    change.operation === "create_node"
                      ? `新增故事资料：${payloadLabel(change)}`
                      : change.operation === "create_edge"
                        ? "新增叙事关系"
                        : "暂不能直接合并的候选";

                  const statusTagColor =
                    status === "accepted" ? "green" : status === "rejected" ? "red" : status === "pending" || status === "pending_review" ? "orange" : "default";

                  return (
                    <Card key={change.id} size="small" type="inner">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <Tag color={statusTagColor}>{statusLabel(status)}</Tag>
                        {!supported && <Tag color="purple">暂不支持合并</Tag>}
                        <Typography.Text strong>{cardTitle}</Typography.Text>
                      </div>

                      {change.operation === "create_node" && (
                        <div style={{ marginBottom: 8 }}>
                          <Typography.Paragraph style={{ marginBottom: 8 }}>{payloadSummary(change)}</Typography.Paragraph>
                          <Descriptions size="small" column={2}>
                            <Descriptions.Item label="类型">{nodeType}</Descriptions.Item>
                            <Descriptions.Item label="重要度">{numberValue(change.payload.importance)}</Descriptions.Item>
                            <Descriptions.Item label="状态">{payloadStatus(change)}</Descriptions.Item>
                            <Descriptions.Item label="置信度">{confidenceLabel(change.confidence)}</Descriptions.Item>
                          </Descriptions>
                        </div>
                      )}

                      {change.operation === "create_edge" && (
                        <div style={{ marginBottom: 8 }}>
                          <Typography.Paragraph style={{ marginBottom: 8 }}>
                            <Typography.Text strong>{sourceLabel}</Typography.Text>
                            <Typography.Text type="secondary"> ──{textValue(change.payload.label) || edgeType}──&gt; </Typography.Text>
                            <Typography.Text strong>{targetLabel}</Typography.Text>
                          </Typography.Paragraph>
                          <Typography.Paragraph style={{ marginBottom: 8 }}>{payloadSummary(change)}</Typography.Paragraph>
                          <Descriptions size="small" column={2}>
                            <Descriptions.Item label="关系">{edgeType}</Descriptions.Item>
                            <Descriptions.Item label="重要度">{numberValue(change.payload.importance)}</Descriptions.Item>
                            <Descriptions.Item label="状态">{payloadStatus(change)}</Descriptions.Item>
                            <Descriptions.Item label="置信度">{confidenceLabel(change.confidence)}</Descriptions.Item>
                          </Descriptions>
                        </div>
                      )}

                      {!supported && (
                        <div style={{ marginBottom: 8 }}>
                          <Typography.Paragraph>系统当前还不支持自动合并这种变更类型。你可以拒绝它，或等待后续版本支持。</Typography.Paragraph>
                          <Descriptions size="small" column={2}>
                            <Descriptions.Item label="候选类型">{change.operation}</Descriptions.Item>
                            <Descriptions.Item label="置信度">{confidenceLabel(change.confidence)}</Descriptions.Item>
                          </Descriptions>
                        </div>
                      )}

                      {change.evidence && (
                        <div style={{ marginBottom: 8 }}>
                          <Typography.Text strong>证据：</Typography.Text>
                          <Typography.Text>{change.evidence}</Typography.Text>
                        </div>
                      )}
                      {change.rationale && (
                        <div style={{ marginBottom: 8 }}>
                          <Typography.Text strong>理由：</Typography.Text>
                          <Typography.Text>{change.rationale}</Typography.Text>
                        </div>
                      )}
                      {resultText && <Alert type="info" showIcon message={resultText} style={{ marginBottom: 8 }} />}

                      <details style={{ marginBottom: 8 }}>
                        <summary style={{ cursor: "pointer", color: "#8a7a63" }}>技术细节 / 调试信息</summary>
                        <Descriptions size="small" column={2} style={{ marginTop: 8 }}>
                          <Descriptions.Item label="操作">{change.operation}</Descriptions.Item>
                          <Descriptions.Item label="目标">{change.target || "-"}</Descriptions.Item>
                          <Descriptions.Item label="来源">{change.source || "-"}</Descriptions.Item>
                          <Descriptions.Item label="变更 ID">{change.id}</Descriptions.Item>
                        </Descriptions>
                        <pre style={{ background: "#faf6ee", padding: 8, borderRadius: 6, fontSize: 12, overflow: "auto" }}>
                          {formatJson(change.payload)}
                        </pre>
                      </details>

                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <Input.TextArea
                          placeholder="审核备注（可选）"
                          value={reviewNotes[change.id] || ""}
                          onChange={(event) => setReviewNotes((current) => ({ ...current, [change.id]: event.target.value }))}
                          disabled={!pendingReview || Boolean(busyChangeId)}
                          autoSize={{ minRows: 2, maxRows: 4 }}
                        />
                        <Space>
                          <Button
                            type="primary"
                            onClick={() => void handleAccept(change)}
                            disabled={!canAccept(change) || Boolean(busyChangeId)}
                            loading={busy}
                          >
                            接受
                          </Button>
                          <Button
                            danger
                            onClick={() => void handleReject(change)}
                            disabled={!pendingReview || Boolean(busyChangeId)}
                          >
                            拒绝
                          </Button>
                        </Space>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
