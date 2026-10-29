import path from "node:path";
import { defineConfig } from "vitest/config";

// 测试会直接 import 存量 client/src 的 jsx/js 模块与 electron 侧 TS 模块做对拍。
// client/ 自带 node_modules/react（版本与 electron 一致但物理上是两份拷贝），
// 若两侧组件分别绑定到两个 React 实例，hooks 会因 dispatcher 为空而崩溃。
// 这里把 react/react-dom 全部子路径强制解析到 electron 侧的单例。
const reactDir = path.resolve(__dirname, "node_modules/react");
const reactDomDir = path.resolve(__dirname, "node_modules/react-dom");

export default defineConfig({
  server: {
    fs: {
      // B2 装配层：assembly.ts 经运行时物理路径动态加载 electron 外的旧 server
      // 模块（与生产同形态、路径锚点保真），放开项目根供 vite-node 解析。
      allow: [path.resolve(__dirname, "..")]
    }
  },
  resolve: {
    alias: [
      { find: /^react$/, replacement: path.join(reactDir, "index.js") },
      { find: /^react\/jsx-runtime$/, replacement: path.join(reactDir, "jsx-runtime.js") },
      { find: /^react\/jsx-dev-runtime$/, replacement: path.join(reactDir, "jsx-dev-runtime.js") },
      { find: /^react-dom\/client$/, replacement: path.join(reactDomDir, "client.js") },
      { find: /^react-dom\/server$/, replacement: path.join(reactDomDir, "server.js") },
      { find: /^react-dom\/test-utils$/, replacement: path.join(reactDomDir, "test-utils.js") },
      { find: /^react-dom$/, replacement: path.join(reactDomDir, "index.js") },
    ],
  },
});
