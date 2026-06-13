import type { ApiStatus } from "../types";

export type ActivePage =
  | "home"
  | "create"
  | "read"
  | "library"
  | "projectSettings"
  | "systemSettings";

const NAV_ITEMS: { page: Exclude<ActivePage, "home">; label: string }[] = [
  { page: "create", label: "创作" },
  { page: "read", label: "阅读" },
  { page: "library", label: "资料库" },
  { page: "projectSettings", label: "项目配置" },
  { page: "systemSettings", label: "系统设置" },
];

function statusText(status: ApiStatus): string {
  if (status === "online") {
    return "API Online";
  }
  if (status === "offline") {
    return "API Offline";
  }
  return "Loading";
}

type AppHeaderProps = {
  activePage: ActivePage;
  apiStatus: ApiStatus;
  onNavigate: (page: ActivePage) => void;
};

export function AppHeader({ activePage, apiStatus, onNavigate }: AppHeaderProps) {
  return (
    <header className="app-header">
      <button className="brand-button" type="button" onClick={() => onNavigate("home")} aria-label="返回 Braipen 首页">
        <span className="brand-mark" aria-hidden="true">
          B
        </span>
        <span className="brand-name">Braipen</span>
      </button>

      <nav className="app-nav" aria-label="工作区导航">
        {NAV_ITEMS.map((item) => {
          const selected = activePage === item.page;
          return (
            <button
              className={`nav-button ${selected ? "selected" : ""}`}
              type="button"
              key={item.page}
              aria-current={selected ? "page" : undefined}
              onClick={() => onNavigate(item.page)}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="header-status-area">
        <div className={`status-pill status-${apiStatus}`}>{statusText(apiStatus)}</div>
      </div>
    </header>
  );
}
