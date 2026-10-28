import React, { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon";
import { listFiles, listSessions, mapProjects, tplList, kbSearch } from "../api/client-api";

/**
 * 统一命令面板（F6-2：client/src/components/CommandPalette.jsx 逐行等价转录，Ctrl/Cmd+K）。
 *
 * 数据源（旧 fetch → IPC 通道，成功取字段 / 失败置空，行为面逐项对齐）：
 *   - 文件：listFiles()（op:files:list）→ {files:[{name,ext,isDir}]}，非 isDir 前 30；
 *   - 知识库：kbSearch(q)（op:kb/search，防抖 300ms；limit 缺省 30 与服务端默认一致）→ {results}；
 *   - 模板：tplList()（op:templates:list）→ items 前 30；
 *   - 地图：mapProjects()（op:map:projects:list）→ projects 前 10；
 *   - 会话：listSessions()（op:sessions:list）→ sessions 前 10。
 *
 * 交互面：Esc 关闭 / ↑↓ 循环选择 / Enter 执行并关闭 / 点击遮罩关闭 / 选中项滚进可视区 /
 * 打开前记录焦点控件、关闭后归还（键盘用户不丢位置）；回调由 workbench 接线
 * （onKb/onTpl/onMap 打开对应模块、onSession 切会话、onOpenFile 开文档）。
 */

// 入口图形统一走 Icon 组件的线性 SVG，不再用受系统字体影响的 emoji。
const ICONS = {
  file: "file",
  kb: "book",
  template: "layers",
  map: "map",
  session: "comment"
} as const;

interface CommandItem {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  action: () => void;
}

interface CommandGroup {
  id: string;
  title: string;
  items: CommandItem[];
}

interface FileRow { name?: unknown; ext?: unknown; isDir?: unknown }
interface TemplateRow { id?: unknown; title?: unknown; name?: unknown; relPath?: unknown; category?: unknown; ext?: unknown }
interface MapRow { name?: unknown; project?: unknown }
interface SessionRow { id?: unknown; title?: unknown; label?: unknown; modified?: unknown }
interface KbRow { relPath?: unknown; title?: unknown; snippet?: unknown; tags?: unknown }

function matches(item: { title?: string; subtitle?: string }, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    (item.title || "").toLowerCase().includes(needle) ||
    (item.subtitle || "").toLowerCase().includes(needle)
  );
}

export interface CommandPaletteProps {
  open: boolean;
  onClose?: () => void;
  onOpenFile?: (name: unknown) => void;
  onKb?: () => void;
  onTpl?: () => void;
  onMap?: () => void;
  onSession?: (session: unknown) => void;
}

export default function CommandPalette({ open, onClose, onOpenFile, onKb, onTpl, onMap, onSession }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileRow[]>([]);
  const [kbResults, setKbResults] = useState<KbRow[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [mapProjects_, setMapProjects] = useState<MapRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // 打开前记录触发控件，关闭后把焦点还回去，键盘用户不会丢失位置。
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return undefined;
    }
    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (target && typeof target.focus === "function" && document.contains(target)) {
      requestAnimationFrame(() => target.focus());
    }
  }, [open]);

  // 打开时重置 + 拉数据
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIdx(0);
    setKbResults([]);

    (async () => {
      // 文件
      try {
        const d = await listFiles();
        const arr = ((d?.files || []) as FileRow[]).filter((f) => !f.isDir).slice(0, 30);
        setFiles(arr);
      } catch { setFiles([]); }
      // 模板
      try {
        const d = await tplList();
        const arr = ((d?.items || []) as TemplateRow[]).slice(0, 30);
        setTemplates(arr);
      } catch { setTemplates([]); }
      // 地图
      try {
        const d = await mapProjects();
        const arr = ((d?.projects || []) as MapRow[]).slice(0, 10);
        setMapProjects(arr);
      } catch { setMapProjects([]); }
      // 会话
      try {
        const d = await listSessions();
        const arr = ((d?.sessions || []) as unknown as SessionRow[]).slice(0, 10);
        setSessions(arr);
      } catch { setSessions([]); }
    })();
  }, [open]);

  // 防抖搜索知识库
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) { setKbResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        const d = await kbSearch(q);
        setKbResults(((d?.results || []) as KbRow[]) || []);
      } catch { setKbResults([]); }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, open]);

  // 打开时自动聚焦
  useEffect(() => {
    if (open) {
      // 下一帧聚焦（确保 input 已挂载）
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // 构建扁平化结果（组 → 项）
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: CommandGroup[] = [];

    const fileItems: CommandItem[] = files
      .filter((f) => matches({ title: String(f.name || ""), subtitle: String(f.ext || "") }, q))
      .map((f) => ({
        type: "file",
        id: `file:${String(f.name)}`,
        title: String(f.name || ""),
        subtitle: f.ext ? `.${String(f.ext)}` : "",
        icon: ICONS.file,
        action: () => onOpenFile?.(f.name)
      }));
    if (fileItems.length) out.push({ id: "files", title: "文件", items: fileItems });

    if (q) {
      const kbItems: CommandItem[] = kbResults
        .map((r) => ({
          type: "kb",
          id: `kb:${String(r.relPath)}`,
          title: String(r.title || r.relPath || ""),
          subtitle: String(r.snippet || r.relPath || ""),
          icon: ICONS.kb,
          action: () => onKb?.()
        }));
      if (kbItems.length) out.push({ id: "kb", title: "知识库", items: kbItems });
    }

    const tplItems: CommandItem[] = templates
      .filter((t) => matches({ title: String(t.title || t.name || ""), subtitle: String(t.category || "") }, q))
      .map((t) => ({
        type: "template",
        id: `tpl:${String(t.id || t.relPath || t.title)}`,
        title: String(t.title || t.name || ""),
        subtitle: [t.category, t.ext].filter(Boolean).map(String).join(" · "),
        icon: ICONS.template,
        action: () => onTpl?.()
      }));
    if (tplItems.length) out.push({ id: "templates", title: "模板", items: tplItems });

    const mapItems: CommandItem[] = mapProjects_
      .filter((p) => matches({ title: String(p.name || p.project || ""), subtitle: String(p.project || "") }, q))
      .map((p) => ({
        type: "map",
        id: `map:${String(p.project || p.name)}`,
        title: String(p.name || p.project || ""),
        subtitle: p.project ? `项目 · ${String(p.project)}` : "",
        icon: ICONS.map,
        action: () => onMap?.()
      }));
    if (mapItems.length) out.push({ id: "map", title: "地图", items: mapItems });

    const sessItems: CommandItem[] = sessions
      .filter((s) => matches({ title: String(s.title || s.label || ""), subtitle: String(s.id || "") }, q))
      .map((s) => ({
        type: "session",
        id: `sess:${String(s.id)}`,
        title: String(s.title || s.label || s.id || ""),
        subtitle: s.modified ? new Date(Number(s.modified) || (s.modified as unknown as string)).toLocaleString() : String(s.id || ""),
        icon: ICONS.session,
        action: () => onSession?.(s)
      }));
    if (sessItems.length) out.push({ id: "sessions", title: "会话", items: sessItems });

    return out;
  }, [files, kbResults, templates, mapProjects_, sessions, query, onOpenFile, onKb, onTpl, onMap, onSession]);

  // 扁平化供键盘导航使用
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // 输入或结果变化时，重置选中到第一项
  useEffect(() => {
    setSelectedIdx(0);
  }, [query, flat.length]);

  // 键盘上下移动选择时，把当前项滚进可视区，长列表也不会"选中项在屏幕外"。
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(`[data-cmd-index="${selectedIdx}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIdx, open]);

  // 关闭时清空防抖中的知识库结果，避免下次打开闪现过期内容
  useEffect(() => {
    if (!open) setKbResults([]);
  }, [open]);

  // 键盘处理
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose?.();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length) setSelectedIdx((i) => (i + 1) % flat.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setSelectedIdx((i) => (i - 1 + flat.length) % flat.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[selectedIdx];
      if (item) {
        item.action();
        onClose?.();
      }
    }
  };

  if (!open) return null;

  // 计算每个 item 在 flat 中的起始索引（用于高亮）——普通计算（非 hook，避免条件 hooks）
  const indexMap = (() => {
    const m = new Map<string, number>();
    let i = 0;
    for (const g of groups) {
      for (const it of g.items) {
        m.set(it.id, i++);
      }
    }
    return m;
  })();

  const totalCount = flat.length;

  return (
    <div className="cmd-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="cmd-panel" role="dialog" aria-modal="true" aria-label="命令面板">
        <input
          ref={inputRef}
          className="cmd-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="cmd-results-list"
          aria-autocomplete="list"
          aria-activedescendant={totalCount ? `cmd-option-${selectedIdx}` : undefined}
          aria-label="搜索文件、知识库、模板、地图和会话"
          placeholder="搜索 文件 / 知识库 / 模板 / 地图 / 会话…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="cmd-results" id="cmd-results-list" role="listbox" aria-label="命令面板结果" ref={listRef}>
          {totalCount === 0 && (
            <div className="cmd-empty" role="status">{query.trim() ? "无匹配结果" : "暂无内容"}</div>
          )}
          {groups.map((g) => (
            <div className="cmd-group" key={g.id} role="group" aria-label={g.title}>
              <div className="cmd-group-title" aria-hidden="true">{g.title}</div>
              {g.items.map((it) => {
                const idx = indexMap.get(it.id);
                const isSelected = idx === selectedIdx;
                return (
                  <div
                    key={it.id}
                    id={`cmd-option-${idx}`}
                    data-cmd-index={idx}
                    role="option"
                    tabIndex={-1}
                    aria-selected={isSelected}
                    className={`cmd-item${isSelected ? " selected" : ""}`}
                    onMouseEnter={() => setSelectedIdx(idx ?? 0)}
                    onClick={() => { it.action(); onClose?.(); }}
                  >
                    <span className="cmd-item-icon" aria-hidden="true"><Icon name={it.icon} size={14} /></span>
                    <div className="cmd-item-main">
                      <div className="cmd-item-title">{it.title}</div>
                      {it.subtitle && <div className="cmd-item-sub">{it.subtitle}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cmd-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭后焦点返回</span>
          <span style={{ marginLeft: "auto" }}>{totalCount} 项</span>
        </div>
      </div>
    </div>
  );
}
