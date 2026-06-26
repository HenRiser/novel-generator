import type { ChapterTaskSheet, GenerationRequest, ScenePlan } from "../types";

type EffectiveInputsSummaryProps = {
  approvedChapterTask: ChapterTaskSheet | null;
  latestChapterTaskDraft: ChapterTaskSheet | null;
  approvedScenePlan: ScenePlan | null;
  latestScenePlanDraft: ScenePlan | null;
  contextPackState: "attached" | "available" | "not_ready" | "unknown";
  generationMode: "stream" | "sync-debug";
  generationRequest: GenerationRequest;
  warnings: string[];
};

function revisionText(revision: number | undefined): string {
  return revision ? `revision ${revision}` : "none";
}

export function EffectiveInputsSummary({
  approvedChapterTask,
  latestChapterTaskDraft,
  approvedScenePlan,
  latestScenePlanDraft,
  contextPackState,
  generationMode,
  generationRequest,
  warnings,
}: EffectiveInputsSummaryProps) {
  return (
    <section className="panel effective-inputs-summary" aria-labelledby="effective-inputs-title">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Effective Inputs</span>
          <h2 id="effective-inputs-title">If you generate now</h2>
          <p>Only approved inputs are used. Drafts are shown separately.</p>
        </div>
      </div>

      <dl className="effective-input-grid">
        <div>
          <dt>Chapter Task</dt>
          <dd>
            <strong>{approvedChapterTask ? `approved ${revisionText(approvedChapterTask.revision)}` : "none"}</strong>
            <span>{approvedChapterTask?.id || "not used"}</span>
            {latestChapterTaskDraft && (
              <small>draft exists: revision {latestChapterTaskDraft.revision}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>Scene Plan</dt>
          <dd>
            <strong>{approvedScenePlan ? `approved ${revisionText(approvedScenePlan.revision)}` : "none"}</strong>
            <span>{approvedScenePlan?.id || "not used"}</span>
            {latestScenePlanDraft && (
              <small>draft exists: revision {latestScenePlanDraft.revision}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>Context Pack</dt>
          <dd>
            <strong>{contextPackState.replace("_", " ")}</strong>
            <span>{contextPackState === "attached" ? "will be injected" : "not injected"}</span>
          </dd>
        </div>
        <div>
          <dt>Generation Mode</dt>
          <dd>
            <strong>{generationMode === "stream" ? "stream" : "sync debug"}</strong>
            <span>
              model {generationRequest.model}, max_tokens {generationRequest.max_tokens}, temperature{" "}
              {generationRequest.temperature}
            </span>
          </dd>
        </div>
      </dl>

      {warnings.length > 0 && (
        <div className="effective-input-warnings" role="note">
          <strong>Warnings</strong>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
