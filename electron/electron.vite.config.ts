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
    server: {
      fs: {
        // workbench.tsx 跨根引入 client/src/styles.css（迁移期版式对齐旧客户端），放开项目根
        allow: [path.resolve(__dirname, "..")]
      }
    },
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
