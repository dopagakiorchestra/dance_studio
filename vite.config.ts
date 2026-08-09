import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 相対パスで出力しておくと GitHub Pages などサブディレクトリ配信でもそのまま動く
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
