export type WorkflowRailStepStatus = "done" | "current" | "warning" | "pending";

export type WorkflowRailStep = {
  key: string;
  label: string;
  status: WorkflowRailStepStatus;
  description: string;
};

const STATUS_LABELS: Record<WorkflowRailStepStatus, string> = {
  done: "done",
  current: "current",
  warning: "warning",
  pending: "pending",
};

type WorkflowRailProps = {
  steps: WorkflowRailStep[];
};

export function WorkflowRail({ steps }: WorkflowRailProps) {
  return (
    <section className="panel workflow-rail" aria-labelledby="workflow-rail-title">
      <div className="panel-header">
        <div>
          <span className="section-kicker">Workflow</span>
          <h2 id="workflow-rail-title">Chapter Rail</h2>
        </div>
      </div>
      <ol className="workflow-rail-list">
        {steps.map((step, index) => (
          <li className={`workflow-rail-step workflow-rail-step-${step.status}`} key={step.key}>
            <span className="workflow-rail-index">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{step.label}</strong>
              <p>{step.description}</p>
            </div>
            <span className="workflow-rail-status">{STATUS_LABELS[step.status]}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
