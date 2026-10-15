import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRightOutlined } from "@ant-design/icons";
import { getChapterTask } from "../../api";
import type { ChapterTaskSheet } from "../../types";

/** Present the existing approved task without generating or approving anything. */
export default function ChapterContextNote({ projectRef, chapterNumber }: { projectRef: string; chapterNumber: number }) {
  const [task, setTask] = useState<ChapterTaskSheet | null>(null);
  const [state, setState] = useState("loading");
  useEffect(() => {
    let live = true;
    let request = 0;
    setTask(null); setState("loading");
    const refresh = () => {
      const id = ++request;
      void getChapterTask(projectRef, chapterNumber).then(result => {
        if (!live || id !== request) return;
        const approved = result.approved;
        // Older or damaged backups must not prevent reading the manuscript.
        if (approved && (typeof approved !== "object" ||
            !(["decision_goal", "relationship_goal", "ending_state"] as const).every(key => typeof approved[key] === "string") ||
            !(["required_characters", "must_carry", "forbidden_advances"] as const).every(key => Array.isArray(approved[key]) && approved[key].every(value => typeof value === "string")))) {
          setTask(null); setState("invalid"); return;
        }
        setTask(approved); setState("ready");
      }).catch(() => { if (live && id === request) { setTask(null); setState("error"); } });
    };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ projectRef?: string }>).detail;
      if (!detail?.projectRef || detail.projectRef === projectRef) refresh();
    };
    refresh();
    window.addEventListener("braipen:workflow-changed", changed);
    return () => { live = false; window.removeEventListener("braipen:workflow-changed", changed); };
  }, [projectRef, chapterNumber]);
  return <aside className="studio-context" aria-label="当前章节规划">
    <h2>本章规划</h2>
    {task ? <>
      {(task.decision_goal || task.relationship_goal) && <section><h3>本章目标</h3><p>{task.decision_goal || task.relationship_goal}</p></section>}
      {task.required_characters.length > 0 && <section><h3>主要角色</h3><p>{task.required_characters.join("、")}</p></section>}
      {task.must_carry.length > 0 && <section><h3>承接要点</h3><ul>{task.must_carry.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
      {task.forbidden_advances.length > 0 && <section><h3>本章边界</h3><ul>{task.forbidden_advances.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
      {task.ending_state && <section><h3>章末状态</h3><p>{task.ending_state}</p></section>}
    </> : <p className="muted-note">{state === "loading" ? "正在读取本机规划…" : state === "invalid" ? "规划数据不完整，正文仍可阅读。请到章节规划核对。" : state === "error" ? "暂时无法读取本章规划。" : "本章尚无已批准的任务单。可以先阅读，也可以补充规划。"}</p>}
    <Link to={`/review?chapter=${chapterNumber}`}>查看章节规划 <ArrowRightOutlined /></Link>
  </aside>;
}
