import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "desktop/renderer",
  // Electron loads the renderer with a file:// URL in packaged builds.
  // Relative asset URLs are required there; absolute /assets URLs resolve to
  // the drive root (for example file:///D:/assets) and leave a blank window.
  base: "./",
  plugins: [react()],
  build: { outDir: "../../dist/desktop", emptyOutDir: true },
  server: { port: 5174, strictPort: true },
});
