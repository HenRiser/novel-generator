import { useEffect } from "react";
import { Empty, List, Spin, Typography } from "antd";
import { FileTextOutlined } from "@ant-design/icons";
import type { ChapterSummary } from "../../types";
import { useAppStore } from "../../store/useAppStore";

type ChapterListPanelProps = {
  selectedChapterNumber: number | null;
  onSelectChapter: (chapterNumber: number | null) => void;
};

export default function ChapterListPanel({ selectedChapterNumber, onSelectChapter }: ChapterListPanelProps) {
  const {
    selectedProjectRef,
    chapters,
    chaptersLoading,
    setChapters,
  } = useAppStore();

  useEffect(() => {
    if (!selectedProjectRef) {
      setChapters([]);
      return;
    }
  }, [selectedProjectRef, setChapters]);

  const sorted = [...chapters].sort((a, b) => a.chapter_number - b.chapter_number);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
      <Typography.Text strong>章节</Typography.Text>
      <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
        {!selectedProjectRef ? (
          <Empty description="选择项目后显示章节" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 16 }} />
        ) : chaptersLoading && sorted.length === 0 ? (
          <div style={{ textAlign: "center", padding: 16 }}>
            <Spin />
          </div>
        ) : sorted.length === 0 ? (
          <Empty description="还没有章节" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 16 }} />
        ) : (
          <List
            size="small"
            dataSource={sorted}
            renderItem={(chapter: ChapterSummary) => {
              const active = chapter.chapter_number === selectedChapterNumber;
              return (
                <List.Item
                  key={`${chapter.chapter_number}-${chapter.version}`}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 8,
                    cursor: "pointer",
                    background: active ? "#efe4d3" : "transparent",
                    border: active ? "1px solid #d8c7a8" : "1px solid transparent",
                  }}
                  onClick={() => onSelectChapter(chapter.chapter_number)}
                >
                  <List.Item.Meta
                    avatar={<FileTextOutlined style={{ color: active ? "#5f4b32" : "#b4a88f" }} />}
                    title={
                      <span style={{ fontSize: 13 }}>
                        <Typography.Text strong={active}>
                          {chapter.chapter_number}. {chapter.title || chapter.display_label}
                        </Typography.Text>
                      </span>
                    }
                    description={
                      chapter.is_version ? (
                        <span style={{ fontSize: 11, color: "#9a8f80" }}>v{chapter.version}</span>
                      ) : undefined
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
