/** 仅保存界面偏好；正文、凭据和任务运行状态不进入浏览器存储。 */
const STORAGE_KEY = "braipen.workspace-preferences.v1";
export type WritingTab = "generate" | "reader" | "assets" | "status";
export type ProjectWorkspace = { chapterNumber?: number; writingTab?: WritingTab };
export type ReaderFont = "serif" | "sans";
export type ReaderTheme = "auto" | "paper" | "white" | "night";
type ReadingPosition = { version: string; progress: number };
type Preferences = {
  recentProject: string | null;
  fontSize: number;
  font: ReaderFont;
  theme: ReaderTheme;
  projects: Record<string, ProjectWorkspace>;
  positions: Record<string, ReadingPosition>;
};
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export const isWritingTab = (value: unknown): value is WritingTab => typeof value === "string" && ["generate", "reader", "assets", "status"].includes(value);
const positiveChapter = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
const isReaderFont = (value: unknown): value is ReaderFont => value === "serif" || value === "sans";
const isReaderTheme = (value: unknown): value is ReaderTheme => typeof value === "string" && ["auto", "paper", "white", "night"].includes(value);

function readPreferences(): Preferences {
  const result: Preferences = { recentProject: null, fontSize: 18, font: "serif", theme: "auto", projects: Object.create(null), positions: Object.create(null) };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!isRecord(raw)) return result;
    if (typeof raw.recentProject === "string") result.recentProject = raw.recentProject;
    if (typeof raw.fontSize === "number" && Number.isInteger(raw.fontSize) && raw.fontSize >= 14 && raw.fontSize <= 28) result.fontSize = raw.fontSize;
    if (isReaderFont(raw.font)) result.font = raw.font;
    if (isReaderTheme(raw.theme)) result.theme = raw.theme;
    if (isRecord(raw.projects)) for (const [key, value] of Object.entries(raw.projects).slice(-100)) {
      if (!isRecord(value)) continue;
      result.projects[key] = {
        ...(positiveChapter(value.chapterNumber) ? { chapterNumber: value.chapterNumber } : {}),
        ...(isWritingTab(value.writingTab) ? { writingTab: value.writingTab } : {}),
      };
    }
    if (isRecord(raw.positions)) for (const [key, value] of Object.entries(raw.positions).slice(-100)) {
      if (isRecord(value) && typeof value.version === "string" && typeof value.progress === "number" && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 1) {
        result.positions[key] = { version: value.version, progress: value.progress };
      }
    }
  } catch { /* 浏览器禁用存储或旧记录损坏时使用默认偏好。 */ }
  return result;
}

const preferences = readPreferences();
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); }
  catch { /* 当前会话内仍可使用记忆，不阻断阅读与创作。 */ }
}
function keepRecent<T>(records: Record<string, T>, key: string, value: T) {
  delete records[key];
  records[key] = value;
  for (const obsolete of Object.keys(records).slice(0, -100)) delete records[obsolete];
}
export function getRememberedProject(): string | null { return preferences.recentProject; }
export function rememberProject(projectRef: string | null) { preferences.recentProject = projectRef; persist(); }
export function getProjectWorkspace(projectRef: string | null): ProjectWorkspace { return projectRef ? { ...preferences.projects[projectRef] } : {}; }
export function rememberProjectWorkspace(projectRef: string, patch: ProjectWorkspace) {
  const current = getProjectWorkspace(projectRef);
  if (positiveChapter(patch.chapterNumber)) current.chapterNumber = patch.chapterNumber;
  if (isWritingTab(patch.writingTab)) current.writingTab = patch.writingTab;
  keepRecent(preferences.projects, projectRef, current);
  persist();
}
export function getReaderFontSize(): number { return preferences.fontSize; }
export function rememberReaderFontSize(size: number) {
  if (!Number.isFinite(size)) return;
  preferences.fontSize = Math.min(28, Math.max(14, Math.round(size)));
  persist();
}
export function getReaderFont(): ReaderFont { return preferences.font; }
export function rememberReaderFont(font: ReaderFont) {
  if (!isReaderFont(font)) return;
  preferences.font = font;
  persist();
}
export function getReaderTheme(): ReaderTheme { return preferences.theme; }
export function rememberReaderTheme(theme: ReaderTheme) {
  if (!isReaderTheme(theme)) return;
  preferences.theme = theme;
  persist();
}

/** 文件名之外也比较内容指纹，兼容原文件被覆盖的编辑方式。 */
export function readingVersion(filename: string, content: string): string {
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second, 33) ^ code;
  }
  return `${filename}:${content.length}:${first >>> 0}:${second >>> 0}`;
}
const positionKey = (projectRef: string, chapter: number) => JSON.stringify([projectRef, chapter]);
export function getReadingPosition(projectRef: string, chapter: number, version: string): number | null {
  const position = preferences.positions[positionKey(projectRef, chapter)];
  return position?.version === version ? position.progress : null;
}
export function rememberReadingPosition(projectRef: string, chapter: number, version: string, progress: number) {
  if (!Number.isFinite(progress)) return;
  keepRecent(preferences.positions, positionKey(projectRef, chapter), { version, progress: Math.max(0, Math.min(1, progress)) });
  persist();
}
