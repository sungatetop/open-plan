import path from "node:path";
import { defineConfig } from "vitest/config";

// fs.allow 放开项目根：backend 静态 import electron 外的 scripts/lib/tiler.mjs
// （map.ts/layer-repository.ts 生产依赖），vite-node 装载该模块链需要。
// （R6-6b 期曾同时服务 client/src 对拍装载与 client 双 react 拷贝单例化——
// react 单例别名族随 R6-7b client/ 本体删除退役。）

export default defineConfig({
  server: {
    fs: {
      allow: [path.resolve(__dirname, "..")]
    }
  },
});
