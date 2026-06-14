import { useEffect, useMemo, useState } from "react";

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
  onGraphUpdated: (graph: NarrativeGraphDocument) => void;
  selectedProject: ProjectSummary;
};

const SUPPORTED_ACCEPT_OPERATIONS = new Set(["create_node", "create_edge"]);
const TERMINAL_STATUSES = new Set(["accepted", "rejected", "superseded"]);

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
  if (status === "pending_review") {
    return "pending_review";
  }
  return status || "pending_review";
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

function summarizeDraft(draft: KnowledgeDraft): string {
  const changes = draft.candidate_changes ?? [];
  const pending = changes.filter((change) => changeStatus(change) === "pending_review").length;
  const accepted = changes.filter((change) => changeStatus(change) === "accepted").length;
  const rejected = changes.filter((change) => changeStatus(change) === "rejected").length;
  const failed = changes.filter((change) => changeStatus(change) === "failed").length;
  return `${changes.length} changes · ${pending} pending · ${accepted} accepted · ${rejected} rejected · ${failed} failed`;
}

export function KnowledgeDraftReviewPanel({
  apiStatus,
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

  const projectRef = selectedProject.project_ref;

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
        setDrafts(response.drafts);
        setSelectedDraftId((current) => {
          if (current && response.drafts.some((item) => item.id === current)) {
            return current;
          }
          return response.drafts[0]?.id || "";
        });
        if (response.drafts.length === 0) {
          setDraft(null);
        }
      } catch (loadError) {
        if (!ignore) {
          setError(safePublicMessage(loadError instanceof Error ? loadError.message : "", "Knowledge Drafts 加载失败。"));
          setDrafts([]);
          setDraft(null);
          setSelectedDraftId("");
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
    () =>
      [...drafts].sort((left, right) =>
        String(right.created_at || "").localeCompare(String(left.created_at || "")),
      ),
    [drafts],
  );

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
    <section className="knowledge-draft-panel" aria-label="Knowledge Draft Review">
      <section className="panel knowledge-draft-summary">
        <div className="panel-header">
          <div>
            <span className="section-kicker">Review & Merge</span>
            <h2>草稿审核 / Knowledge Drafts</h2>
          </div>
          <button
            className="button subtle-button compact-button"
            type="button"
            onClick={() => setReloadToken((value) => value + 1)}
            disabled={apiStatus !== "online" || loadingDrafts || Boolean(busyChangeId)}
          >
            刷新
          </button>
        </div>
        <p className="review-notice">
          Accepting supported create_node / create_edge changes writes them into the formal Narrative Graph. Rejecting a change only updates the draft review state.
        </p>
        {message && <p className="state-text success-text">{message}</p>}
        {error && <p className="state-text error-text">{error}</p>}
      </section>

      <section className="knowledge-draft-grid">
        <section className="panel graph-list-panel">
          <div className="panel-header">
            <div>
              <span className="section-kicker">Drafts</span>
              <h2>Draft 列表</h2>
            </div>
          </div>
          {loadingDrafts && <p className="state-text loading-text">正在加载 Knowledge Drafts...</p>}
          {!loadingDrafts && sortedDrafts.length === 0 && <p className="empty-state">当前项目暂无 Knowledge Draft。</p>}
          <div className="graph-list">
            {sortedDrafts.map((item) => (
              <button
                className={`graph-list-item ${selectedDraftId === item.id ? "selected" : ""}`}
                key={item.id}
                type="button"
                onClick={() => setSelectedDraftId(item.id)}
              >
                <strong>Chapter {item.chapter_number || "-"} · {item.status || "pending_review"}</strong>
                <span>{item.id}</span>
                <small>{summarizeDraft(item)}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="panel knowledge-draft-detail">
          <div className="panel-header">
            <div>
              <span className="section-kicker">Candidate Changes</span>
              <h2>{draft ? `Draft ${draft.chapter_number || "-"}` : "Draft 详情"}</h2>
            </div>
          </div>

          {loadingDraft && <p className="state-text loading-text">正在加载 draft 详情...</p>}
          {!loadingDraft && !draft && <p className="empty-state">请选择一个 Knowledge Draft。</p>}

          {draft && (
            <>
              <dl className="draft-meta-grid">
                <div>
                  <dt>draft_id</dt>
                  <dd>{draft.id}</dd>
                </div>
                <div>
                  <dt>source_delta_id</dt>
                  <dd>{draft.source_delta_id || "-"}</dd>
                </div>
                <div>
                  <dt>status</dt>
                  <dd>{draft.status || "pending_review"}</dd>
                </div>
                <div>
                  <dt>created_at</dt>
                  <dd>{draft.created_at || "-"}</dd>
                </div>
              </dl>

              <div className="candidate-review-list">
                {(draft.candidate_changes ?? []).map((change) => {
                  const status = changeStatus(change);
                  const supported = SUPPORTED_ACCEPT_OPERATIONS.has(change.operation);
                  const pendingReview = canReview(change);
                  const busy = busyChangeId === change.id;
                  const resultText = changeResult(change);
                  return (
                    <article className="candidate-review-card" key={change.id}>
                      <div className="candidate-review-header">
                        <div>
                          <span className={`review-status review-status-${status.replace(/[^a-z0-9_-]/gi, "-")}`}>
                            {statusLabel(status)}
                          </span>
                          {!supported && <span className="review-status review-status-unsupported">暂不支持合并</span>}
                        </div>
                        <strong>{change.operation}</strong>
                      </div>

                      <dl className="draft-meta-grid compact">
                        <div>
                          <dt>change_id</dt>
                          <dd>{change.id}</dd>
                        </div>
                        <div>
                          <dt>target</dt>
                          <dd>{change.target || "-"}</dd>
                        </div>
                        <div>
                          <dt>source</dt>
                          <dd>{change.source || "-"}</dd>
                        </div>
                        <div>
                          <dt>confidence</dt>
                          <dd>{confidenceLabel(change.confidence)}</dd>
                        </div>
                      </dl>

                      {change.evidence && (
                        <p className="candidate-review-text">
                          <strong>evidence</strong>
                          <span>{change.evidence}</span>
                        </p>
                      )}
                      {change.rationale && (
                        <p className="candidate-review-text">
                          <strong>rationale</strong>
                          <span>{change.rationale}</span>
                        </p>
                      )}
                      {resultText && <p className="candidate-review-result">{resultText}</p>}

                      <pre className="json-snippet">{formatJson(change.payload)}</pre>

                      <label className="form-field">
                        <span>review_note</span>
                        <textarea
                          value={reviewNotes[change.id] || ""}
                          onChange={(event) =>
                            setReviewNotes((current) => ({ ...current, [change.id]: event.target.value }))
                          }
                          disabled={!pendingReview || Boolean(busyChangeId)}
                        />
                      </label>

                      <div className="form-actions">
                        <button
                          className="button primary-button"
                          type="button"
                          onClick={() => void handleAccept(change)}
                          disabled={!canAccept(change) || Boolean(busyChangeId)}
                        >
                          {busy ? "处理中..." : "接受"}
                        </button>
                        <button
                          className="button danger-button"
                          type="button"
                          onClick={() => void handleReject(change)}
                          disabled={!pendingReview || Boolean(busyChangeId)}
                        >
                          拒绝
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </section>
    </section>
  );
}
