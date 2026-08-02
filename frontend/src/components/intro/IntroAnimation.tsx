import { useCallback, useEffect, useRef, useState } from "react";
import HoloBrain3D from "./HoloBrain3D";
import "./intro.css";

type IntroAnimationProps = {
  onFinish: () => void;
};

/** 总时长（3D 大脑旋转 <1s → 钢笔刺穿 → 渐变 logo → 退场） */
const TOTAL_MS = 3300;
/** 退场动画时长，与 intro-overlay-exit 保持一致 */
const EXIT_MS = 560;

function PenSvg() {
  return (
    <svg className="intro-pen-svg" viewBox="0 0 40 260" aria-hidden="true">
      <g
        stroke="#eafcff"
        strokeWidth="2"
        strokeLinejoin="round"
        fill="rgba(99, 214, 238, 0.2)"
      >
        {/* 笔杆 */}
        <rect x="13" y="14" width="14" height="158" rx="7" />
        {/* 笔夹 */}
        <rect x="23" y="22" width="3.4" height="48" rx="1.7" fill="#eafcff" opacity="0.85" stroke="none" />
        {/* 笔握环 */}
        <rect x="13" y="172" width="14" height="10" rx="3" fill="rgba(99, 214, 238, 0.35)" />
        {/* 笔尖 */}
        <path d="M 13 182 L 20 232 L 27 182 Z" />
        <line x1="20" y1="186" x2="20" y2="222" stroke="#0b3540" opacity="0.85" />
        <circle cx="20" cy="212" r="1.5" fill="#0b3540" stroke="none" opacity="0.85" />
      </g>
    </svg>
  );
}

export default function IntroAnimation({ onFinish }: IntroAnimationProps) {
  const [leaving, setLeaving] = useState(false);
  const finishedRef = useRef(false);

  const finish = useCallback(() => {
    if (finishedRef.current) {
      return;
    }
    finishedRef.current = true;
    setLeaving(true);
    window.setTimeout(() => {
      onFinish();
    }, EXIT_MS);
  }, [onFinish]);

  useEffect(() => {
    const timer = window.setTimeout(finish, TOTAL_MS);
    return () => window.clearTimeout(timer);
  }, [finish]);

  return (
    <div
      className={leaving ? "intro-overlay intro-overlay-leaving" : "intro-overlay"}
      onClick={finish}
      role="presentation"
      aria-label="Braipen 开场动画，点击跳过"
    >
      <div className="intro-stage">
        {/* 全息层：光环 + 3D 自转大脑 + 飞入钢笔 */}
        <div className="intro-holo">
          <div className="intro-halo" />
          <HoloBrain3D />
          <div className="intro-pen">
            <PenSvg />
          </div>
          <div className="intro-flash" />
        </div>

        {/* 最终简笔画 logo（含大脑 + braipen 文字 + 钢笔） */}
        <img className="intro-logo" src="/braipen.png" alt="braipen" />
        <div className="intro-brand">BRAIPEN</div>
      </div>

      <div className="intro-skip">点击任意处跳过</div>
    </div>
  );
}
