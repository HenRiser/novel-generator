import { useEffect, useMemo, useState } from "react";
import { Empty, Input, Spin } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useAppStore } from "../../store/useAppStore";
import "./reader.css";

type ChapterListPanelProps = { selectedChapterNumber: number | null; onSelectChapter: (chapterNumber: number | null) => void };
export default function ChapterListPanel({ selectedChapterNumber, onSelectChapter }: ChapterListPanelProps) {
  const { selectedProjectRef, chapters, chaptersLoading } = useAppStore();
  const [query, setQuery] = useState("");
  useEffect(() => { setQuery(""); }, [selectedProjectRef]);
  const sorted = useMemo(() => [...chapters].sort((a, b) => a.chapter_number - b.chapter_number).filter((chapter) => `${chapter.chapter_number} ${chapter.title} ${chapter.display_label}`.toLowerCase().includes(query.toLowerCase().trim())), [chapters, query]);
  return <div className="chapter-list-panel">
    {chapters.length > 0 && <Input aria-label="搜索章节" placeholder="查找章节" prefix={<SearchOutlined />} value={query} onChange={(event) => setQuery(event.target.value)} allowClear />}
    <nav className="chapter-list" aria-label="章节目录">
      {!selectedProjectRef ? <Empty description="选择作品后显示章节" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : chaptersLoading && !chapters.length ? <div className="reader-loading"><Spin /></div> : !sorted.length ? <Empty description={query ? "没有找到对应章节" : "故事的第一章，等待落笔"} image={Empty.PRESENTED_IMAGE_SIMPLE} /> : sorted.map((chapter) => <button type="button" key={`${chapter.chapter_number}-${chapter.version}`} className={`chapter-list-item${chapter.chapter_number === selectedChapterNumber ? " is-active" : ""}`} aria-current={chapter.chapter_number === selectedChapterNumber ? "page" : undefined} onClick={() => onSelectChapter(chapter.chapter_number)}><span className="chapter-list-number">{String(chapter.chapter_number).padStart(2, "0")}</span><span className="chapter-list-copy"><strong>{chapter.title || chapter.display_label || `第 ${chapter.chapter_number} 章`}</strong><small>第 {chapter.chapter_number} 章{chapter.is_version ? ` · v${chapter.version}` : ""}</small></span></button>)}
    </nav>
  </div>;
}
