import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/App";
import "@/styles/theme.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 挂载点");
}

function Boot() {
  useEffect(() => {
    // The window is only meaningful once the theme tokens are attached.
    document.documentElement.dataset.ready = "true";
  }, []);
  return <App />;
}

createRoot(container).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
