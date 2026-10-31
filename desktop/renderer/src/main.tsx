import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./style.css";
import { App } from "./App";
import { applyStoredSkin } from "./themes/apply";

applyStoredSkin();
createRoot(document.getElementById("root")!).render(<App />);
