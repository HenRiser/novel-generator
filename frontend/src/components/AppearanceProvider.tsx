import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { ConfigProvider, Dropdown, Button } from "antd";
import { SkinOutlined } from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import { APPEARANCES, APPEARANCE_KEY, applyAppearance, getAppearanceTheme, isAppearance, readAppearance, type Appearance } from "../theme";

const AppearanceContext = createContext<{ appearance: Appearance; setAppearance: (value: Appearance) => void } | null>(null);

export function AppearanceProvider({ children, initialAppearance }: { children: ReactNode; initialAppearance: Appearance }) {
  const [appearance, update] = useState(initialAppearance);
  const setAppearance = useCallback((value: Appearance) => {
    if (!isAppearance(value)) return;
    update(value);
    try { window.localStorage.setItem(APPEARANCE_KEY, value); }
    catch { /* Keep the tab's appearance usable when browser storage is blocked. */ }
  }, []);
  useLayoutEffect(() => { applyAppearance(appearance); }, [appearance]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === APPEARANCE_KEY || event.key === null) update(readAppearance());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const theme = useMemo(() => getAppearanceTheme(appearance), [appearance]);
  return <AppearanceContext.Provider value={{ appearance, setAppearance }}>
    <ConfigProvider locale={zhCN} theme={theme}>{children}</ConfigProvider>
  </AppearanceContext.Provider>;
}

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("AppearanceProvider is required.");
  return value;
}

export function AppearancePicker() {
  const { appearance, setAppearance } = useAppearance();
  const selected = APPEARANCES.find(item => item.value === appearance)!;
  return <Dropdown trigger={["click"]} menu={{ selectedKeys: [appearance], items: APPEARANCES.map(item => ({ key: item.value, label: `${item.label}${item.value === "editorial" ? " · 默认" : ""}` })), onClick: ({ key }) => { if (isAppearance(key)) setAppearance(key); } }}>
    <Button className="appearance-picker" type="text" icon={<SkinOutlined />} aria-label={`切换界面主题，当前${selected.label}`} title={`界面主题：${selected.label}`}><span className="appearance-picker-label">{selected.label}</span></Button>
  </Dropdown>;
}

export function AppearanceSettings() {
  const { appearance, setAppearance } = useAppearance();
  return <section className="appearance-settings" aria-labelledby="appearance-title">
    <div className="appearance-heading"><h2 id="appearance-title">界面主题</h2><p>同一张书桌，三种底色。仅保存在当前浏览器；正文可在“排版”中单独选择底色。</p></div>
    <fieldset className="appearance-options"><legend className="sr-only">选择界面主题</legend>{APPEARANCES.map(item => <label key={item.value} className={`appearance-option${appearance === item.value ? " is-selected" : ""}`}>
      <input type="radio" name="appearance" value={item.value} checked={appearance === item.value} onChange={() => setAppearance(item.value)} />
      <span><strong>{item.label}{item.value === "editorial" && <small>默认</small>}</strong><span>{item.description}</span></span>
    </label>)}</fieldset>
  </section>;
}
