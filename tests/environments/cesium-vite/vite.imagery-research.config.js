import cesium from "vite-plugin-cesium";
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(process.cwd(), "imagery-research"),
  base: "/imagery-research/",
  plugins: [cesium()],
  optimizeDeps: {
    include: ["cesium"],
  },
});
