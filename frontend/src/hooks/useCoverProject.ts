import { useCallback, useEffect, useRef, useState } from 'react';
import { getProject } from '../localStore';
import type { LocalProject } from '../localTypes';

export function useCoverProject(projectRef: string | null) {
  const [project, setProject] = useState<LocalProject | null>(null), [error, setError] = useState('');
  const sequence = useRef(0), live = useRef(true);
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current;
    if (!projectRef) { setProject(null); return; }
    try { const saved = await getProject(projectRef); if (live.current && ticket === sequence.current) { setProject(saved); setError(''); } }
    catch (e) { if (live.current && ticket === sequence.current) { setProject(null); setError(e instanceof Error ? e.message : '封面读取失败。'); } }
  }, [projectRef]);
  useEffect(() => {
    live.current = true; setProject(null); void refresh();
    const changed = (event: Event) => { if ((event as CustomEvent<{ projectRef: string }>).detail?.projectRef === projectRef) void refresh(); };
    window.addEventListener('braipen:workflow-changed', changed);
    return () => { live.current = false; sequence.current++; window.removeEventListener('braipen:workflow-changed', changed); };
  }, [projectRef, refresh]);
  return { project, error, refresh };
}
