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

export function ChapterStatusPanel({
  status,
  loading,
  error,
  workflowWarnings,
}: ChapterStatusPanelProps) {
  const counts = status?.knowledge_drafts.counts;
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
