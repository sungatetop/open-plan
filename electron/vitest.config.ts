import path from "node:path";
import { defineConfig } from "vitest/config";

// 测试会直接 import 存量 client/src 的 jsx/js 模块与 electron 侧 TS 模块做对拍。
// client/ 自带 node_modules/react（版本与 electron 一致但物理上是两份拷贝），
// 若两侧组件分别绑定到两个 React 实例，hooks 会因 dispatcher 为空而崩溃。
// 这里把 react/react-dom 全部子路径强制解析到 electron 侧的单例。
const reactDir = path.resolve(__dirname, "node_modules/react");
const reactDomDir = path.resolve(__dirname, "node_modules/react-dom");

// 过渡桥（B6-5 context）：knowledge/template 分支动态引用旧 server 域模块，
// alias 解析到 electron 外物理文件，使 vi.mock（相对测试文件路径）与新旧行侧
// 的动态 import 解析到同一模块 id。
const legacyServerDir = path.resolve(__dirname, "../server");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@legacy-server\/kb\.mjs$/, replacement: path.join(legacyServerDir, "kb.mjs") },
      { find: /^@legacy-server\/tpl\.mjs$/, replacement: path.join(legacyServerDir, "tpl.mjs") },
      // B6-6-4g create-tools：office/map 族动态 legacy 模块通配解析（生产 electron.vite.config.ts main 段 alias 待装配时补齐）。
      { find: /^@legacy-server\/(.+\.mjs)$/, replacement: path.join(legacyServerDir, "$1") },
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
