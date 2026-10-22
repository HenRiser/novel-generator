// Request timeouts belong to the callers. Keep the workspace locked until their cleanup finishes.
const activities = new Map<symbol, number>();
const transitions = new Set<number>();

export function beginWorkspaceActivity(epoch: number): () => void {
  if (transitions.has(epoch)) throw new Error('工作区正在切换，请完成后再开始创作任务。');
  const token = Symbol('workspace activity');
  activities.set(token, epoch);
  return () => { activities.delete(token); };
}

export function hasWorkspaceActivity(epoch: number): boolean {
  return [...activities.values()].some(value => value === epoch);
}

export function beginWorkspaceTransition(epoch: number): () => void {
  if (transitions.has(epoch) || hasWorkspaceActivity(epoch)) throw new Error('创作请求仍在处理中，请等待完成或取消清理后再切换工作区。');
  transitions.add(epoch);
  return () => { transitions.delete(epoch); };
}
