import { useCallback, useEffect, useState } from 'react';
import { listWritingStyles } from '../localStore';
import type { WritingStyleCard } from '../writingStyle';

export function useWritingStyles() {
  const [cards, setCards] = useState<WritingStyleCard[]>([]), [error, setError] = useState('');
  const refresh = useCallback(async () => { const values = await listWritingStyles(); setCards(values); setError(''); }, []);
  useEffect(() => {
    let active = true;
    const load = () => { void listWritingStyles().then(values => { if (active) { setCards(values); setError(''); } }, reason => { if (active) setError(reason instanceof Error ? reason.message : '无法读取本地文风库。'); }); };
    load(); window.addEventListener('braipen:styles-changed', load);
    return () => { active = false; window.removeEventListener('braipen:styles-changed', load); };
  }, []);
  return { cards, error, refresh };
}
