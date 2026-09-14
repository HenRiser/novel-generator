import { useEffect, useRef } from "react";
import "./intro.css";

type Point = [number, number, number];
type Fiber = { points: Point[]; accent?: boolean; weight: number };

/** 两个半球共享一条中缝；曲面上的细小起伏形成蚀刻般的脑回纹理。 */
function hemisphere(side: number, latitude: number, longitude: number): Point {
  const ring = Math.cos(latitude);
  const top = 1 + 0.1 * Math.sin(latitude);
  const fold = Math.sin(latitude * 10 + Math.sin(longitude * 3) * 1.8) * 2.2
    + Math.sin(longitude * 9 + latitude * 4) * 1.25;
  return [
    side * (4 + (1 + Math.cos(longitude)) * (31 * ring * top + fold * ring)),
    Math.sin(latitude) * 73 + Math.sin(longitude * 5 + latitude * 7) * ring * 1.9,
    Math.sin(longitude) * (53 * ring + fold * ring * 1.1),
  ];
}

function createFibers(): Fiber[] {
  const fibers: Fiber[] = [];
  for (const side of [-1, 1]) {
    for (let row = 1; row < 34; row += 1) {
      const latitude = -Math.PI / 2 + row / 34 * Math.PI;
      for (let quarter = 0; quarter < 4; quarter += 1) {
        const points: Point[] = [];
        for (let step = 0; step <= 22; step += 1) {
          points.push(hemisphere(side, latitude, (quarter + step / 22) * Math.PI / 2));
        }
        fibers.push({ points, weight: row % 5 === 0 ? 0.85 : 0.55 });
      }
    }
    for (let col = 0; col < 16; col += 1) {
      const longitude = col / 16 * Math.PI * 2;
      for (let half = 0; half < 2; half += 1) {
        const points: Point[] = [];
        for (let step = 0; step <= 25; step += 1) {
          points.push(hemisphere(side, -Math.PI / 2 + (half + step / 25) * Math.PI / 2, longitude));
        }
        fibers.push({ points, weight: 0.5 });
      }
    }
  }
  // 脑干把双半球的轮廓收束为一笔；这是一幅意象雕塑，并非解剖模型。
  for (let strand = 0; strand < 7; strand += 1) {
    const points: Point[] = [];
    for (let step = 0; step <= 22; step += 1) {
      const t = step / 22;
      points.push([(strand - 3) * (2.1 - t * 1.2) + Math.sin(t * 2.4) * 6, -64 - t * 29, 8 + t * 14]);
    }
    fibers.push({ points, weight: 0.7 });
  }
  return fibers;
}

const FIBERS = createFibers();

export default function NeuralSculpture({ className = "" }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!container || !canvas || !ctx) return;
    container.dataset.ready = "true";
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0;
    let height = 0;
    let frame = 0;
    let elapsed = 0;
    let lastFrame = 0;
    let visible = true;

    const paint = () => {
      if (!width || !height) return;
      ctx.clearRect(0, 0, width, height);
      const scale = Math.min(width / 235, height / 224);
      const yaw = 0.31 + Math.sin(elapsed * 0.2) * 0.48;
      const pitch = -0.32;
      const roll = -0.12;
      const project = ([x, y, z]: Point): Point => {
        const rx = x * Math.cos(yaw) + z * Math.sin(yaw);
        const rz = -x * Math.sin(yaw) + z * Math.cos(yaw);
        const ry = y * Math.cos(pitch) - rz * Math.sin(pitch);
        const depth = y * Math.sin(pitch) + rz * Math.cos(pitch);
        return [
          width * 0.5 + (rx * Math.cos(roll) - ry * Math.sin(roll)) * scale,
          height * 0.445 - (rx * Math.sin(roll) + ry * Math.cos(roll)) * scale,
          depth,
        ];
      };

      // 淡淡的纸上落影，让线条悬于页面之上，不依赖发光或粒子噪点。
      ctx.save();
      ctx.translate(width * 0.52, height * 0.9);
      ctx.scale(scale, scale * 0.15);
      const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, 65);
      shadow.addColorStop(0, "rgba(23,63,53,0.1)");
      shadow.addColorStop(1, "rgba(23,63,53,0)");
      ctx.fillStyle = shadow;
      ctx.fillRect(-65, -65, 130, 130);
      ctx.restore();

      const projected = FIBERS.map((fiber) => {
        const points = fiber.points.map(project);
        return { ...fiber, points, depth: points.reduce((sum, point) => sum + point[2], 0) / points.length };
      }).sort((a, b) => a.depth - b.depth);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const fiber of projected) {
        const nearness = Math.max(0, Math.min(1, (fiber.depth + 64) / 128));
        ctx.beginPath();
        fiber.points.forEach(([x, y], index) => index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
        ctx.strokeStyle = `rgba(23,63,53,${0.07 + nearness * 0.55})`;
        ctx.lineWidth = fiber.weight * scale;
        ctx.stroke();
      }

      // 少量暖色连接点，保留神经网络的暗示与阅读所需的留白。
      const markers: Point[] = [hemisphere(-1, 0.45, 0.78), hemisphere(1, -0.18, 1.12), hemisphere(1, 0.84, 0.5)];
      for (const point of markers) {
        const [x, y] = project(point);
        ctx.beginPath();
        ctx.arc(x, y, 2.2 * scale, 0, Math.PI * 2);
        ctx.fillStyle = "#bd6d45";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 5 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(189,109,69,.22)";
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
    };

    const animate = (time: number) => {
      if (time - lastFrame >= 32) {
        elapsed += Math.min((time - lastFrame) / 1000, 0.05);
        lastFrame = time;
        paint();
      }
      frame = window.requestAnimationFrame(animate);
    };
    const updateAnimation = () => {
      window.cancelAnimationFrame(frame);
      lastFrame = performance.now();
      paint();
      if (!motion.matches && visible && !document.hidden) frame = window.requestAnimationFrame(animate);
    };
    const resize = () => {
      const box = container.getBoundingClientRect();
      width = box.width;
      height = box.height;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      updateAnimation();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      updateAnimation();
    });
    intersectionObserver.observe(container);
    motion.addEventListener("change", updateAnimation);
    document.addEventListener("visibilitychange", updateAnimation);
    resize();
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      motion.removeEventListener("change", updateAnimation);
      document.removeEventListener("visibilitychange", updateAnimation);
      delete container.dataset.ready;
    };
  }, []);

  return (
    <div ref={containerRef} className={`neural-sculpture ${className}`} role="img" aria-label="缓缓转动的双半球脑形线条雕塑">
      <svg className="neural-sculpture-fallback" viewBox="0 0 300 270" aria-hidden="true" fill="none" stroke="#173f35" strokeWidth="1">
        <path d="M145 35C125 18 89 34 76 55C46 62 38 88 46 110C28 139 46 163 63 169C58 194 82 212 103 205C117 224 143 209 146 190L145 35ZM155 35C175 18 211 34 224 55C254 62 262 88 254 110C272 139 254 163 237 169C242 194 218 212 197 205C183 224 157 209 154 190L155 35Z" />
        <path d="M125 52C108 66 128 79 117 91S92 95 94 117S121 131 116 148S94 171 110 187M83 73C73 95 93 94 85 112S64 130 71 149M175 52C192 66 172 79 183 91S208 95 206 117S179 131 184 148S206 171 190 187M217 73C227 95 207 94 215 112S236 130 229 149M146 185Q143 219 153 242M154 185Q153 219 161 242" />
      </svg>
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}
