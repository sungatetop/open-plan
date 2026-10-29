import path from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根/应用根锚点：旧 server/workspace.mjs 的 PROJECT_DIR 最小替代。
// 三态层级重校（R6-8；此前按源码层级固定上跳四级，bundle 后 __dirname 变为
// electron/out/main，上跳四级解析到仓库根的上级——运行时数据落盘错位实锤
// D:\.oaw、D:\.规聚会话）：
// - 源码/vitest：…/electron/src/main/backend → 上跳 4 级 = 仓库根
// - dev bundle：…/electron/out/main → 上跳 3 级 = 仓库根
// - 打包：…/resources/app/out/main（electron-builder 固定布局，asar 关闭）→ 上跳 2 级 = 应用根
const here = path.dirname(fileURLToPath(import.meta.url));

// 源码形态判定统一以 / 比对（b6 对拍 mock fileURLToPath 注入 / 分隔假路径，Windows
// 原生路径为 \ 分隔，规范化后两端一致）。
const IS_SOURCE = here.replaceAll("\\", "/").endsWith("electron/src/main/backend");

const LEVELS_UP = IS_SOURCE
  ? 4
  : path.basename(path.resolve(here, "..", "..")) === "resources"
    ? 2
    : 3;

export const PROJECT_DIR = path.resolve(here, ...Array.from({ length: LEVELS_UP }, () => ".."));

// 桌面端自有静态资产根（R6-7b：glyphs 字形 / xinchang-data 公交数据 / pi-extensions 扩展 /
// pi-builtin-providers.json 供应商目录）。dev 态锚 electron/resources；打包态随
// electron-builder files 的 resources/** 入包，锚应用根/resources。
export const RESOURCES_DIR =
  LEVELS_UP === 2 ? path.join(PROJECT_DIR, "resources") : path.join(PROJECT_DIR, "electron", "resources");
