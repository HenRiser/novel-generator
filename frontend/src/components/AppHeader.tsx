import type { ApiStatus } from "../types";

export type ActivePage = "dashboard" | "writing" | "review" | "memory" | "settings";

const NAV_ITEMS: { page: ActivePage; label: string }[] = [
  { page: "dashboard", label: "Dashboard" },
  { page: "writing", label: "Writing Cockpit" },
  { page: "review", label: "Review" },
  { page: "memory", label: "Memory" },
  { page: "settings", label: "Settings" },
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
      <button className="brand-button" type="button" onClick={() => onNavigate("dashboard")} aria-label="Open Braipen dashboard">
        <span className="brand-mark" aria-hidden="true">
          B
        </span>
        <span className="brand-name">Braipen</span>
      </button>

      <nav className="app-nav" aria-label="Product navigation">
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
