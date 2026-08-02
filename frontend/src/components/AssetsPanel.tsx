import { useCallback, useEffect, useState } from "react";
import { Alert, Empty, Spin, Tabs, Typography } from "antd";
import { getProjectCharacters, getProjectOutline } from "../api";
import { useAppStore } from "../store/useAppStore";

/**
 * 设定资产面板：展示项目大纲（novel_outline.md）与人物卡（characters.md）。
 * 生成后即可在此查看，无需打开文件。
 */
export default function AssetsPanel() {
  const { selectedProjectRef, apiStatus } = useAppStore();
  const [outline, setOutline] = useState<string>("");
  const [characters, setCharacters] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadAssets = useCallback(async () => {
    if (!selectedProjectRef || apiStatus !== "online") {
      setOutline("");
      setCharacters("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [outlineResult, charactersResult] = await Promise.all([
        getProjectOutline(selectedProjectRef),
        getProjectCharacters(selectedProjectRef),
      ]);
      setOutline(outlineResult.content ?? "");
      setCharacters(charactersResult.content ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "设定资产加载失败。");
    } finally {
      setLoading(false);
    }
  }, [apiStatus, selectedProjectRef]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  if (!selectedProjectRef) {
    return <Alert type="info" showIcon message="请先选择项目查看设定资产。" />;
  }

  const renderMarkdownish = (content: string) => (
    <div
      style={{
        whiteSpace: "pre-wrap",
        fontSize: 13,
        lineHeight: 1.7,
        color: "#4a4036",
        maxHeight: "calc(100vh - 320px)",
        overflowY: "auto",
      }}
    >
      {content || <Empty description="尚未生成，请在生成面板中先生成大纲与人物卡。" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError("")} />}
      {loading && !outline && !characters ? (
        <div style={{ textAlign: "center", padding: 24 }}>
          <Spin />
        </div>
      ) : (
        <Tabs
          size="small"
          items={[
            {
              key: "outline",
              label: (
                <span>
                  小说大纲
                  <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                    novel_outline.md
                  </Typography.Text>
                </span>
              ),
              children: renderMarkdownish(outline),
            },
            {
              key: "characters",
              label: (
                <span>
                  人物卡
                  <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                    characters.md
                  </Typography.Text>
                </span>
              ),
              children: renderMarkdownish(characters),
            },
          ]}
        />
      )}
    </div>
  );
}
