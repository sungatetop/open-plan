import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { motionScrollBehavior } from "../lib/ui-appearance";
import Icon from "./Icon";
import { 提取消息展示文本 } from "../lib/StreamingTextQueue";

/**
 * 会话消息目录栏（ZCode 风格细横杠时间线 + 悬停弹层）
 * - 右侧一条竖直的"刻度条"：每条用户消息一根短横杠（按消息在对话流中的位置比例分布）
 * - 悬停/点击刻度 → 弹层列出该位置前后约 10 条消息（角色 + 摘要 + 时间 + 合并数）
 *   当前阅读项高亮；点条目跳转；↑/↓ 移动高亮、Enter 跳转、Esc 关闭；底部「顶部 / 底部」快捷跳转
 * - 当前滚动位置所在的刻度高亮
 *
 * 与 client/src/components/ChatTimeline.jsx 逐行等价（tests/f3-batch3-parity.test.tsx 对拍强制）。
 */
const WINDOW_BEFORE = 5;
const WINDOW_AFTER = 4;

interface TimelineMessage {
  role?: unknown;
  createdAt?: unknown;
  status?: unknown;
  images?: unknown;
  attachments?: unknown;
  [key: string]: unknown;
}

function 消息时间(value: unknown): string {
  const ms = Number(value);
  if (!ms) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function 摘要文本(message: TimelineMessage): string {
  const text = String(提取消息展示文本(message) || "").replace(/\s+/g, " ").trim();
  if (text) return text;
  if (Array.isArray(message?.images) && message.images.length) return "（图片）";
  if (Array.isArray(message?.attachments) && message.attachments.length) return "（附件）";
  return "（空消息）";
}

interface TimelineEntry {
  idx: number;
  role: string;
  summary: string;
  time: unknown;
  error: boolean;
  count: number;
}

interface TimelineBead {
  idx: number;
  summary: string;
  error: boolean;
  count: number;
  top: number;
}

export interface ChatTimelineProps {
  messages?: TimelineMessage[] | null;
  containerRef: React.RefObject<HTMLElement | null>;
}

export default function ChatTimeline({ messages, containerRef }: ChatTimelineProps): React.ReactElement | null {
  const railRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);   // 悬停的刻度（未固定时决定弹层锚点）
  const [pinned, setPinned] = useState(false);      // 点击刻度后固定弹层（窄屏 / 键盘用）
  const [cursorIdx, setCursorIdx] = useState<number | null>(null); // 弹层里高亮的消息下标
  const [activeIdx, setActiveIdx] = useState<number | null>(null); // 当前阅读位置（跟随滚动）
  const [popupTop, setPopupTop] = useState<number | null>(null);   // 弹层垂直位置（px，夹在轨道内）

  // 历史消息是渐进挂载的：目标消息可能还没进 DOM。这时退到最近的一条已挂载消息，
  // 保证"点了有反应"，而不是静默什么都不做。
  const scrollToMsg = useCallback((idx: number): boolean => {
    const root = containerRef.current;
    if (!root) return false;
    let el = root.querySelector(`[data-msg-index="${idx}"]`);
    if (!el) {
      const nodes = [...root.querySelectorAll("[data-msg-index]")];
      let best: Element | null = null;
      for (const node of nodes) {
        const value = Number(node.getAttribute("data-msg-index"));
        if (!Number.isFinite(value)) continue;
        if (value <= idx) best = node;
        else if (!best) { best = node; break; }
      }
      el = best;
    }
    if (el) el.scrollIntoView({ behavior: motionScrollBehavior(), block: "start" });
    return Boolean(el);
  }, [containerRef]);

  // 滚动跟随：把视口上沿附近的那条消息记为"当前刻度"。用 rAF 合帧，滚动本身不做别的活。
  useEffect(() => {
    const root = containerRef?.current;
    if (!root) return undefined;
    let raf = 0;
    const update = () => {
      raf = 0;
      const nodes = root.querySelectorAll("[data-msg-index]");
      if (!nodes.length) return;
      const threshold = root.getBoundingClientRect().top + Math.min(120, root.clientHeight * 0.25);
      let current: number | null = null;
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= threshold) current = Number(node.getAttribute("data-msg-index"));
        else break;
      }
      setActiveIdx(current);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    root.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [containerRef, messages]);

  // 目录条目：用户 + 助手消息都进列表（角色徽标区分）；相邻重复的用户消息合并成一条。
  const entries = useMemo<TimelineEntry[]>(() => {
    const list: TimelineEntry[] = [];
    for (let i = 0; i < (messages || []).length; i += 1) {
      const message = (messages || [])[i];
      if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
      const summary = 摘要文本(message);
      const previous = list[list.length - 1];
      if (previous && previous.role === message.role && previous.summary === summary) {
        previous.count += 1;
        previous.idx = i;
        previous.time = message.createdAt || previous.time;
        previous.error ||= message.status === "error";
        continue;
      }
      list.push({
        idx: i,
        role: message.role as string,
        summary,
        time: message.createdAt || null,
        error: message.status === "error",
        count: 1,
      });
    }
    return list;
  }, [messages]);

  // 刻度：只取用户消息（相邻重复只留一个定位点），按比例分布。
  const beads = useMemo<TimelineBead[]>(() => {
    const raw = entries
      .filter((entry) => entry.role === "user")
      .map((entry) => ({
        idx: entry.idx,
        summary: entry.summary.slice(0, 40),
        error: entry.error,
        count: entry.count,
        top: ((entry.idx + 0.5) / Math.max(1, (messages || []).length)) * 100,
      }));
    const stride = Math.max(1, Math.ceil(raw.length / 24));
    return raw.filter((_, i) => i % stride === 0 || i === raw.length - 1);
  }, [entries, messages]);

  // 高亮"当前刻度"：取不超过滚动位置的那条；没有则落到第一条。
  const activeKey = (() => {
    if (activeIdx == null) return beads.length ? beads[beads.length - 1]!.idx : null;
    let current: number | null = beads.length ? beads[0]!.idx : null;
    for (const bead of beads) {
      if (bead.idx <= activeIdx) current = bead.idx;
      else break;
    }
    return current;
  })();

  // 弹层锚点：优先悬停刻度，其次固定时用的刻度，最后落到当前阅读位置。
  const anchorBead = useMemo<TimelineBead | null>(() => {
    const targetIdx = hoverIdx ?? (pinned ? cursorIdx : null) ?? activeKey;
    if (targetIdx == null) return beads.length ? beads[beads.length - 1]! : null;
    let found: TimelineBead | null = beads.length ? beads[0]! : null;
    for (const bead of beads) {
      if (bead.idx <= targetIdx) found = bead;
      else break;
    }
    return found || (beads.length ? beads[beads.length - 1]! : null);
  }, [hoverIdx, pinned, cursorIdx, activeKey, beads]);

  const anchorEntryIndex = useMemo(() => {
    if (!anchorBead) return 0;
    const at = entries.findIndex((entry) => entry.idx >= anchorBead.idx && entry.role === "user");
    return at >= 0 ? at : Math.max(0, entries.length - 1);
  }, [anchorBead, entries]);

  const open = hoverIdx != null || pinned;

  // 打开弹层时把高亮放到锚点条目上；随后用键盘/点击移动。
  useEffect(() => {
    if (open) setCursorIdx(entries[anchorEntryIndex]?.idx ?? null);
  }, [open, anchorEntryIndex, entries]);

  const windowEntries = useMemo<(TimelineEntry & { position: number })[]>(() => {
    if (!entries.length) return [];
    const anchor = entries.findIndex((entry) => entry.idx === cursorIdx);
    const center = anchor >= 0 ? anchor : anchorEntryIndex;
    const start = Math.max(0, Math.min(center - WINDOW_BEFORE, Math.max(0, entries.length - (WINDOW_BEFORE + WINDOW_AFTER + 1))));
    return entries.slice(start, start + WINDOW_BEFORE + WINDOW_AFTER + 1).map((entry, offset) => ({ ...entry, position: start + offset }));
  }, [entries, cursorIdx, anchorEntryIndex]);

  const closePopup = useCallback(() => {
    setHoverIdx(null);
    setPinned(false);
    setCursorIdx(null);
    setPopupTop(null);
  }, []);

  const scheduleClose = useCallback(() => {
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      if (!pinned) { setHoverIdx(null); setCursorIdx(null); setPopupTop(null); }
    }, 220);
  }, [pinned]);

  const cancelClose = useCallback(() => {
    window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => () => window.clearTimeout(closeTimerRef.current), []);

  // 键盘：↑/↓ 移动高亮、Enter 跳转、Esc 关闭、Home/End 顶部底部。
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closePopup(); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const current = entries.findIndex((entry) => entry.idx === cursorIdx);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = Math.min(entries.length - 1, Math.max(0, (current >= 0 ? current : anchorEntryIndex) + step));
        setCursorIdx(entries[next]?.idx ?? null);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const entry = entries.find((item) => item.idx === cursorIdx) || entries[anchorEntryIndex];
        if (entry) { scrollToMsg(entry.idx); closePopup(); }
        return;
      }
      if (event.key === "Home") { event.preventDefault(); setCursorIdx(entries[0]?.idx ?? null); return; }
      if (event.key === "End") { event.preventDefault(); setCursorIdx(entries[entries.length - 1]?.idx ?? null); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, entries, cursorIdx, anchorEntryIndex, scrollToMsg, closePopup]);

  // 弹层垂直位置：跟随锚点刻度，但夹在轨道范围内，避免贴边被裁掉。
  useLayoutEffect(() => {
    if (!open) return;
    const rail = railRef.current;
    const popup = popupRef.current;
    if (!rail || !popup || !anchorBead) return;
    const railHeight = rail.clientHeight;
    const popupHeight = popup.offsetHeight;
    if (!railHeight || !popupHeight) return;
    const anchorPx = (anchorBead.top / 100) * railHeight;
    const half = popupHeight / 2;
    const clamped = Math.min(Math.max(anchorPx, half + 6), Math.max(half + 6, railHeight - half - 6));
    setPopupTop(clamped);
  }, [open, anchorBead, windowEntries.length]);

  if (!messages || messages.length === 0 || !beads.length) return null;

  const cursorEntry = entries.find((entry) => entry.idx === cursorIdx) || null;
  const cursorPosition = windowEntries.find((entry) => entry.idx === cursorIdx)?.position ?? 0;

  return (
    <div className="chat-timeline beads" aria-label="对话定位" ref={railRef}>
      {beads.map((b) => (
        <div
          key={b.idx}
          className={`timeline-bead${b.idx === activeKey ? " active" : ""}${b.error ? " error" : ""}${open && anchorBead?.idx === b.idx ? " anchored" : ""}`}
          style={{ top: `${b.top}%` }}
          onMouseEnter={() => { cancelClose(); setHoverIdx(b.idx); setPinned(false); }}
          onMouseLeave={scheduleClose}
          onClick={(event) => {
            event.stopPropagation();
            // 单击定位到该消息；同时固定弹层（窄屏/触屏没有 hover，用点击打开）
            scrollToMsg(b.idx);
            setPinned(true);
            setHoverIdx(b.idx);
          }}
          title={`${b.summary}${b.count > 1 ? `（合并 ${b.count} 条重复消息）` : ""}`}
        >
          <span className="bead-dot" />
        </div>
      ))}
      {open && windowEntries.length > 0 && (
        <div
          className="timeline-popup"
          ref={popupRef}
          style={popupTop != null ? { top: `${popupTop}px` } : { top: `${anchorBead?.top || 50}%`, transform: "translateY(-50%)" }}
          role="listbox"
          aria-label="会话导航"
          aria-activedescendant={cursorEntry ? `timeline-entry-${cursorEntry.idx}` : undefined}
          tabIndex={-1}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="timeline-popup-head">
            <span>会话导航</span>
            <span className="timeline-popup-count">{entries.length} 条 · 第 {(cursorPosition ?? 0) + 1} 条</span>
            <button type="button" className="timeline-popup-close" onClick={closePopup} aria-label="关闭会话导航"><Icon name="close" size={12} /></button>
          </div>
          <div className="timeline-popup-list">
            {windowEntries.map((entry) => (
              <button
                type="button"
                key={`${entry.idx}-${entry.position}`}
                id={`timeline-entry-${entry.idx}`}
                role="option"
                aria-selected={entry.idx === cursorIdx}
                className={`timeline-popup-item${entry.idx === cursorIdx ? " cursor" : ""}${entry.idx === activeIdx ? " current" : ""}${entry.error ? " error" : ""}`}
                onMouseEnter={() => setCursorIdx(entry.idx)}
                onClick={() => { scrollToMsg(entry.idx); closePopup(); }}
              >
                <span className={`timeline-popup-role ${entry.role}`}>{entry.role === "user" ? "我" : "助手"}</span>
                <span className="timeline-popup-body">
                  <span className="timeline-popup-text">{entry.summary}</span>
                  <span className="timeline-popup-meta">
                    {消息时间(entry.time) || "—"}
                    {entry.count > 1 ? ` · ${entry.count} 条合并` : ""}
                    {entry.idx === activeIdx ? " · 当前阅读" : ""}
                    {entry.error ? " · 出错" : ""}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="timeline-popup-foot">
            <button type="button" onClick={() => { const first = entries[0]; if (first) { scrollToMsg(first.idx); closePopup(); } }}>↑ 顶部</button>
            <button type="button" onClick={() => { const last = entries[entries.length - 1]; if (last) { scrollToMsg(last.idx); closePopup(); } }}>↓ 底部</button>
            <span className="timeline-popup-hint">↑↓ 选择 · Enter 跳转 · Esc 关闭</span>
          </div>
        </div>
      )}
    </div>
  );
}
