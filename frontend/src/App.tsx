import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useApiHealth, useProjects } from "./hooks/useProjectData";
import IntroAnimation from "./components/intro/IntroAnimation";
import AppLayout from "./components/layout/AppLayout";
import DashboardPage from "./pages/DashboardPage";
import WritingCockpitPage from "./pages/WritingCockpitPage";
import ReaderPage from "./pages/ReaderPage";
import GraphPage from "./pages/GraphPage";
import { shouldShowIntro } from "./appConfig";

export default function App() {
  useApiHealth();
  const { refresh } = useProjects();
  const showIntro = shouldShowIntro();
  // 开屏动画关闭时 introDone 直接置 true，跳过动画阶段
  const [introDone, setIntroDone] = useState(!showIntro);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      {!introDone && <IntroAnimation onFinish={() => setIntroDone(true)} />}
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/writing" element={<WritingCockpitPage />} />
          <Route path="/reader" element={<ReaderPage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </>
  );
}
