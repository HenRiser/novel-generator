import { create } from "zustand";
import type {
  ApiStatus,
  ChapterStatusResponse,
  ChapterSummary,
  GenerationStatus,
  ProjectDetail,
  ProjectSummary,
} from "../types";

type GenerationBusyState = {
  outlineGenerating: boolean;
  chapterGenerating: boolean;
  chapterStreaming: boolean;
};

type AppState = {
  apiStatus: ApiStatus;
  projects: ProjectSummary[];
  projectsLoading: boolean;
  selectedProjectRef: string | null;
  selectedProject: ProjectDetail | null;
  projectLoading: boolean;
  chapters: ChapterSummary[];
  chaptersLoading: boolean;
  generationStatus: GenerationStatus | null;
  generationStatusLoading: boolean;
  chapterStatus: ChapterStatusResponse | null;
  chapterStatusLoading: boolean;
  generationBusy: GenerationBusyState;
};

type AppActions = {
  setApiStatus: (status: ApiStatus) => void;
  setProjects: (projects: ProjectSummary[]) => void;
  setProjectsLoading: (loading: boolean) => void;
  selectProject: (ref: string | null) => void;
  setSelectedProject: (project: ProjectDetail | null) => void;
  setProjectLoading: (loading: boolean) => void;
  setChapters: (chapters: ChapterSummary[]) => void;
  setChaptersLoading: (loading: boolean) => void;
  setGenerationStatus: (status: GenerationStatus | null) => void;
  setGenerationStatusLoading: (loading: boolean) => void;
  setChapterStatus: (status: ChapterStatusResponse | null) => void;
  setChapterStatusLoading: (loading: boolean) => void;
  setBusy: (patch: Partial<GenerationBusyState>) => void;
  /** 删除当前项目后清空所有与该项目相关的状态 */
  clearProjectState: () => void;
};

const initialBusy: GenerationBusyState = {
  outlineGenerating: false,
  chapterGenerating: false,
  chapterStreaming: false,
};

export const useAppStore = create<AppState & AppActions>((set) => ({
  apiStatus: "loading",
  projects: [],
  projectsLoading: false,
  selectedProjectRef: null,
  selectedProject: null,
  projectLoading: false,
  chapters: [],
  chaptersLoading: false,
  generationStatus: null,
  generationStatusLoading: false,
  chapterStatus: null,
  chapterStatusLoading: false,
  generationBusy: initialBusy,

  setApiStatus: (apiStatus) => set({ apiStatus }),
  setProjects: (projects) => set({ projects }),
  setProjectsLoading: (projectsLoading) => set({ projectsLoading }),
  selectProject: (selectedProjectRef) => set({ selectedProjectRef }),
  setSelectedProject: (selectedProject) => set({ selectedProject }),
  setProjectLoading: (projectLoading) => set({ projectLoading }),
  setChapters: (chapters) => set({ chapters }),
  setChaptersLoading: (chaptersLoading) => set({ chaptersLoading }),
  setGenerationStatus: (generationStatus) => set({ generationStatus }),
  setGenerationStatusLoading: (generationStatusLoading) => set({ generationStatusLoading }),
  setChapterStatus: (chapterStatus) => set({ chapterStatus }),
  setChapterStatusLoading: (chapterStatusLoading) => set({ chapterStatusLoading }),
  setBusy: (patch) => set((state) => ({ generationBusy: { ...state.generationBusy, ...patch } })),
  clearProjectState: () =>
    set({
      selectedProjectRef: null,
      selectedProject: null,
      projectLoading: false,
      chapters: [],
      chaptersLoading: false,
      generationStatus: null,
      generationStatusLoading: false,
      chapterStatus: null,
      chapterStatusLoading: false,
      generationBusy: { ...initialBusy },
    }),
}));

/** 便捷选择器：任意生成任务是否进行中 */
export const selectGenerationBusy = (state: AppState): boolean => {
  const busy = state.generationBusy;
  return busy.outlineGenerating || busy.chapterGenerating || busy.chapterStreaming;
};
