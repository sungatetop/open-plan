import { defineConfig } from "electron-vite";
import path from "node:path";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      lib: { entry: path.resolve(__dirname, "src/main/index.ts") }
    }
  },
  preload: {
    build: {
      outDir: "out/preload",
      lib: { entry: path.resolve(__dirname, "src/preload/index.ts") }
    }
  },
  renderer: {
    root: path.resolve(__dirname, "src/renderer"),
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: {
          splash: path.resolve(__dirname, "src/renderer/index.html"),
          app: path.resolve(__dirname, "src/renderer/app/index.html")
        }
      }
    }
  }
});
