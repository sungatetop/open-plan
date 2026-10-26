import { defineConfig } from "electron-vite";
import path from "node:path";

export default defineConfig({
  main: {
    resolve: {
      alias: {
        // 过渡桥构建域备用 alias（与 vitest.config.ts 同源）：已迁 TS 模块经
        // @legacy-server 引用旧 server 域导出时由构建解析。装配层当前走运行时
        // 物理路径动态加载（assembly.ts，路径锚点保真），此 alias 供后续模块
        // 静态引用场景与构建期解析兜底。
        "@legacy-server": path.resolve(__dirname, "../server")
      }
    },
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
