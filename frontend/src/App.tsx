import { lazy, useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useApiHealth, useProjects } from "./hooks/useProjectData";
import IntroAnimation from "./components/intro/IntroAnimation";
import AppLayout from "./components/layout/AppLayout";
import DashboardPage from "./pages/DashboardPage";
import WritingCockpitPage from "./pages/WritingCockpitPage";
import ReaderPage from "./pages/ReaderPage";
const GraphPage = lazy(() => import("./pages/GraphPage"));
import SettingsPage from "./pages/SettingsPage";
import ReviewPage from "./pages/ReviewPage";
import LibraryPage from "./pages/LibraryPage";
import { markIntroSeen, shouldShowIntro } from "./appConfig";

export default function App() {
  useApiHealth();
  const { refresh } = useProjects();
  const [introDone, setIntroDone] = useState(() => !shouldShowIntro());
  const finishIntro = useCallback(() => { markIntroSeen(); setIntroDone(true); }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      {!introDone && <IntroAnimation onFinish={finishIntro} />}
      <div inert={!introDone}>
      <Routes>
        <Route element={<AppLayout onReplayIntro={() => setIntroDone(false)} />}>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/writing" element={<WritingCockpitPage />} />
          <Route path="/reader" element={<ReaderPage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
      </div>
    </>
  );
}
