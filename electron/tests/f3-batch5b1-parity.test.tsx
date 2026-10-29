// @vitest-environment jsdom
/**
 * F3 批5b-1：session-list 纯函数锚点测试。
 *
 * R6-6c 对拍退役改写：旧侧 client/src/components/SessionSidebar.jsx 的 SessionList
 * 双侧 DOM 对拍随 client 退役删除（等价性已在 F3 批对拍验收冻结）；本文件保留
 * lib/session-list.ts 的纯函数锚点断言（该 lib 的新侧唯一覆盖，不可删）。
 *
 * 时间稳定化：测试数据 modified 取 now-30s（"刚刚"）、now-25h（"1天前"+昨天组）、
 * now-3d（"3天前"+更早组）。
 */
import { describe, it, expect, afterEach } from "vitest";
import * as sessionListLib from "../src/renderer/lib/session-list";

const PIN_KEY = "oaw_pinned_sessions";

const NOW = Date.now();
const T_JUST = new Date(NOW - 30 * 1000).toISOString();
const T_YDAY = new Date(NOW - 25 * 3600 * 1000).toISOString();
const T_OLD = new Date(NOW - 3 * 24 * 3600 * 1000).toISOString();

afterEach(() => {
  localStorage.clear();
});

describe("session-list 纯函数锚点（绝对断言）", () => {
  it("RUNNING_SESSION_STATUSES：五个运行态", () => {
    expect([...sessionListLib.RUNNING_SESSION_STATUSES]).toEqual(["running", "queued", "waiting_user", "recovering", "cancel_requested"]);
  });

  it("sameWorkspacePath/samePath：分隔符/大小写/尾斜杠/空值归一化", () => {
    const { sameWorkspacePath, samePath } = sessionListLib;
    expect(sameWorkspacePath("F:\\work\\docs", "f:/work/docs")).toBe(true);
    expect(sameWorkspacePath("F:\\work\\docs\\", "F:/work/docs")).toBe(true);
    expect(sameWorkspacePath("F:\\work\\docs", "F:\\work\\other")).toBe(false);
    expect(sameWorkspacePath("", "F:\\work")).toBe(false);
    expect(sameWorkspacePath(undefined, null)).toBe(false);
    // 盘符冒号参与比较：c:/a/b ≠ c/a/b（与原始 JS 归一化一致）
    expect(samePath("C:\\A\\B", "c:/a/b")).toBe(true);
    expect(samePath("C:\\A\\B", "c/a/b")).toBe(false);
  });

  it("formatTime 档位锚点", () => {
    const { formatTime } = sessionListLib;
    expect(formatTime("")).toBe("");
    expect(formatTime(new Date(NOW - 30 * 1000).toISOString())).toBe("刚刚");
    expect(formatTime(new Date(NOW - 5 * 60 * 1000).toISOString())).toBe("5分钟前");
    expect(formatTime(new Date(NOW - 3 * 3600 * 1000).toISOString())).toBe("3小时前");
    expect(formatTime(new Date(NOW - 5 * 24 * 3600 * 1000).toISOString())).toBe("5天前");
  });

  it("formatRelTime：毫秒时间戳转发；空值空串", () => {
    const { formatRelTime } = sessionListLib;
    expect(formatRelTime(0)).toBe("");
    expect(formatRelTime(undefined)).toBe("");
    expect(formatRelTime(NOW - 30 * 1000)).toBe("刚刚");
  });

  it("shortenCwd：≤2 段原样；>2 段省略前缀", () => {
    const { shortenCwd } = sessionListLib;
    expect(shortenCwd("")).toBe("");
    expect(shortenCwd("C:\\a")).toBe("C:\\a");
    // 3 段即缩略（C: 也算一段，与原始 JS 一致）
    expect(shortenCwd("C:\\a\\b")).toBe("…/a/b");
    expect(shortenCwd("F:\\work\\docs\\plan")).toBe("…/docs/plan");
    expect(shortenCwd("/home/user/proj/x")).toBe("…/proj/x");
  });

  it("formatSize：B/KB/MB 档位；空值空串", () => {
    const { formatSize } = sessionListLib;
    expect(formatSize(undefined)).toBe("");
    expect(formatSize(null)).toBe("");
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("groupByDate：今天/昨天/更早分组顺序 + 空组剔除", () => {
    const { groupByDate } = sessionListLib;
    const sessions = [
      { id: "a", modified: T_JUST },
      { id: "b", modified: T_OLD },
      { id: "c", modified: T_YDAY },
      { id: "d", modified: T_JUST },
    ];
    const groups = groupByDate(sessions);
    expect(groups.map(([label]) => label)).toEqual(["今天", "昨天", "更早"]);
    expect(groups[0]?.[1].map((s) => s.id)).toEqual(["a", "d"]);
    expect(groups[1]?.[1].map((s) => s.id)).toEqual(["c"]);
    expect(groups[2]?.[1].map((s) => s.id)).toEqual(["b"]);
    // 空组剔除：只有今天
    expect(groupByDate([{ id: "x", modified: T_JUST }]).map(([label]) => label)).toEqual(["今天"]);
  });

  it("getPinnedSet/togglePin：localStorage 落盘序列", () => {
    const { getPinnedSet, togglePin, PIN_KEY: KEY } = sessionListLib;
    expect(KEY).toBe(PIN_KEY);
    expect(getPinnedSet()).toEqual(new Set());
    expect(togglePin("a")).toEqual(new Set(["a"]));
    expect(togglePin("b")).toEqual(new Set(["a", "b"]));
    expect(togglePin("a")).toEqual(new Set(["b"]));
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual(["b"]);
    // 损坏 JSON 回退空集
    localStorage.setItem(KEY, "{oops");
    expect(getPinnedSet()).toEqual(new Set());
  });
});
