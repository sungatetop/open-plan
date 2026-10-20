import { describe, it, expect, beforeEach, vi } from "vitest";

// 内存 localStorage stub：两侧共用同一实例，行为才可比；先于动态 import 安装。
// setItem 按 Web 存储规范做 String(v) 强转（如 undefined → "undefined"）。
const store = new Map<string, string>();
const storageStub = {
  getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string): void => { store.set(String(k), String(v)); },
  removeItem: (k: string): void => { store.delete(k); },
};
vi.stubGlobal("localStorage", storageStub);

const desktop = await import("../src/renderer/lib/persist-ui");
const serverModule = await import("../../client/src/persist-ui.js");
const server = serverModule as unknown as typeof desktop;

beforeEach(() => { store.clear(); });

describe("persist-ui TS 版与 client 版等价（对拍）", () => {
  it("空库 loadUIState → null（两侧一致）", () => {
    expect(desktop.loadUIState()).toBeNull();
    expect(server.loadUIState()).toBeNull();
  });

  it("save → load 往返一致", () => {
    const state = { tabs: ["a", "b"], active: "a", entry: "kb", nested: { x: 1 } };
    desktop.saveUIState(state);
    server.saveUIState(state);
    expect(desktop.loadUIState()).toEqual(state);
    expect(desktop.loadUIState()).toEqual(server.loadUIState());
  });

  it("非对象/空值载荷与损坏 JSON 均返回 null", () => {
    // undefined → JSON.stringify = undefined → 存 "undefined" → parse 抛错 → null
    desktop.saveUIState(undefined); server.saveUIState(undefined);
    expect(desktop.loadUIState()).toBeNull();
    expect(desktop.loadUIState()).toEqual(server.loadUIState());
    // null → "null" → s=null → null
    desktop.saveUIState(null); server.saveUIState(null);
    expect(desktop.loadUIState()).toBeNull();
    expect(desktop.loadUIState()).toEqual(server.loadUIState());
    // 数字/字符串/布尔 → typeof 非 object → null
    for (const raw of ["5", '"str"', "true"]) {
      storageStub.setItem("oaw_ui_state_v1", raw);
      expect(desktop.loadUIState()).toBeNull();
      expect(desktop.loadUIState()).toEqual(server.loadUIState());
    }
    // 数组是 object → 原样返回
    storageStub.setItem("oaw_ui_state_v1", "[1,2,3]");
    expect(desktop.loadUIState()).toEqual([1, 2, 3]);
    expect(desktop.loadUIState()).toEqual(server.loadUIState());
    // 损坏 JSON → catch → null
    storageStub.setItem("oaw_ui_state_v1", "{oops");
    expect(desktop.loadUIState()).toBeNull();
    expect(desktop.loadUIState()).toEqual(server.loadUIState());
  });

  it("clearUIState 移除后 load → null", () => {
    desktop.saveUIState({ a: 1 });
    expect(desktop.loadUIState()).toEqual({ a: 1 });
    desktop.clearUIState(); server.clearUIState();
    expect(desktop.loadUIState()).toBeNull();
    expect(desktop.loadUIState()).toEqual(server.loadUIState());
  });

  it("localStorage 抛错时静默降级（save/clear 不抛、load 返回 null）", () => {
    const boom = () => { throw new Error("quota"); };
    const origGet = storageStub.getItem, origSet = storageStub.setItem, origRemove = storageStub.removeItem;
    storageStub.setItem = boom;
    expect(() => { desktop.saveUIState({ a: 1 }); server.saveUIState({ a: 1 }); }).not.toThrow();
    storageStub.removeItem = boom;
    expect(() => { desktop.clearUIState(); server.clearUIState(); }).not.toThrow();
    storageStub.getItem = boom;
    expect(desktop.loadUIState()).toBeNull();
    expect(server.loadUIState()).toBeNull();
    storageStub.getItem = origGet; storageStub.setItem = origSet; storageStub.removeItem = origRemove;
  });
});
