import { useCallback, useEffect, useRef, useState } from "react";
import { isIntroHidden, markIntroSeen, setIntroHidden } from "../../appConfig";
import NeuralSculpture from "./NeuralSculpture";
import "./intro.css";

type IntroAnimationProps = { onFinish: () => void };

/** 进场总长 3.3 秒；退出动画和所有计时器随组件一起清理。 */
export default function IntroAnimation({ onFinish }: IntroAnimationProps) {
  const [leaving, setLeaving] = useState(false);
  const [hidden, setHidden] = useState(isIntroHidden);
  const leavingRef = useRef(false);
  const exitTimer = useRef<number | undefined>(undefined);
  const onFinishRef = useRef(onFinish);
  const skipRef = useRef<HTMLButtonElement>(null);
  onFinishRef.current = onFinish;

  const finish = useCallback(() => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    markIntroSeen();
    setLeaving(true);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    exitTimer.current = window.setTimeout(() => onFinishRef.current(), reduced ? 0 : 400);
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement;
    skipRef.current?.focus({ preventScroll: true });
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(finish, reduced ? 900 : 2900);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
      // 仅有两个交互项，保持键盘焦点在进场层中。
      if (event.key === "Tab") {
        const controls = document.querySelectorAll<HTMLElement>(".intro-overlay button, .intro-overlay input");
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(exitTimer.current);
      document.removeEventListener("keydown", onKey);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [finish]);

  return (
    <div className={`intro-overlay${leaving ? " intro-overlay-leaving" : ""}`} role="dialog" aria-modal="true" aria-label="Braipen 品牌进场">
      <div className="intro-topline"><span>BRAIPEN / CREATIVE INTELLIGENCE</span><span>从一个念头开始</span></div>
      <div className="intro-stage">
        <div className="intro-art"><NeuralSculpture /></div>
        <div className="intro-wordmark">braipen<span>.</span></div>
        <p className="intro-statement">思想，有迹可循。</p>
        <div className="intro-rule" aria-hidden="true"><span /></div>
      </div>
      <div className="intro-bottomline">
        <label className="intro-preference"><input type="checkbox" checked={hidden} onChange={(event) => { setHidden(event.target.checked); setIntroHidden(event.target.checked); }} />不再自动播放</label>
        <button ref={skipRef} className="intro-skip" onClick={finish}>进入工作台 <span aria-hidden="true">↗</span><kbd>Esc</kbd></button>
      </div>
    </div>
  );
}
