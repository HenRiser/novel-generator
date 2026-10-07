import type { LocalProject } from './localTypes';
import type { CoverLayout } from './coverTypes';

export function coverSource(project: LocalProject) {
  return { idea: String(project.config.raw_story_idea || project.config.seed_prompt || ''), characters: project.assets.characters };
}
export function initialCoverDirection(title: string) {
  return title.includes('取反') ? '逆转感的对称构图，人物闭目结印的特写，面部与双手同框，突出人物主体，背景简洁。以对置光影表现逆转感。'
    : '突出故事主体，构图清晰，色调体现故事氛围，为书名留出空间。';
}
export function buildCoverPrompt(source: { idea: string; characters: string }, direction: string) {
  return ['创作一张竖版小说封面底图，宽高比 2:3。', '白话故事设定：', source.idea || '由作者提供的视觉要求决定画面。',
    ...(source.characters ? ['人物卡：', source.characters] : []), '作者的封面视觉要求：', direction,
    '只生成画面，不生成书名、作者名、标语、路牌文字、字母或数字，书名由应用另行排版。人物卡未写明的外貌细节仅用于此次封面设计。'].join('\n');
}
export function buildCoverEditPrompt(change: string) {
  return `基于提供的原图修改。作者要求：\n${change}\n除上述明确修改外，尽量保持原图的人物特征、姿态和构图。不要新增书名、作者名、标语、字母或数字。`;
}
export function imageDataBlob(data: { mime_type: string; data_base64: string }) {
  const binary = atob(data.data_base64), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: data.mime_type });
}
export async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
export function downloadCoverBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename.replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Preview and export use the same canvas; changing typography never calls a model. */
export async function paintCover(canvas: HTMLCanvasElement, url: string, layout: CoverLayout, current = () => true, maxDimension?: number): Promise<void> {
  const picture = new Image(); picture.src = url;
  await Promise.all([picture.decode(), document.fonts.ready]);
  if (!current()) return;
  const scale = maxDimension ? Math.min(1, maxDimension / Math.max(picture.naturalWidth, picture.naturalHeight)) : 1;
  const width = Math.round(picture.naturalWidth * scale), height = Math.round(picture.naturalHeight * scale);
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法绘制封面，请下载底图。');
  context.drawImage(picture, 0, 0, width, height);
  const family = layout.fontFamily === 'serif' ? '"Noto Serif SC", "Songti SC", SimSun, serif' : 'system-ui, "Microsoft YaHei", sans-serif';
  let titleSize = width * layout.titleSize / 100;
  const wrap = (text: string): string[] => {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const character of Array.from(paragraph)) {
        if (line && context.measureText(line + character).width > width * .84) { lines.push(line); line = ''; }
        line += character;
      }
      if (line) lines.push(line);
    }
    return lines;
  };
  context.font = `600 ${titleSize}px ${family}`;
  let lines = wrap(layout.title);
  while (lines.length > 3 && titleSize > width * .03) {
    titleSize *= .9; context.font = `600 ${titleSize}px ${family}`; lines = wrap(layout.title);
  }
  const authorSize = width * layout.authorSize / 100, lineHeight = titleSize * 1.25;
  const blockHeight = lines.length * lineHeight + (layout.author ? authorSize * 2 : 0);
  const desired = layout.titlePosition === 'top' ? height * .08 : layout.titlePosition === 'center' ? (height - blockHeight) / 2 : height * .92 - blockHeight;
  const y = Math.max(height * .02, Math.min(desired, height - blockHeight - height * .02));
  if (lines.length || layout.author) {
    const top = Math.max(0, y - height * .05), bottom = Math.min(height, y + blockHeight + height * .05);
    const shade = context.createLinearGradient(0, top, 0, bottom);
    shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(.2, 'rgba(0,0,0,.24)');
    shade.addColorStop(.8, 'rgba(0,0,0,.24)'); shade.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = shade; context.fillRect(0, top, width, bottom - top);
  }
  context.textAlign = 'center'; context.textBaseline = 'top'; context.shadowColor = 'rgba(0,0,0,.65)';
  context.shadowBlur = width * .008; context.shadowOffsetY = width * .003;
  context.fillStyle = layout.titleColor;
  lines.forEach((line, index) => context.fillText(line, width / 2, y + index * lineHeight));
  if (layout.author) {
    context.font = `${authorSize}px ${family}`; context.fillStyle = layout.authorColor;
    context.fillText(layout.author, width / 2, y + lines.length * lineHeight + authorSize * .35, width * .84);
  }
  canvas.dataset.rendered = 'true';
}
export async function exportCover(blob: Blob, layout: CoverLayout): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const canvas = document.createElement('canvas'); await paintCover(canvas, url, layout);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('封面导出失败，请重试或下载底图。')), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}
