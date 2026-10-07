import { useEffect, useRef, useState } from 'react';
import { getCoverBlob } from '../coverStorage';
import { paintCover } from '../coverArtwork';
import type { CoverLayout, CoverVersion } from '../coverTypes';
import { useCoverProject } from '../hooks/useCoverProject';
import '../styles/cover.css';

export function CoverPreview({ version, layout, title, className = '', maxDimension = 1024 }: { version: CoverVersion; layout: CoverLayout; title: string; className?: string; maxDimension?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null), [error, setError] = useState('');
  useEffect(() => {
    let live = true, url = '';
    setError('');
    const draw = async () => {
      try {
        const blob = await getCoverBlob(version.media_id);
        if (!live) return;
        url = URL.createObjectURL(blob);
        if (canvas.current) await paintCover(canvas.current, url, layout, () => live, maxDimension);
      } catch (e) { if (live) setError(e instanceof Error ? e.message : '封面暂时无法显示。'); }
    };
    void draw();
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [version.media_id, layout, maxDimension]);
  return <div className={`cover-artwork ${className}`}>
    <canvas ref={canvas} role="img" aria-label={`《${title}》封面`} style={{ aspectRatio: `${version.width} / ${version.height}` }} />
    {error && <p className="cover-error" role="alert">{error}</p>}
  </div>;
}

export default function ProjectCover({ projectRef, className = '' }: { projectRef: string | null; className?: string }) {
  const { project, error } = useCoverProject(projectRef);
  const cover = project?.cover, version = cover?.versions.find(v => v.id === cover.selected_id);
  if (error) return <p className="cover-error" role="alert">{error}</p>;
  return version && cover ? <CoverPreview version={version} layout={cover.layout} title={project!.title} className={className} maxDimension={512} /> : null;
}
