import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standard Vite + React setup. Nothing fancy here — the graph JSON lives in
// /public so it is served as a static asset and fetched at runtime by the app.
export default defineConfig({
  plugins: [react()],
});
