import type { NoRevealReview } from "../types";

type NoRevealReviewPanelProps = {
  review: NoRevealReview | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  disabled?: boolean;
};

function verdictLabel(review: NoRevealReview | null): string {
  if (!review) {
    return "NONE";
  }
  return String(review.verdict || "unknown").toUpperCase();
}

function verdictClass(review: NoRevealReview | null): string {
  const verdict = String(review?.verdict || "none").toLowerCase();
  if (verdict === "fail") {
    return "review-verdict-fail";
  }
  if (verdict === "warn") {
    return "review-verdict-warn";
  }
  if (verdict === "pass") {
    return "review-verdict-pass";
  }
  return "review-verdict-none";
}

export function NoRevealReviewPanel({
  review,
  loading,
  error,
  onRefresh,
  disabled = false,
}: NoRevealReviewPanelProps) {
  const violations = review?.violations ?? [];
  const categories = review?.categories ?? [];
  const isFail = String(review?.verdict || "").toLowerCase() === "fail";

  return (
    <section className={`panel no-reveal-review-panel ${verdictClass(review)}`} aria-live="polite">
      <div className="panel-header">
        <div>
          <span className="section-kicker">No-Reveal Review</span>
          <h2>No-Reveal Compliance Gate</h2>
          <p>Deterministic post-generation check for no-reveal and Scene Plan forbidden information.</p>
        </div>
        <span className="status-badge">{loading ? "Loading" : verdictLabel(review)}</span>
      </div>

      {isFail && (
        <div className="review-next-action">
          <p className="state-text error-text">
            该章违反 No-Reveal / Scene Plan 禁止项，需要人工复核。
          </p>
          <p className="state-text">
            建议：先人工复核 evidence，再决定是否保留该章、重写、或继续。
          </p>
        </div>
      )}

      {!loading && !review && !error && (
        <p className="empty-state">暂无 No-Reveal 审核记录。触发条件满足并生成章节后会显示结果。</p>
      )}

      {review && (
        <>
          <dl className="review-summary-grid">
            <div>
              <dt>verdict</dt>
              <dd>{review.verdict}</dd>
            </div>
            <div>
              <dt>score</dt>
              <dd>{review.score}/5</dd>
            </div>
            <div>
              <dt>review_id</dt>
              <dd>{review.id || "-"}</dd>
            </div>
            <div>
              <dt>ai_run_id</dt>
              <dd>{review.ai_run_id || "-"}</dd>
            </div>
          </dl>
          {review.summary && <p className="state-text">{review.summary}</p>}
          {categories.length > 0 && (
            <div className="tag-list" aria-label="No-Reveal categories">
              {categories.map((category) => (
                <span className="tag-pill" key={category}>{category}</span>
              ))}
            </div>
          )}
          {violations.length > 0 && (
            <div className="review-evidence-list">
              {violations.slice(0, 5).map((violation, index) => (
                <article className="review-evidence-item" key={`${violation.category}-${index}`}>
                  <strong>{violation.category} · {violation.severity}</strong>
                  <p>{violation.evidence}</p>
                  <small>{violation.source_rule}</small>
                </article>
              ))}
            </div>
          )}
        </>
      )}

      {error && <p className="state-text error-text">{error}</p>}
      <button className="button subtle-button compact-button" type="button" onClick={onRefresh} disabled={disabled || loading}>
        Refresh review
      </button>
    </section>
  );
}
