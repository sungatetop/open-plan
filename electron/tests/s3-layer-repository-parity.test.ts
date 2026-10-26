/**
 * S3-10 layer-repository 域对拍：legacy 物理加载 server/layer-repository.mjs（其
 * import 链 server/map.mjs → server/workspace.mjs）vs modern 静态 import TS
 * backend/layer-repository（直绑 map.ts）。双侧 MAPS_ROOT 同锚
 * {仓库根}/office-workspace/maps。
 *
 * 覆盖：导出面 8；ORIGIN 冻结常量；parseSelector 全形态（含中文冒号）；纯函数
 * isSharedLayerId/layerOriginOf/layerRef 四分支；listLayers scope 过滤与 style
 * visible 优先（samePath 大小写/分隔符归一）；resolveLayer 五选择器与无匹配文案；
 * annotateProject 干跑/落盘；markLayerOwnership 共享 id 保护与写盘——落盘用例按
 * S3-8 先例双侧各一临时项目、结果快照（项目名占位归一）互等，afterAll 清理。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_DIR } from "../src/main/backend/workspace";

type ModernRepo = typeof import("../src/main/backend/layer-repository");

// legacy 侧经 any 载体调用：旧 .mjs 无类型标注，tsc 对解构默认值（sharedIds = [] /
// config = null）推断出 never[]/null|undefined 的形参类型，直接传参会误报。
let legacy: any;
let modern: ModernRepo;

const MAPS_ROOT = path.join(WORKSPACE_DIR, "maps");
const RUN_ID = `s3l10lr-${process.pid}-${Date.now().toString(36)}`;
const PID_RO = `${RUN_ID}-ro`;
const PID_L = `${RUN_ID}-l`;
const PID_M = `${RUN_ID}-m`;
const PID_AL = `${RUN_ID}-al`;
const PID_AM = `${RUN_ID}-am`;

const WS = "D:\\s3l10-ws\\Me";

const RO_CONFIG = {
  name: "S3-10 只读对拍",
  center: [120, 30],
  zoom: 8,
  basemap: "gaode-road",
  sharedLayers: ["declared-shared"],
  layers: [
    { id: "highways", name: "高速公路", type: "line", group: "内置" },
    { id: "declared-shared", name: "声明共享", type: "line" },
    { id: "cust-a", name: "他人图层", type: "fill", origin: "workspace", owner: "D:\\s3l10-ws\\Other" },
    { id: "cust-b", name: "未标注图层", type: "fill" },
    { id: "cust-c", name: "本人图层", type: "circle", origin: "workspace", owner: WS },
    { id: "", name: "空id跳过", type: "fill" },
  ],
};
const RO_STYLE = {
  version: 8,
  layers: [
    { id: "cust-b", type: "fill", layout: { visibility: "none" } },
    { id: "highways", type: "line", layout: { visibility: "visible" } },
  ],
};

function writeProject(pid: string, config: any, style: any = RO_STYLE): string {
  const dir = path.join(MAPS_ROOT, pid);
  fs.mkdirSync(path.join(dir, "layers"), { recursive: true });
  fs.writeFileSync(path.join(dir, "map.config.json"), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(dir, "style.json"), JSON.stringify(style, null, 2));
  return dir;
}

function normalize<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** 快照归一：项目名（含双侧 fixture id 差异）替换为占位。 */
function snapshot(pid: string): any {
  const raw = fs.readFileSync(path.join(MAPS_ROOT, pid, "map.config.json"), "utf8");
  return JSON.parse(raw.replace(new RegExp(pid, "g"), "__PID__"));
}

beforeAll(async () => {
  legacy = await import("@legacy-server/layer-repository.mjs");
  modern = await import("../src/main/backend/layer-repository");
  writeProject(PID_RO, RO_CONFIG);
});

afterAll(() => {
  for (const pid of [PID_RO, PID_L, PID_M, PID_AL, PID_AM]) {
    try { fs.rmSync(path.join(MAPS_ROOT, pid), { recursive: true, force: true }); } catch {}
  }
});

describe("s3-layer-repository-parity 导出面与常量", () => {
  it("导出面一致（8 项）", () => {
    expect(Object.keys(modern).sort()).toEqual(Object.keys(legacy).sort());
  });

  it("ORIGIN 冻结常量互等", () => {
    expect(normalize(modern.ORIGIN)).toEqual(normalize(legacy.ORIGIN));
    expect(Object.isFrozen(modern.ORIGIN)).toBe(true);
  });
});

describe("s3-layer-repository-parity 纯函数", () => {
  it("parseSelector：五前缀 + 中文冒号 + 大小写 + 裸值 + 空", () => {
    const cases = [
      "id:roads-1",
      "group:公路网",
      "name:高速",
      "name:~高速",
      "origin:shared",
      "ref:workspace/cust-a",
      "ID:x",
      "Group ： 农村公路",
      "roads-1",
      "",
      "  name:  空格裁剪  ",
    ];
    for (const c of cases) {
      expect(modern.parseSelector(c)).toEqual(legacy.parseSelector(c));
    }
    expect(modern.parseSelector("Group ： 农村公路")).toEqual({ kind: "group", value: "农村公路" });
    expect(modern.parseSelector("roads-1")).toEqual({ kind: "id", value: "roads-1" });
  });

  it("isSharedLayerId：内置/声明/未命中/空入参", () => {
    expect(modern.isSharedLayerId("highways", RO_CONFIG)).toBe(true);
    expect(modern.isSharedLayerId("highways", null)).toBe(true); // 内置不依赖配置
    expect(modern.isSharedLayerId("declared-shared", RO_CONFIG)).toBe(true);
    expect(modern.isSharedLayerId("declared-shared", {})).toBe(false);
    expect(modern.isSharedLayerId("cust-a", RO_CONFIG)).toBe(false);
    expect(modern.isSharedLayerId("", RO_CONFIG)).toBe(false);
    for (const [id, cfg] of [["highways", null], ["declared-shared", RO_CONFIG], ["cust-a", RO_CONFIG]] as const) {
      expect(modern.isSharedLayerId(id, cfg)).toBe(legacy.isSharedLayerId(id, cfg));
    }
  });

  it("layerOriginOf：内置/声明 shared/origin 双值/未标注兜底", () => {
    const cfg = RO_CONFIG;
    const cases: [any, any][] = [
      [{ id: "highways" }, { workspace: WS, config: cfg }],
      [{ id: "declared-shared" }, { workspace: WS, config: cfg }],
      [{ id: "cust-x", origin: "shared" }, { workspace: WS, config: cfg }],
      [{ id: "cust-a", origin: "workspace", owner: "D:\\x" }, { workspace: WS, config: cfg }],
      [{ id: "cust-y" }, { workspace: WS, config: cfg }], // 未标注 → owner=workspace 兜底
      [{ id: "cust-z", origin: "  workspace  " }, { workspace: WS, config: cfg }], // trim 后命中
    ];
    for (const [layer, opts] of cases) {
      expect(modern.layerOriginOf(layer, opts)).toEqual(legacy.layerOriginOf(layer, opts));
    }
    expect(modern.layerOriginOf({ id: "highways" }, { workspace: WS, config: cfg })).toEqual({ origin: "shared", owner: "" });
    expect(modern.layerOriginOf({ id: "cust-y" }, { workspace: WS, config: cfg })).toEqual({ origin: "workspace", owner: WS });
  });

  it("layerRef：origin/id 投影", () => {
    expect(modern.layerRef({ id: "highways" })).toBe("shared/highways");
    expect(modern.layerRef({ id: "cust-a", origin: "workspace", owner: "x" })).toBe("workspace/cust-a");
    // 空图层：id="" 非共享、origin 未标注 → 未标注分支落 workspace
    expect(modern.layerRef({})).toBe("workspace/");
  });
});

describe("s3-layer-repository-parity listLayers / resolveLayer", () => {
  it("listLayers mine：共享 + 本人 + 未标注可见，他人排除；visible 以 style 为准", () => {
    const mineL = legacy.listLayers(PID_RO, { workspace: WS });
    const mineM = modern.listLayers(PID_RO, { workspace: WS });
    expect(normalize(mineM)).toEqual(normalize(mineL));
    expect(mineM.map((l: any) => l.id)).toEqual(["highways", "declared-shared", "cust-b", "cust-c"]);
    const custB = mineM.find((l: any) => l.id === "cust-b")!;
    expect(custB.visibleToMe).toBe(true); // 未标注 owner 空 → 对所有人可见
    expect(custB.editable).toBe(true);
    expect(custB.visible).toBe(false); // style.json visibility none 优先于 config
    const hw = mineM.find((l: any) => l.id === "highways")!;
    expect(hw.origin).toBe("shared");
    expect(hw.editable).toBe(false); // 共享需审批
    expect(hw.visible).toBe(true);
    // samePath 归一：小写 + 正斜杠 + 尾斜杠 同指本人
    const relaxed = modern.listLayers(PID_RO, { workspace: "d:/s3l10-ws/me/" });
    expect(relaxed.map((l: any) => l.id)).toEqual(mineM.map((l: any) => l.id));
  });

  it("listLayers all：全量（空 id 跳过）+ 他人图层标记", () => {
    const allM = modern.listLayers(PID_RO, { workspace: WS, scope: "all" });
    const allL = legacy.listLayers(PID_RO, { workspace: WS, scope: "all" });
    expect(normalize(allM)).toEqual(normalize(allL));
    expect(allM.map((l: any) => l.id)).toEqual(["highways", "declared-shared", "cust-a", "cust-b", "cust-c"]);
    expect(allM.find((l: any) => l.id === "cust-a")!.visibleToMe).toBe(false);
  });

  it("listLayers 项目不存在 → 空数组", () => {
    expect(modern.listLayers("__no_such__", { workspace: WS })).toEqual([]);
    expect(modern.listLayers("__no_such__", { workspace: WS })).toEqual(legacy.listLayers("__no_such__", { workspace: WS }));
  });

  it("resolveLayer：五选择器命中与无匹配文案逐字", () => {
    const ws = { workspace: WS };
    // 只在"当前工作区可见"范围内匹配：cust-a（他人）选择器无匹配
    for (const sel of ["id:cust-c", "id:CUST-C", "group:内置", "name:高速", "origin:shared", "ref:workspace/cust-c", "cust-c"]) {
      const rL = legacy.resolveLayer(PID_RO, sel, ws);
      const rM = modern.resolveLayer(PID_RO, sel, ws);
      expect(normalize(rM)).toEqual(normalize(rL));
      expect((rM as any).ok).toBe(true);
    }
    for (const sel of ["id:cust-a", "id:不存在"]) {
      const missL = legacy.resolveLayer(PID_RO, sel, ws);
      const missM = modern.resolveLayer(PID_RO, sel, ws);
      expect(normalize(missM)).toEqual(normalize(missL));
      expect((missM as any).ok).toBe(false);
    }
    const missM = modern.resolveLayer(PID_RO, "id:不存在", ws);
    expect((missM as any).error).toContain("没有匹配的图层：id:不存在");
    expect((missM as any).error).toContain("可用：");
  });
});

describe("s3-layer-repository-parity annotateProject / markLayerOwnership", () => {
  it("annotateProject 项目不存在 → null", () => {
    expect(modern.annotateProject("__no_such__", { workspace: WS })).toBeNull();
  });

  it("annotateProject 干跑（apply=false）不落盘且 sharedChanged 视图生效", () => {
    const pid = `${RUN_ID}-dry`;
    // fixture 继承 RO_CONFIG 的 sharedLayers（["declared-shared"]），干跑不得把 extra 写进去
    writeProject(pid, { ...RO_CONFIG, layers: [{ id: "cust-y", name: "未标注" }, { id: "extra", name: "公用" }] });
    try {
      const rL = legacy.annotateProject(pid, { workspace: WS, sharedIds: ["extra"], apply: false });
      const rM = modern.annotateProject(pid, { workspace: WS, sharedIds: ["extra"], apply: false });
      expect(normalize(rM)).toEqual(normalize(rL));
      expect(rM.project).toBe(pid);
      expect(rM.sharedChanged).toBe(true);
      expect(rM.applied).toBe(false);
      // 干跑不落盘：config 文件 sharedLayers 保持原值（不含 extra）、origin 标注不写回
      const cfg = JSON.parse(fs.readFileSync(path.join(MAPS_ROOT, pid, "map.config.json"), "utf8"));
      expect(cfg.sharedLayers).toEqual(["declared-shared"]);
      expect(cfg.layers[0]!.origin).toBeUndefined();
      // 干跑结果里 extra 以"新增的共享声明"计入 → origin=shared
      expect(rM.changed.find((c: any) => c.id === "extra")!.to).toBe("shared");
    } finally {
      fs.rmSync(path.join(MAPS_ROOT, pid), { recursive: true, force: true });
    }
  });

  it("annotateProject 落盘：双侧同构项目快照互等（origin/owner 写回 + sharedLayers 持久化）", () => {
    const mkConfig = () => ({
      name: "归属落盘",
      layers: [
        { id: "highways", name: "高速公路" },
        { id: "cust-p", name: "自有图层" },
        { id: "extra", name: "公用底图" },
      ],
    });
    writeProject(PID_L, mkConfig());
    writeProject(PID_M, mkConfig());
    const rL = legacy.annotateProject(PID_L, { workspace: WS, sharedIds: ["extra"] });
    const rM = modern.annotateProject(PID_M, { workspace: WS, sharedIds: ["extra"] });
    expect(normalize({ ...rL, project: "__PID__" })).toEqual(normalize({ ...rM, project: "__PID__" }));
    const snapL = snapshot(PID_L);
    const snapM = snapshot(PID_M);
    expect(snapM).toEqual(snapL);
    expect(snapM.sharedLayers).toEqual(["extra"]);
    const cust = snapM.layers.find((l: any) => l.id === "cust-p")!;
    expect(cust.origin).toBe("workspace");
    expect(cust.owner).toBe(WS);
    const hw = snapM.layers.find((l: any) => l.id === "highways")!;
    expect(hw.origin).toBe("shared");
    expect(hw.owner).toBeUndefined(); // shared 不带 owner（delete 语义）
    // 幂等：再次调用 changed 为空不重复写
    const againM = modern.annotateProject(PID_M, { workspace: WS, sharedIds: ["extra"] });
    const againL = legacy.annotateProject(PID_L, { workspace: WS, sharedIds: ["extra"] });
    expect(againM.changed).toEqual(againL.changed);
    expect(againM.changed).toEqual([]);
  });

  it("markLayerOwnership：共享 id 保护 / 落盘归属 / name 改名 / 项目不存在", () => {
    expect(modern.markLayerOwnership(PID_RO, "highways", { workspace: WS })).toBe(false);
    expect(modern.markLayerOwnership(PID_RO, "declared-shared", { workspace: WS })).toBe(false);
    expect(modern.markLayerOwnership("__no_such__", "cust-x", { workspace: WS })).toBe(false);

    const mkConfig = () => ({ name: "归属标注", layers: [{ id: "imported", name: "旧名" }] });
    writeProject(PID_AL, mkConfig());
    writeProject(PID_AM, mkConfig());
    const okL = legacy.markLayerOwnership(PID_AL, "imported", { workspace: WS, name: "导入图层" });
    const okM = modern.markLayerOwnership(PID_AM, "imported", { workspace: WS, name: "导入图层" });
    expect(okM).toBe(true);
    expect(okM).toBe(okL);
    expect(snapshot(PID_AM)).toEqual(snapshot(PID_AL));
    const cfg = JSON.parse(fs.readFileSync(path.join(MAPS_ROOT, PID_AM, "map.config.json"), "utf8"));
    expect(cfg.layers[0]).toEqual({ id: "imported", name: "导入图层", origin: "workspace", owner: WS });
    // 共享声明后导入同 id → 不改归属
    modern.markLayerOwnership(PID_AM, "nope-id", { workspace: WS });
    expect(okM).toBe(true);
  });
});
