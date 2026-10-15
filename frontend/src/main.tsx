import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App as AntApp } from "antd";
import { BrowserRouter } from "react-router-dom";
import { applyAppearance, readAppearance } from "./theme";
import { AppearanceProvider } from "./components/AppearanceProvider";
import App from "./App";
import "./styles/fonts.css";
import "./styles/global.css";

const initialAppearance = readAppearance();
applyAppearance(initialAppearance);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppearanceProvider initialAppearance={initialAppearance}>
      <AntApp>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntApp>
    </AppearanceProvider>
  </StrictMode>,
);
