import type { ChapterStatus, WorkflowGuardWarning } from "../types";

type ChapterStatusPanelProps = {
  status: ChapterStatus | null;
  loading: boolean;
  error: string;
  workflowWarnings: WorkflowGuardWarning[];
};

function statusLabel(value: string): string {
  return value.replace(/_/g, " ") || "unknown";
}

function countLabel(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

function reviewClass(verdict: string | undefined): string {
  const normalized = String(verdict || "none").toLowerCase();
  if (normalized === "fail") {
    return "function-review-summary function-review-summary-fail";
  }
  if (normalized === "warn") {
    return "function-review-summary function-review-summary-warn";
  }
  if (normalized === "pass") {
    return "function-review-summary function-review-summary-pass";
  }
  return "function-review-summary";
}

export function ChapterStatusPanel({
  status,
  loading,
  error,
  workflowWarnings,
}: ChapterStatusPanelProps) {
  const counts = status?.knowledge_drafts.counts;
  const latestFunctionReview = status?.latest_function_review ?? null;
  const latestReviewVerdict = String(latestFunctionReview?.verdict || "none").toUpperCase();
  return (
    <section className="chapter-status-panel" aria-live="polite">
      <div className="chapter-status-header">
        <div>
          <span className="section-kicker">Chapter status</span>
          <h3>Workflow status</h3>
        </div>
        {status && <span className="status-badge">Chapter {status.chapter_number}</span>}
      </div>

      {loading && <p className="state-text">Loading chapter status...</p>}
      {error && <p className="state-text error-text">{error}</p>}
      {!loading && !error && !status && <p className="state-text">Select a project and chapter.</p>}

      {status && (
        <>
          <div className="chapter-status-grid">
            <div>
              <span>Prose</span>
              <strong>{status.chapter.exists ? "exists" : "missing"}</strong>
              <small>{status.chapter.ref || "No chapter file"}</small>
            </div>
            <div>
              <span>Story Delta</span>
              <strong>{statusLabel(status.story_delta.status)}</strong>
              <small>{status.story_delta.delta_ids.length} delta items</small>
            </div>
            <div>
              <span>Review</span>
              <strong>{statusLabel(status.review.status)}</strong>
              <small>{status.review.pending_count} pending</small>
            </div>
            <div>
              <span>Context Pack</span>
              <strong>{statusLabel(status.context_pack.status)}</strong>
              <small>{status.context_pack.message}</small>
            </div>
          </div>

          <div className={reviewClass(latestFunctionReview?.verdict)}>
            <div>
              <span>No-Reveal Review</span>
              <strong>{latestReviewVerdict}</strong>
              <small>
                {latestFunctionReview
                  ? `score ${latestFunctionReview.score}/5 · ${latestFunctionReview.categories.length} categories`
                  : "No function review for this chapter"}
              </small>
            </div>
            {latestFunctionReview && (
              <dl>
                <div>
                  <dt>review_id</dt>
                  <dd>{latestFunctionReview.id || "-"}</dd>
                </div>
                <div>
                  <dt>ai_run_id</dt>
                  <dd>{latestFunctionReview.ai_run_id || "-"}</dd>
                </div>
                <div>
                  <dt>categories</dt>
                  <dd>{latestFunctionReview.categories.length ? latestFunctionReview.categories.join(", ") : "-"}</dd>
                </div>
              </dl>
            )}
            {String(latestFunctionReview?.verdict || "").toLowerCase() === "fail" && (
              <p className="state-text error-text">
                该章违反 No-Reveal / Scene Plan 禁止项，需要人工复核；不建议直接进入下一章。
              </p>
            )}
          </div>

          <div className="chapter-status-counts" aria-label="Knowledge Draft counts">
            <span>pending {countLabel(counts?.pending_review ?? 0)}</span>
            <span>accepted {countLabel(counts?.accepted ?? 0)}</span>
            <span>rejected {countLabel(counts?.rejected ?? 0)}</span>
            <span>failed {countLabel(counts?.failed ?? 0)}</span>
            <span>unsupported {countLabel(counts?.unsupported ?? 0)}</span>
          </div>

          <div className="chapter-status-grid compact">
            <div>
              <span>chapter_generation AI runs</span>
              <strong>{status.ai_runs.chapter_generation.length}</strong>
            </div>
            <div>
              <span>story_delta_analysis AI runs</span>
              <strong>{status.ai_runs.story_delta_analysis.length}</strong>
            </div>
            <div>
              <span>chapter events</span>
              <strong>{status.events.chapter_generated.length}</strong>
            </div>
            <div>
              <span>review events</span>
              <strong>
                {status.events.knowledge_draft_change_accepted.length +
                  status.events.knowledge_draft_change_rejected.length}
              </strong>
            </div>
          </div>

          {workflowWarnings.length > 0 && (
            <div className="workflow-warning-box">
              <strong>Pre-generation warnings</strong>
              <ul>
                {workflowWarnings.map((warning) => (
                  <li key={`${warning.code}-${warning.message}`}>
                    <span>{warning.severity}</span>
                    {warning.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
