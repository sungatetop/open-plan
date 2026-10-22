import React, { useRef, useState, useEffect } from "react";
import Icon from "./Icon";
import MarqueeText from "./MarqueeText";
import { askConfirm } from "./Feedback";
import {
  RUNNING_SESSION_STATUSES,
  getPinnedSet,
  togglePin,
  formatTime,
  groupByDate,
  shortenCwd,
} from "../lib/session-list";

/**
 * 会话列表：置顶区 + 日期分组（Proma 风格，供左侧栏与对话栏历史抽屉共用）。
 * F3 批5b：与 client/src/components/SessionSidebar.jsx 的 SessionList 逐行等价，对拍强制。
 */

export interface SessionRecord {
  id: string;
  title?: string;
  label?: string;
  runStatus?: string;
  mode?: string;
  modified?: string;
  artifactCount?: number;
  threadId?: string;
  cwd?: string;
  projectId?: string | null;
  pinned?: boolean;
  frozen?: boolean;
  parentSessionId?: string;
  branchPurpose?: string;
}

export interface SessionListProps {
  sessions: SessionRecord[];
  unreadByThread?: Record<string, number>;
  onSelect: (session: SessionRecord) => void;
  onDelete: (id: string) => void | Promise<void>;
  onBatchDelete?: (ids: string[]) => void | Promise<void>;
  onRename: (id: string, value: string) => void | Promise<void>;
  onFork?: (id: string, name: string) => void | Promise<void>;
  onPin?: (id: string, pinned: boolean) => void | Promise<void>;
  onFreeze?: (id: string, frozen: boolean) => void | Promise<void>;
  initialEditingId?: string | null;
}

const RUN_STATUS_TEXT: Record<string, string> = {
  running: "执行中", queued: "排队中", waiting_user: "等待回答",
  recovering: "恢复中", cancel_requested: "正在中断",
  completed: "已完成", failed: "失败", aborted: "已中断",
};

export function SessionList({ sessions, unreadByThread = {}, onSelect, onDelete, onBatchDelete, onRename, onFork, onPin, onFreeze, initialEditingId = null }: SessionListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [pinned, setPinned] = useState(getPinnedSet);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [actionsId, setActionsId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set<string>());
  const initialEditAppliedRef = useRef<string | null>(null);

  useEffect(() => {
    const available = new Set(sessions.map((session) => session.id));
    setSelectedIds((current) => new Set([...current].filter((id) => available.has(id))));
  }, [sessions]);

  useEffect(() => {
    if (!initialEditingId) {
      initialEditAppliedRef.current = null;
      return;
    }
    if (initialEditAppliedRef.current === initialEditingId) return;
    const target = sessions.find((session) => session.id === initialEditingId);
    if (!target) return;
    initialEditAppliedRef.current = initialEditingId;
    setEditingId(initialEditingId);
    setEditValue(target.label || target.title || "");
  }, [initialEditingId, sessions]);

  const handleRename = async (id: string) => {
    await onRename(id, editValue);
    setEditingId(null);
  };

  const handleTogglePin = async (session: SessionRecord) => {
    const isPinned = session.pinned ?? pinned.has(session.id);
    if (onPin) await onPin(session.id, !isPinned);
    const next = togglePin(session.id);
    setPinned(new Set(next));
  };

  const handleToggleFreeze = async (session: SessionRecord) => {
    if (onFreeze) await onFreeze(session.id, !session.frozen);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const searched = search.trim()
    ? sessions.filter((s) => (s.title || s.label || s.id).toLowerCase().includes(search.toLowerCase()))
    : sessions;
  const filtered = statusFilter === "all"
    ? searched
    : searched.filter((s) => s.runStatus === statusFilter);
  const isSessionPinned = (session: SessionRecord) => session.pinned ?? pinned.has(session.id);
  const pinnedList = filtered.filter(isSessionPinned);
  const unpinned = filtered.filter((s) => !isSessionPinned(s));
  const groups = groupByDate(unpinned);

  const renderItem = (s: SessionRecord) => {
    const isPinned = s.pinned ?? pinned.has(s.id);
    return (
    <div
      key={s.id}
      className={`session-item ${selecting && selectedIds.has(s.id) ? "selected" : ""} ${RUNNING_SESSION_STATUSES.has(s.runStatus as string) ? "is-running" : ""}`}
      onClick={() => selecting ? toggleSelected(s.id) : onSelect(s)}
      onMouseEnter={() => setActionsId(s.id)}
      onMouseLeave={() => setActionsId((id) => id === s.id ? null : id)}
      onFocus={() => setActionsId(s.id)}
    >
      {selecting && <button type="button" className="session-select" onClick={(e) => { e.stopPropagation(); toggleSelected(s.id); }} aria-pressed={selectedIds.has(s.id)} title={selectedIds.has(s.id) ? "取消选择" : "选择会话"}>{selectedIds.has(s.id) ? "✓" : ""}</button>}
      <div className="session-indicator" data-status={s.runStatus && s.runStatus !== "idle" ? s.runStatus : "idle"} />
      <div className="session-info">
        {editingId === s.id ? (
          <div className="session-rename" onClick={(e) => e.stopPropagation()}>
            <input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleRename(s.id); if (e.key === "Escape") setEditingId(null); }}
              autoFocus
              className="rename-input"
            />
            <button className="btn-xs" onClick={() => handleRename(s.id)}>确定</button>
          </div>
        ) : (
          <>
            <span
              className="session-label"
              title={s.title || s.label || "未命名会话"}
              onDoubleClick={(e) => { e.stopPropagation(); setEditingId(s.id); setEditValue(s.label || s.title || ""); }}
            >
              {isPinned && <Icon name="pin" size={12} className="pin-icon" />}
              {s.frozen && <span className="session-frozen-mark" title="会话已冻结">冻结</span>}
              {s.parentSessionId && <span className="session-branch-mark" title={s.branchPurpose || "独立分支"}>分支</span>}
              <MarqueeText
                text={s.title || s.label || "未命名会话"}
                active={RUNNING_SESSION_STATUSES.has(s.runStatus as string)}
                className="session-label-text"
              />
            </span>
            <span className="session-time">
              {s.mode && <span className={`session-mode mode-${s.mode}`}>{s.mode === "chat" ? "Chat" : s.mode === "review" ? "Review" : s.mode === "office" ? "Office" : "Work"}</span>}
              {s.runStatus && s.runStatus !== "idle" ? (RUN_STATUS_TEXT[s.runStatus] || s.runStatus) : formatTime(s.modified)}
              {s.artifactCount != null && s.artifactCount > 0 && <span className="session-artifact-count"> · 产物 {s.artifactCount}</span>}
            </span>
          </>
        )}
      </div>
      {(unreadByThread[s.threadId || s.id] || 0) > 0 && <span className="session-unread" title="有新的后台任务状态更新">{(unreadByThread[s.threadId || s.id] || 0) > 99 ? "99+" : unreadByThread[s.threadId || s.id]}</span>}
      {s.cwd && <div className="session-cwd" title={s.cwd}>{shortenCwd(s.cwd)}</div>}
      {!selecting && actionsId === s.id && (
        <div className="session-actions" onClick={(e) => e.stopPropagation()}>
        <button className="btn-icon" onClick={() => handleTogglePin(s)} title={isPinned ? "取消置顶" : "置顶"}>
          <Icon name="pin" size={12} className={isPinned ? "pinned" : ""} />
        </button>
        <button
          className="btn-icon"
          onClick={() => { setEditingId(s.id); setEditValue(s.label || s.title || ""); }}
          title="重命名"
        ><Icon name="penTool" size={12} /></button>
        <button className="btn-icon" onClick={async () => { if (onFork) await onFork(s.id, `${s.title || s.label || "会话"}（分支）`); }} title="从此会话创建分支"><Icon name="copy" size={12} /></button>
        <button className="btn-icon" onClick={() => handleToggleFreeze(s)} title={s.frozen ? "解冻会话" : "冻结会话"}><Icon name={s.frozen ? "check" : "stop"} size={12} /></button>
        <button
          className="btn-icon danger"
          onClick={async () => { if (await askConfirm("确认删除此会话?")) { await onDelete(s.id); } }}
          title="删除"
        ><Icon name="trash" size={12} /></button>
        </div>
      )}
    </div>
  );
  };

  return (
    <div className="session-list">
      <div className="session-search">
        <Icon name="search" size={12} />
        <input placeholder="搜索会话…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="session-batch-toolbar">
        <button type="button" className={`session-batch-toggle ${selecting ? "active" : ""}`} onClick={() => { setSelecting((value) => !value); setSelectedIds(new Set()); }}>{selecting ? "取消选择" : "选择会话"}</button>
        {selecting && <>
          <button type="button" onClick={() => setSelectedIds(new Set(filtered.map((session) => session.id)))}>全选</button>
          <button type="button" onClick={() => setSelectedIds(new Set())}>清空</button>
          <button type="button" className="danger" disabled={!selectedIds.size || !onBatchDelete} onClick={async () => {
            if (!selectedIds.size || !onBatchDelete) return;
            if (!(await askConfirm(`确认删除已选的 ${selectedIds.size} 个会话吗？运行中的会话会自动跳过。`))) return;
            await onBatchDelete([...selectedIds]);
            setSelectedIds(new Set());
            setSelecting(false);
          }}>批量删除{selectedIds.size ? `（${selectedIds.size}）` : ""}</button>
        </>}
      </div>
      <div className="session-filters" role="tablist" aria-label="会话状态筛选">
        {[{ id: "all", label: "全部" }, { id: "running", label: "执行中" }, { id: "recovering", label: "恢复中" }, { id: "completed", label: "已完成" }, { id: "failed", label: "失败" }, { id: "aborted", label: "已中断" }].map((item) => (
          <button key={item.id} className={`session-filter ${statusFilter === item.id ? "active" : ""}`} onClick={() => setStatusFilter(item.id)}>{item.label}</button>
        ))}
      </div>
      {sessions.length === 0 && <div className="empty">暂无会话记录</div>}
      {/* 置顶区 */}
      {pinnedList.length > 0 && (
        <div className="session-group">
          <div className="session-group-title"><Icon name="pin" size={12} /> 置顶</div>
          {pinnedList.map((s) => renderItem(s))}
        </div>
      )}
      {/* 日期分组区 */}
      {groups.map(([label, items]) => (
        <div className="session-group" key={label}>
          <div className="session-group-title">{label}</div>
          {items.map((s) => renderItem(s))}
        </div>
      ))}
      {filtered.length === 0 && sessions.length > 0 && <div className="empty">无匹配结果</div>}
    </div>
  );
}
