import path from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根锚点：旧 server/workspace.mjs 的 PROJECT_DIR 最小替代（B2 收编前的临时锚点）。
// 旧实现以 server/ 源码目录为基准上一级；本模块位于 electron/src/main/backend/，上四级同为仓库根。
// 注意：当前仅对拍覆盖、未装配运行时；B2 收编 main 进程时按打包产物位置（out/main）重新校正层级。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_DIR = path.resolve(__dirname, "..", "..", "..", "..");

// 桌面端自有静态资产根（R6-7b：glyphs 字形 / xinchang-data 公交数据 / pi-extensions 扩展 /
// pi-builtin-providers.json 供应商目录），替代退役 server/ 内的旧锚点；打包态随 R6-8
// resources 入包与本文件 PROJECT_DIR 层级重校一并在唯一锚点收口。
export const RESOURCES_DIR = path.join(PROJECT_DIR, "electron", "resources");
