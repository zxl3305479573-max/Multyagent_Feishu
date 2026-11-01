import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./components/ui/ui.css";
import "./style.css";
import { App } from "./App";
import { SkinProvider } from "./themes/SkinContext";

createRoot(document.getElementById("root")!).render(<SkinProvider><App /></SkinProvider>);
