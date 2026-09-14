import { useEffect, useState } from "react";
import { Alert, Button, Empty, InputNumber, Select, Space, Tabs } from "antd";
import { ArrowRightOutlined, ReloadOutlined } from "@ant-design/icons";
import { Link, useSearchParams } from "react-router-dom";
import { getChapterFunctionReview } from "../api";
import type { ChapterTaskSheet, NoRevealReview } from "../types";
import { useAppStore } from "../store/useAppStore";
import { useChapterStatus, useProjectData } from "../hooks/useProjectData";
import { NoRevealReviewPanel } from "../components/NoRevealReviewPanel";
import { ChapterTaskSheetPanel } from "../components/ChapterTaskSheetPanel";
import { ScenePlanPanel } from "../components/ScenePlanPanel";
import "../styles/writing.css";

const ignoreScenePlanStateChange = () => undefined;

export default function ReviewPage() {
  const { selectedProjectRef, chapters } = useAppStore();
  const [params, setParams] = useSearchParams();
  const { detailError, chaptersError } = useProjectData(selectedProjectRef);
  const nextChapter = Math.max(0, ...chapters.map((chapter) => chapter.chapter_number)) + 1;
  const requested = Number(params.get("chapter"));
  const chapterNumber = Number.isInteger(requested) && requested > 0 ? requested : nextChapter;
  const numbers = Array.from(new Set([...chapters.map((chapter) => chapter.chapter_number), nextChapter, chapterNumber])).sort((a, b) => a - b);
  const changeChapter = (value: number | null) => { if (value && value >= 1) setParams({ chapter: String(Math.trunc(value)) }, { replace: true }); };
  return <div className="page-container review-page">
    <div className="page-heading"><div><span className="eyebrow">PLAN BEFORE PROSE</span><h1 className="page-title">章节规划</h1><p className="page-subtitle">决定这一章推进什么、保留什么，再让模型开始写作。</p></div></div>
    {(detailError || chaptersError) && <Alert type="error" showIcon message={detailError || chaptersError} style={{ marginBottom: 18 }} />}
    {!selectedProjectRef ? <div className="studio-empty"><h2>故事的边界，从这里开始。</h2><p>选择一个项目，即可为尚未生成的章节准备任务单与场景计划。</p><Link to="/dashboard"><Button type="primary">选择项目 <ArrowRightOutlined /></Button></Link></div> : <>
      <div className="review-topbar"><span className="field-caption">当前章节</span><Select aria-label="规划章节" value={chapterNumber} onChange={changeChapter} options={numbers.map((number) => ({ value: number, label: chapters.some((chapter) => chapter.chapter_number === number) ? `第 ${number} 章 · ${chapters.find((chapter) => chapter.chapter_number === number)?.title || "已保存手稿"}` : `第 ${number} 章 · 尚未生成` }))} /><Space><span className="field-caption">或指定章节</span><InputNumber aria-label="指定规划章节" min={1} precision={0} value={chapterNumber} onChange={changeChapter} /></Space><Link to={`/writing?chapter=${chapterNumber}`}>回到创作台 <ArrowRightOutlined /></Link></div>
      <ReviewChapter key={`${selectedProjectRef}-${chapterNumber}`} projectRef={selectedProjectRef} chapterNumber={chapterNumber} />
    </>}
  </div>;
}

function ReviewChapter({ projectRef, chapterNumber }: { projectRef: string; chapterNumber: number }) {
  const { apiStatus, chapterStatus } = useAppStore();
  const [review, setReview] = useState<NoRevealReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [revision, setRevision] = useState(0);
  const [approvedTask, setApprovedTask] = useState<ChapterTaskSheet | null>(null);
  const status = useChapterStatus(projectRef, chapterNumber, revision);
  const canUseApi = projectRef.startsWith("book:") && apiStatus === "online";
  useEffect(() => {
    let cancelled = false;
    if (!canUseApi) return;
    setReviewLoading(true); setReviewError("");
    void getChapterFunctionReview(projectRef, chapterNumber)
      .then((response) => { if (!cancelled) setReview(response.latest && typeof response.latest === "object" ? response.latest as NoRevealReview : null); })
      .catch((e) => { if (!cancelled) { setReview(null); setReviewError(e instanceof Error ? e.message : "审查记录加载失败。"); } })
      .finally(() => { if (!cancelled) setReviewLoading(false); });
    return () => { cancelled = true; };
  }, [canUseApi, chapterNumber, projectRef, revision]);
  return <div className="review-content">
    {!canUseApi && <Alert type="info" showIcon message={apiStatus === "online" ? "章节规划适用于工作区项目。" : "连接后端后，可读取并保存章节规划。"} style={{ marginTop: 16 }} />}
    <Tabs items={[
      { key: "task", label: "01  章节任务单", children: <><p className="review-note">先定义本章功能与允许的信息推进。保存草稿后，批准的版本才会参与章节生成。</p><ChapterTaskSheetPanel projectRef={projectRef} chapterNumber={chapterNumber} apiStatus={apiStatus} disabled={!canUseApi} onApprovedTaskChange={setApprovedTask} /></> },
      { key: "scene", label: "02  场景计划", children: <><p className="review-note">把本章任务拆成具体场景。批准后，可在创作台选择将这份计划带入生成。</p><ScenePlanPanel projectRef={projectRef} chapterNumber={chapterNumber} apiStatus={apiStatus} disabled={!canUseApi} approvedChapterTask={approvedTask} onScenePlanStateChange={ignoreScenePlanStateChange} /></> },
      { key: "review", label: "03  信息边界审查", children: <><p className="review-note">No-Reveal 检查在章节保存后给出规则提示，用于辅助人工复核；不会阻止手稿保存。</p><NoRevealReviewPanel review={review} loading={reviewLoading} error={reviewError} onRefresh={() => setRevision((value) => value + 1)} disabled={!canUseApi} /></> },
      { key: "status", label: "流程记录", children: <div className="studio-status"><div className="studio-status-heading"><h2>第 {chapterNumber} 章</h2><Button icon={<ReloadOutlined />} loading={status.loading} onClick={() => void status.refresh()} disabled={!canUseApi}>刷新记录</Button></div>{status.error && <Alert type="error" showIcon message={status.error} />}{chapterStatus ? <><div className="studio-status-grid"><div><strong>{chapterStatus.chapter_status.chapter.exists ? "已保存" : "未生成"}</strong><span>章节状态</span></div><div><strong>{chapterStatus.chapter_status.review.pending_count}</strong><span>等待复核</span></div><div><strong>{chapterStatus.chapter_status.review.accepted_count}</strong><span>已接受变更</span></div><div><strong>{chapterStatus.chapter_status.review.rejected_count}</strong><span>已拒绝变更</span></div></div>{chapterStatus.chapter_status.warnings.map((warning) => <Alert key={warning.code} type="warning" showIcon message={warning.message} />)}<Link to="/library">前往知识审核 <ArrowRightOutlined /></Link></> : !status.loading && !status.error && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无流程记录。" />}</div> },
    ]} />
  </div>;
}
