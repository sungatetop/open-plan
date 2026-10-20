// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MARQUEE_STYLES, MARQUEE_COLORS, MARQUEE_SPEEDS, MOTION_LEVELS,
  ACTIVITY_DISPLAY_OPTIONS, ANSWER_DETAIL_OPTIONS, PREVIEW_AUTO_OPEN_OPTIONS,
  APPEARANCE_DEFAULTS, LEGACY_EXECUTION_FLOW_HIDDEN_KEY,
  migrateLegacyAppearance, loadAppearance, saveAppearance, applyAppearance,
  prefersReducedMotion, isMotionReduced, motionScrollBehavior,
  subscribeAppearance, normalizeAppearance,
  type AppearanceInput,
} from "../src/renderer/lib/ui-appearance";

const clientModule = await import("../../client/src/ui-appearance.js");
const client = clientModule as any;

const SETTINGS_KEY = "oaw_settings";

const DATASET_KEYS = [
  "marqueeStyle", "marqueeColor", "marqueeSpeed", "activityMarquee", "motionLevel", "reduceMotion",
] as const;

function resetBrowserState(): void {
  localStorage.clear();
  const root = document.documentElement;
  for (const key of DATASET_KEYS) delete root.dataset[key];
}

beforeEach(() => {
  resetBrowserState();
});

afterEach(() => {
  delete (window as any).matchMedia;
});

function setMatchMedia(matches: boolean): void {
  (window as any).matchMedia = vi.fn(() => ({ matches, addEventListener() {}, removeEventListener() {} }));
}

describe("ui-appearance TS 版与 client 版等价（对拍）", () => {
  it("常量表：七张选项表 + 默认值逐字段一致", () => {
    expect(MARQUEE_STYLES).toEqual(client.MARQUEE_STYLES);
    expect(MARQUEE_COLORS).toEqual(client.MARQUEE_COLORS);
    expect(MARQUEE_SPEEDS).toEqual(client.MARQUEE_SPEEDS);
    expect(MOTION_LEVELS).toEqual(client.MOTION_LEVELS);
    expect(ACTIVITY_DISPLAY_OPTIONS).toEqual(client.ACTIVITY_DISPLAY_OPTIONS);
    expect(ANSWER_DETAIL_OPTIONS).toEqual(client.ANSWER_DETAIL_OPTIONS);
    expect(PREVIEW_AUTO_OPEN_OPTIONS).toEqual(client.PREVIEW_AUTO_OPEN_OPTIONS);
    expect(APPEARANCE_DEFAULTS).toEqual(client.APPEARANCE_DEFAULTS);
    expect(LEGACY_EXECUTION_FLOW_HIDDEN_KEY).toBe(client.LEGACY_EXECUTION_FLOW_HIDDEN_KEY);
    // 绝对锚点：样式/速度/动效档位数量与 id 序列
    expect(MARQUEE_STYLES.map((i) => i.id)).toEqual(["shine", "neon", "rainbow", "terminal", "stripe", "static"]);
    expect(MARQUEE_SPEEDS.map((i) => [i.id, i.duration])).toEqual([["slow", 1.6], ["normal", 1], ["fast", 0.6]]);
  });

  it("normalizeAppearance：空入参兜默认；合法值透传；非法值回落；activityMarqueeEnabled 仅 false 为关", () => {
    expect(normalizeAppearance()).toEqual(client.normalizeAppearance());
    const good = {
      marqueeStyle: "neon", marqueeColor: "violet", marqueeSpeed: "fast",
      activityMarqueeEnabled: false, motionLevel: "calm", activityDisplay: "expanded",
      answerDetail: "detailed", previewAutoOpen: "never",
    } as AppearanceInput;
    expect(normalizeAppearance(good)).toEqual(client.normalizeAppearance(good));
    const ugly = {
      marqueeStyle: "bogus", marqueeColor: 42, marqueeSpeed: null,
      motionLevel: "OFF", activityDisplay: {}, answerDetail: true, previewAutoOpen: "sometimes",
    } as unknown as AppearanceInput;
    expect(normalizeAppearance(ugly)).toEqual(client.normalizeAppearance(ugly));
    // activityMarqueeEnabled !== false 的宽松真值：0 / undefined / "false" 都算开启
    expect(normalizeAppearance({ activityMarqueeEnabled: 0 as unknown as false }).activityMarqueeEnabled).toBe(true);
    expect(normalizeAppearance({ activityMarqueeEnabled: false }).activityMarqueeEnabled).toBe(false);
    expect(client.normalizeAppearance({ activityMarqueeEnabled: 0 }).activityMarqueeEnabled).toBe(true);
  });

  it("migrateLegacyAppearance：首次迁移写入版本；旧开关 true → hidden；已迁移不再动", () => {
    // 旧开关为 true → hidden，返回 true（发生了迁移）
    localStorage.setItem(LEGACY_EXECUTION_FLOW_HIDDEN_KEY, "true");
    expect(migrateLegacyAppearance()).toBe(true);
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY)!);
    expect(raw).toMatchObject({ activityDisplay: "hidden", settingsVersion: 2 });
    // 第二次：版本已到 → false
    expect(migrateLegacyAppearance()).toBe(false);

    // client 侧同流程对照（先清空各自状态）
    resetBrowserState();
    localStorage.setItem(client.LEGACY_EXECUTION_FLOW_HIDDEN_KEY, "true");
    expect(client.migrateLegacyAppearance()).toBe(true);
    const rawClient = JSON.parse(localStorage.getItem(SETTINGS_KEY)!);
    expect(rawClient).toEqual(raw);

    // 无旧开关 → 回落 compact
    resetBrowserState();
    expect(migrateLegacyAppearance()).toBe(true);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).activityDisplay).toBe("compact");
    resetBrowserState();
    expect(client.migrateLegacyAppearance()).toBe(true);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).activityDisplay).toBe("compact");
  });

  it("saveAppearance → loadAppearance：合法 patch 全部落盘；非法 id 被拒；空调用也写版本并广播", () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeAppearance((a) => seen.push(a));

    saveAppearance({
      marqueeStyle: "stripe", marqueeColor: "emerald", marqueeSpeed: "slow",
      activityMarqueeEnabled: false, motionLevel: "off", activityDisplay: "expanded",
      answerDetail: "brief", previewAutoOpen: "deliverable",
    });
    expect(loadAppearance()).toEqual({
      marqueeStyle: "stripe", marqueeColor: "emerald", marqueeSpeed: "slow",
      activityMarqueeEnabled: false, motionLevel: "off", activityDisplay: "expanded",
      answerDetail: "brief", previewAutoOpen: "deliverable",
    });
    const afterFirstSave = loadAppearance();

    // 非法 patch：字段被拒（不覆盖当前值），其余照常
    saveAppearance({ marqueeStyle: "bogus", motionLevel: "calm" } as unknown as AppearanceInput);
    const after = loadAppearance();
    expect(after.marqueeStyle).toBe("stripe");
    expect(after.motionLevel).toBe("calm");

    // 广播次数与内容两侧一致
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(afterFirstSave);
    unsubscribe();
    saveAppearance({ marqueeSpeed: "fast" });
    expect(seen).toHaveLength(2);
    // 两侧共享 jsdom 存储：client 版 load 读到的值与 TS 版完全一致
    expect(client.loadAppearance()).toEqual(loadAppearance());
  });

  it("applyAppearance：六个 data-* 全部挂到 <html>；reduceMotion 随系统偏好", () => {
    resetBrowserState();
    applyAppearance(loadAppearance());
    const root = document.documentElement;
    expect(root.dataset.marqueeStyle).toBe("shine");
    expect(root.dataset.marqueeColor).toBe("accent");
    expect(root.dataset.marqueeSpeed).toBe("normal");
    expect(root.dataset.activityMarquee).toBe("true");
    expect(root.dataset.motionLevel).toBe("full");
    expect(root.dataset.reduceMotion).toBe("");

    setMatchMedia(true);
    applyAppearance(loadAppearance());
    expect(root.dataset.reduceMotion).toBe("1");
    applyAppearance({ ...loadAppearance(), activityMarqueeEnabled: false });
    expect(root.dataset.activityMarquee).toBe("false");
  });

  it("prefersReducedMotion：matchMedia 命中/未命中/缺失三态", () => {
    setMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    setMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
    delete (window as any).matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });

  it("动效闸门：系统偏好优先，产品 off 叠加；滚动行为随之落定", () => {
    // 系统未要求 + full → 平滑滚动
    expect(motionScrollBehavior()).toBe("smooth");
    // 系统 reduce → 立即落定（motionLevel 仍是 full）
    setMatchMedia(true);
    expect(isMotionReduced()).toBe(true);
    expect(motionScrollBehavior()).toBe("auto");
    // 系统未要求 + 产品 off → 仍落定
    setMatchMedia(false);
    saveAppearance({ motionLevel: "off" });
    expect(isMotionReduced()).toBe(true);
    expect(motionScrollBehavior()).toBe("auto");
    // 产品 calm + 系统未要求 → 不落定
    saveAppearance({ motionLevel: "calm" });
    expect(isMotionReduced()).toBe(false);
    expect(motionScrollBehavior()).toBe("smooth");
  });
});
