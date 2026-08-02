import { useEffect, useRef } from "react";
import type { BufferGeometry } from "three";

/**
 * 3D 全息大脑：风格化但可辨识的大脑形态。
 * - 大脑半球：低细分球体 + 大块方向性皱褶（脑回）+ 深纵裂（左右半球分缝）
 * - 小脑：后下方条纹小球（风格化大脑的标志元素）
 * - 脑干：小圆柱
 * 三层全息材质（线框 / 半透明壳 / 粒子点云），自动三维旋转。
 * three 通过动态 import 加载，单独分包，不拖累主包体积。
 */
export default function HoloBrain3D() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const THREE = await import("three");
      const { SimplexNoise } = await import("three/examples/jsm/math/SimplexNoise.js");
      if (disposed || !mountRef.current) {
        return;
      }

      const mount = mountRef.current;
      const width = mount.clientWidth || 380;
      const height = mount.clientHeight || 320;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
      camera.position.set(0, 0.4, 4.3);
      camera.lookAt(0, -0.02, 0);

      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      mount.appendChild(renderer.domElement);

      const noise = new SimplexNoise();

      // ================= 大脑半球 =================
      // 细分 5：顶点足够密，皱褶起伏圆滑，呈脑回而非尖刺
      const cerebrumGeo = new THREE.IcosahedronGeometry(1.1, 5);
      const cerebrumPos = cerebrumGeo.attributes.position;
      const v = new THREE.Vector3();

      for (let i = 0; i < cerebrumPos.count; i++) {
        v.fromBufferAttribute(cerebrumPos, i);
        let x = v.x;
        let y = v.y;
        let z = v.z;

        // 基础脑型：前后拉长、明显压扁（大脑侧面是扁椭圆）
        z *= 1.34;
        y *= 0.72;
        x *= 0.95;

        // 枕叶（后脑勺，z < 0）略收窄
        if (z < 0) {
          x *= 1 + z * 0.08;
        }

        // 大脑下缘：底部向内微收，形成颞叶下沿
        if (y < -0.2) {
          const sag = y + 0.2;
          x *= 1 + sag * 0.1;
        }

        // 脑回皱褶：低频大波浪 + 高频细纹，圆滑起伏的盘绕感；
        // 底部区域衰减，避免下缘产生尖刺
        const foldRaw =
          noise.noise3d(x * 1.2, y * 1.2 * 0.45, z * 1.2) * 0.075 +
          noise.noise3d(x * 3.0, y * 3.0 * 0.5, z * 3.0) * 0.028;
        const bottomFade = y < -0.3 ? Math.max(0.25, 1 + (y + 0.3) * 1.6) : 1;
        const fold = foldRaw * bottomFade;
        x *= 1 + fold;
        y *= 1 + fold;
        z *= 1 + fold;

        // 纵裂：深窄中缝，沟底下压出 V 形深谷，俯视时清晰可见
        const groove = Math.exp(-(x * x) / 0.0045);
        x *= 1 - groove * 0.55;
        y -= groove * 0.34;

        cerebrumPos.setXYZ(i, x, y, z);
      }
      cerebrumGeo.computeVertexNormals();

      // ================= 小脑（后下方，水平细密条纹） =================
      const cerebellumGeo = new THREE.SphereGeometry(0.31, 36, 24);
      const cbPos = cerebellumGeo.attributes.position;
      const cv = new THREE.Vector3();
      for (let i = 0; i < cbPos.count; i++) {
        cv.fromBufferAttribute(cbPos, i);
        // 小脑标志性水平条纹
        const stripes = Math.sin(cv.y * 30) * 0.045 + noise.noise3d(cv.x * 3, cv.y * 3, cv.z * 3) * 0.02;
        const r = 1 + stripes;
        cbPos.setXYZ(i, cv.x * r, cv.y * r, cv.z * r);
      }
      cerebellumGeo.computeVertexNormals();

      // ================= 脑干 =================
      const stemGeo = new THREE.CylinderGeometry(0.085, 0.13, 0.4, 12, 3);

      // ================= 材质工厂 =================
      const makeWire = () =>
        new THREE.MeshBasicMaterial({
          color: 0x2bb3d6,
          wireframe: true,
          transparent: true,
          opacity: 0.5,
        });
      const makeShell = () =>
        new THREE.MeshBasicMaterial({
          color: 0x7fd8ec,
          transparent: true,
          opacity: 0.07,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
      const makePoints = (size = 0.024, opacity = 0.85) =>
        new THREE.PointsMaterial({
          color: 0xd6f5ff,
          size,
          transparent: true,
          opacity,
          sizeAttenuation: true,
          depthWrite: false,
        });

      const brain = new THREE.Group();
      scene.add(brain);

      const disposables: Array<{ dispose: () => void }> = [cerebrumGeo, cerebellumGeo, stemGeo];

      const addPart = (
        geometry: BufferGeometry,
        position: [number, number, number],
        scale: [number, number, number],
        rotation: [number, number, number],
        options: { withPoints?: boolean; withShell?: boolean; pointSize?: number; pointOpacity?: number } = {},
      ) => {
        const { withPoints = true, withShell = true, pointSize, pointOpacity } = options;
        const part = new THREE.Group();
        const wireMat = makeWire();
        disposables.push(wireMat);
        part.add(new THREE.Mesh(geometry, wireMat));
        if (withShell) {
          const shellMat = makeShell();
          disposables.push(shellMat);
          const shell = new THREE.Mesh(geometry, shellMat);
          shell.scale.setScalar(0.99);
          part.add(shell);
        }
        if (withPoints) {
          const pointsMat = makePoints(pointSize, pointOpacity);
          disposables.push(pointsMat);
          part.add(new THREE.Points(geometry, pointsMat));
        }
        part.position.set(...position);
        part.scale.set(...scale);
        part.rotation.set(...rotation);
        brain.add(part);
        return part;
      };

      // 大脑半球（主体）
      const cerebrumPart = addPart(cerebrumGeo, [0, 0.18, 0.05], [1, 1, 1], [0, 0, 0.04]);

      // 纵裂强调：沿顶部中线（x=0）的深色沟底管，让左右半球分界清晰可见
      {
        const groovePoints: InstanceType<typeof THREE.Vector3>[] = [];
        for (let z = -1.28; z <= 1.42; z += 0.06) {
          const zn = z / 1.474; // 大脑前后轴半径（1.1 × 1.34）
          if (Math.abs(zn) >= 1) {
            continue;
          }
          // 椭球表面顶部 y（x=0 处），略下沉到沟底
          const ySurf = 1.1 * 0.72 * Math.sqrt(1 - zn * zn);
          groovePoints.push(new THREE.Vector3(0, ySurf - 0.17, z));
        }
        const grooveCurve = new THREE.CatmullRomCurve3(groovePoints);
        const grooveTubeGeo = new THREE.TubeGeometry(grooveCurve, 40, 0.022, 6, false);
        const grooveMat = new THREE.MeshBasicMaterial({
          color: 0x1287ad,
          transparent: true,
          opacity: 0.85,
        });
        disposables.push(grooveTubeGeo, grooveMat);
        cerebrumPart.add(new THREE.Mesh(grooveTubeGeo, grooveMat));
      }
      // 小脑：后下方，藏在大脑后半之下（去壳层 + 稀疏点云，保持轻盈，避免实心感）
      addPart(cerebellumGeo, [0, -0.52, -0.95], [1.12, 0.7, 0.88], [0, 0, 0], {
        withShell: false,
        pointSize: 0.015,
        pointOpacity: 0.55,
      });
      // 脑干：从小脑前下方向下伸出，略前倾
      addPart(stemGeo, [0, -0.84, -0.26], [1, 1, 1], [0.42, 0, 0], {
        withPoints: false,
        withShell: false,
      });

      // 整体放大并略俯视，让顶部纵裂可见
      brain.scale.setScalar(1.28);
      brain.position.y = 0.08;

      const clock = new THREE.Clock();
      let raf = 0;
      const tick = () => {
        const t = clock.getElapsedTime();
        brain.rotation.y = t * 1.15; // 自转：1s 内约 66°
        brain.rotation.x = 0.24 + Math.sin(t * 0.6) * 0.04; // 固定俯视 + 轻摆动，让纵裂可见
        renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
      };
      tick();

      cleanup = () => {
        cancelAnimationFrame(raf);
        disposables.forEach((d) => d.dispose());
        renderer.dispose();
        if (renderer.domElement.parentNode === mount) {
          mount.removeChild(renderer.domElement);
        }
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return <div ref={mountRef} className="intro-brain3d" aria-hidden="true" />;
}
