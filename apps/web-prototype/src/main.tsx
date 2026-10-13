import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyAppearance, readAppearancePreferences } from "./appearance";
import "./styles.css";
import "./overrides.css";

applyAppearance(readAppearancePreferences());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
