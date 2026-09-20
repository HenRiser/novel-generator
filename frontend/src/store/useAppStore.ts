import { create } from "zustand";
import { getRememberedProject, rememberProject } from "../workspacePreferences";
import type {
  ApiStatus,
  BatchGenerationStatus,
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
  batchGenerating: boolean;
};

type AppState = {
  apiStatus: ApiStatus;
  projects: ProjectSummary[];
  projectsLoading: boolean;
  projectsLoaded: boolean;
  selectedProjectRef: string | null;
  selectedProject: ProjectDetail | null;
  projectLoading: boolean;
  chapters: ChapterSummary[];
  chaptersLoading: boolean;
  chaptersLoaded: boolean;
  generationStatus: GenerationStatus | null;
  generationStatusLoading: boolean;
  chapterStatus: ChapterStatusResponse | null;
  chapterStatusLoading: boolean;
  generationBusy: GenerationBusyState;
  batchStatus: BatchGenerationStatus | null;
  batchStatusLoading: boolean;
  batchStatusError: string;
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
  setBatchStatus: (status: BatchGenerationStatus) => void;
  setBatchStatusLoading: (loading: boolean) => void;
  setBatchStatusError: (error: string) => void;
  /** 删除当前项目后清空所有与该项目相关的状态 */
  clearProjectState: () => void;
};

const initialBusy: GenerationBusyState = {
  outlineGenerating: false,
  chapterGenerating: false,
  chapterStreaming: false,
  batchGenerating: false,
};

export const useAppStore = create<AppState & AppActions>((set) => ({
  apiStatus: "loading",
  projects: [],
  projectsLoading: false,
  projectsLoaded: false,
  selectedProjectRef: null,
  selectedProject: null,
  projectLoading: false,
  chapters: [],
  chaptersLoading: false,
  chaptersLoaded: false,
  generationStatus: null,
  generationStatusLoading: false,
  chapterStatus: null,
  chapterStatusLoading: false,
  generationBusy: initialBusy,
  batchStatus: null,
  batchStatusLoading: false,
  batchStatusError: "",

  setApiStatus: (apiStatus) => set({ apiStatus }),
  setProjects: (projects) => set((state) => {
    const requested = state.projectsLoaded ? state.selectedProjectRef : state.selectedProjectRef ?? getRememberedProject();
    const selectedProjectRef = projects.some((project) => project.project_ref === requested) ? requested : null;
    rememberProject(selectedProjectRef);
    return selectedProjectRef === state.selectedProjectRef ? { projects, projectsLoaded: true } : {
      projects, projectsLoaded: true, selectedProjectRef, selectedProject: null, projectLoading: false,
      chapters: [], chaptersLoading: false, chaptersLoaded: false,
      generationStatus: null, generationStatusLoading: false,
      chapterStatus: null, chapterStatusLoading: false,
      batchStatus: null, batchStatusLoading: false, batchStatusError: "",
      generationBusy: { ...initialBusy },
    };
  }),
  setProjectsLoading: (projectsLoading) => set({ projectsLoading }),
  selectProject: (selectedProjectRef) => { rememberProject(selectedProjectRef); set((state) => state.selectedProjectRef === selectedProjectRef ? {} : ({
    selectedProjectRef,
    selectedProject: null,
    projectLoading: false,
    chapters: [],
    chaptersLoading: false,
    chaptersLoaded: false,
    generationStatus: null,
    generationStatusLoading: false,
    chapterStatus: null,
    chapterStatusLoading: false,
    generationBusy: { ...initialBusy },
    batchStatus: null,
    batchStatusLoading: false,
    batchStatusError: "",
  })); },
  setSelectedProject: (selectedProject) => set({ selectedProject }),
  setProjectLoading: (projectLoading) => set({ projectLoading }),
  setChapters: (chapters) => set({ chapters, chaptersLoaded: true }),
  setChaptersLoading: (chaptersLoading) => set({ chaptersLoading }),
  setGenerationStatus: (generationStatus) => set({ generationStatus }),
  setGenerationStatusLoading: (generationStatusLoading) => set({ generationStatusLoading }),
  setChapterStatus: (chapterStatus) => set({ chapterStatus }),
  setChapterStatusLoading: (chapterStatusLoading) => set({ chapterStatusLoading }),
  setBusy: (patch) => set((state) => ({ generationBusy: { ...state.generationBusy, ...patch } })),
  setBatchStatus: (batchStatus) => set((state) => ({ batchStatus, generationBusy: { ...state.generationBusy, batchGenerating: batchStatus.status === "running" || batchStatus.status === "stopping" } })),
  setBatchStatusLoading: (batchStatusLoading) => set({ batchStatusLoading }),
  setBatchStatusError: (batchStatusError) => set({ batchStatusError }),
  clearProjectState: () => {
    rememberProject(null);
    set({
      selectedProjectRef: null,
      selectedProject: null,
      projectLoading: false,
      chapters: [],
      chaptersLoading: false,
      chaptersLoaded: false,
      generationStatus: null,
      generationStatusLoading: false,
      chapterStatus: null,
      chapterStatusLoading: false,
      generationBusy: { ...initialBusy },
      batchStatus: null,
      batchStatusLoading: false,
      batchStatusError: "",
    });
  },
}));

/** 便捷选择器：任意生成任务是否进行中 */
export const selectGenerationBusy = (state: AppState): boolean => {
  const busy = state.generationBusy;
  return busy.outlineGenerating || busy.chapterGenerating || busy.chapterStreaming || busy.batchGenerating;
};
