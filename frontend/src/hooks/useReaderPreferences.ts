import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { getReaderFont, getReaderFontSize, getReaderTheme, getReadingPosition, readingVersion, rememberReaderFont, rememberReaderFontSize, rememberReaderTheme, rememberReadingPosition } from "../workspacePreferences";

export function useReaderPreferences() {
  const [fontSize, setFontSize] = useState(getReaderFontSize);
  const [font, setFont] = useState(getReaderFont);
  const [theme, setTheme] = useState(getReaderTheme);
  useEffect(() => { rememberReaderFontSize(fontSize); }, [fontSize]);
  useEffect(() => { rememberReaderFont(font); }, [font]);
  useEffect(() => { rememberReaderTheme(theme); }, [theme]);
  return { fontSize, setFontSize, font, setFont, theme, setTheme };
}

export function useReadingPosition({ projectRef, chapterNumber, filename, content, loading, scrollRef }: {
  projectRef: string | null;
  chapterNumber: number | null;
  filename: string;
  content: string | null;
  loading: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const version = useMemo(() => content !== null && filename ? readingVersion(filename, content) : null, [filename, content]);
  const syncRef = useRef<(() => void) | null>(null);
  const syncReadingPosition = useCallback(() => syncRef.current?.(), []);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !projectRef || chapterNumber === null || version === null || loading) return;
    let restored = false;
    let changed = false;
    let userMoved = false;
    let restoredTop: number | null = null;
    let lastProgress = getReadingPosition(projectRef, chapterNumber, version) ?? 0;
    let timer: number | undefined;
    const save = () => {
      if (changed) rememberReadingPosition(projectRef, chapterNumber, version, lastProgress);
    };
    const restore = () => {
      // 创作台的非活动标签页可能尚无高度，等其显示后再恢复。
      if (userMoved || element.clientHeight === 0) return;
      const target = lastProgress * Math.max(0, element.scrollHeight - element.clientHeight);
      // 摘要/检查面板异步展开时，用户尚未移动就继续校正位置。
      if (Math.abs(element.scrollTop - target) > 1) {
        restoredTop = target;
        element.scrollTop = target;
      }
      restored = true;
    };
    const onScroll = () => {
      if (!restored || element.clientHeight === 0) return;
      if (restoredTop !== null && Math.abs(element.scrollTop - restoredTop) <= 1) { restoredTop = null; return; }
      const range = element.scrollHeight - element.clientHeight;
      if (range <= 0) return;
      userMoved = true;
      lastProgress = Math.max(0, Math.min(1, element.scrollTop / range));
      changed = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(save, 200);
    };
    syncRef.current = () => {
      // 排版主动调整后由字符锚点保持位置，不再按旧比例覆盖。
      userMoved = true;
      restored = true;
      restoredTop = null;
      onScroll();
    };
    const frame = window.requestAnimationFrame(restore);
    const observer = new ResizeObserver(restore);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    const mutationObserver = new MutationObserver(() => {
      for (const child of element.children) observer.observe(child);
      restore();
    });
    mutationObserver.observe(element, { childList: true });
    element.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      syncRef.current = null;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      observer.disconnect();
      mutationObserver.disconnect();
      element.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [projectRef, chapterNumber, version, loading, scrollRef]);
  return syncReadingPosition;
}
