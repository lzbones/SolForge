import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  publicDir: "../../assets", // card art (gitignored, local only) -> /cards/...
  server: { port: 5173, fs: { allow: ["../.."] } },
});
