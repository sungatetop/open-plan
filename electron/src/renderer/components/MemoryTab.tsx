import React, { useEffect, useState, useCallback, useRef } from "react";
import Icon from "./Icon";
import {
  approveMemoryProposal, editMemoryProposal, listMemoryProposals, memoryProposalHistory,
  mergeMemoryProposals, rejectMemoryProposal, listMemoryFiles, readMemoryFile, saveMemoryFile, initMemory
} from "../api/client-api";
import { subscribeDesktopEvents, stopMemoryEvents, watchMemoryEvents } from "../api/ipc-client";
import { acquireStream } from "../lib/stream-budget";
import type { MemoryProposal } from "../../shared/protocol/channels";

/**
 * 「记忆与沉淀」tab（Proma WorkspaceMemory 风格）：记忆文件浏览/编辑 + 待沉淀建议治理。
 * 迁移期事件源：legacy /api/memory/stream SSE 由 main 侧记忆事件桥翻译为 op:event
 * （帧类型 op:memory-change），组件侧与旧客户端同构消费。
 *
 * 与 client/src/components/MemoryTab.jsx 逐行等价（tests/f3-batch4-parity.test.tsx 对拍强制）。
 */

const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  project_fact: "项目事实",
  work_rule: "工作规则",
  user_preference: "用户偏好",
  lesson: "经验教训",
  resource_index: "资料索引",
};

interface MemoryFileItem { rel: string; type?: string; size?: number }
interface MemoryChange { file: string; event?: string; preview?: string; time?: number }
interface ProposalHistoryState { id?: string; history?: Array<{ version?: number; action?: string; at?: string }> }

export interface MemoryTabProps {
  workspace?: string;
  projectId?: string;
}

export default function MemoryTab({ workspace = "", projectId = "" }: MemoryTabProps): React.ReactElement {
  const [files, setFiles] = useState<MemoryFileItem[]>([]);
  const [active, setActive] = useState<string | null>(null); // rel path
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [changes, setChanges] = useState<MemoryChange[]>([]); // {file, preview, time}
  const [loading, setLoading] = useState(false);
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [proposalStatus, setProposalStatus] = useState("pending");
  const [selectedProposals, setSelectedProposals] = useState<string[]>([]);
  const [editingProposal, setEditingProposal] = useState<string | null>(null);
  const [proposalDraft, setProposalDraft] = useState("");
  const [history, setHistory] = useState<ProposalHistoryState | null>(null);
  const [proposalMsg, setProposalMsg] = useState("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([
        listMemoryFiles(),
        listMemoryProposals(workspace, proposalStatus, projectId).catch(() => ({ proposals: [] })),
      ]);
      setFiles(d.files || []);
      setProposals(p.proposals || []);
    } catch {}
  }, [projectId, workspace, proposalStatus]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadFile = useCallback(async (rel: string) => {
    try {
      const d = await readMemoryFile(rel);
      setActive(rel);
      setContent(d.content || "");
      setEditing(false);
      setDirty(false);
    } catch {}
  }, []);

  // 记忆变更监听（旧客户端为 EventSource /api/memory/stream；桌面形态经 op:event 推送）。
  // 依赖数组必须为空：早先挂在 [active, dirty] 上，编辑一次文件就会关闭并重建连接，
  // 既造成同源连接槽位抖动，也让"实时"变成"每次编辑重连"。
  //
  // loadFile 同样不能进依赖数组：改用 ref 取稳定引用，连接只在挂载/卸载时建立和释放。
  const loadFileRef = useRef(loadFile);
  loadFileRef.current = loadFile;
  const memoryStateRef = useRef({ active: "" as string | null, dirty: false });
  memoryStateRef.current = { active, dirty };
  useEffect(() => {
    const slot = acquireStream("memory-changes", { priority: 4, label: "记忆变更流" });
    if (!slot) return undefined;
    void watchMemoryEvents();
    const unsubscribe = subscribeDesktopEvents((event) => {
      if (event.type !== "op:memory-change") return;
      try {
        const data = event.data as unknown;
        if (!data || typeof data !== "object") return;
        const change = data as MemoryChange;
        setChanges((prev) => {
          const next = [change, ...prev.filter((c) => c.file !== change.file)].slice(0, 8);
          return next;
        });
        // 如果正在查看变更的文件，自动刷新
        const { active: currentFile, dirty: currentDirty } = memoryStateRef.current;
        if (currentFile === change.file && !currentDirty) void loadFileRef.current(currentFile);
      } catch {}
    });
    slot.attach(() => { void stopMemoryEvents(); });
    return () => {
      unsubscribe();
      void stopMemoryEvents();
      slot.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveFile = useCallback(async () => {
    if (!active || !dirty) return;
    setLoading(true);
    try {
      await saveMemoryFile(active, content);
      setDirty(false);
    } catch {}
    setLoading(false);
  }, [active, content, dirty]);

  // 自动保存防抖
  useEffect(() => {
    if (!dirty) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void saveFile(); }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [dirty, saveFile]);

  const handleInit = async () => {
    setLoading(true);
    try {
      const d = await initMemory();
      if (d.files) setFiles(d.files);
    } catch {}
    setLoading(false);
  };

  const dismissChange = (file: string) => {
    setChanges((prev) => prev.filter((c) => c.file !== file));
  };

  const handleApproveProposal = async (id: string) => {
    if (proposalLoading) return;
    setProposalLoading(true);
    setProposalMsg("");
    try {
      await approveMemoryProposal(id);
      setSelectedProposals((prev) => prev.filter((item) => item !== id));
      void refresh();
    } catch (error) { setProposalMsg(`批准失败：${(error as Error).message}`); }
    setProposalLoading(false);
  };

  const handleRejectProposal = async (id: string) => {
    const reason = window.prompt("拒绝原因（可选）", "用户拒绝该记忆建议");
    if (reason === null || proposalLoading) return;
    setProposalLoading(true);
    setProposalMsg("");
    try {
      await rejectMemoryProposal(id, reason);
      setSelectedProposals((prev) => prev.filter((item) => item !== id));
      void refresh();
    } catch (error) { setProposalMsg(`拒绝失败：${(error as Error).message}`); }
    setProposalLoading(false);
  };

  const startProposalEdit = (proposal: MemoryProposal) => {
    setEditingProposal(proposal.id);
    setProposalDraft(proposal.content || "");
    setProposalMsg("");
  };

  const saveProposalEdit = async (proposal: MemoryProposal) => {
    if (proposalLoading) return;
    setProposalLoading(true);
    setProposalMsg("");
    try {
      await editMemoryProposal(proposal.id, { content: proposalDraft, category: proposal.category });
      setEditingProposal(null);
      void refresh();
    } catch (error) { setProposalMsg(`编辑失败：${(error as Error).message}`); }
    setProposalLoading(false);
  };

  const toggleProposal = (id: string) => {
    setSelectedProposals((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]);
  };

  const handleMerge = async () => {
    if (selectedProposals.length < 2 || proposalLoading) return;
    setProposalLoading(true);
    setProposalMsg("");
    try {
      await mergeMemoryProposals(selectedProposals[0]!, selectedProposals.slice(1));
      setSelectedProposals([]);
      void refresh();
    } catch (error) { setProposalMsg(`合并失败：${(error as Error).message}`); }
    setProposalLoading(false);
  };

  const loadProposalHistory = async (id: string) => {
    if (history?.id === id) { setHistory(null); return; }
    try { setHistory(await memoryProposalHistory(id)); } catch (error) { setProposalMsg(`历史读取失败：${(error as Error).message}`); }
  };

  return (
    <div className="memory-tab">
      {/* 记忆变更 Dock（Proma MemoryChangeDock 风格） */}
      {changes.length > 0 && (
        <div className="memory-dock">
          <div className="memory-dock-head"><Icon name="info" size={12} /> 记忆已更新</div>
          {changes.map((c) => (
            <div key={c.file} className="memory-change-item" onClick={() => { void loadFile(c.file); }}>
              <Icon name="file" size={12} />
              <span className="memory-change-file">{c.file}</span>
              <button className="memory-change-dismiss" onClick={(e) => { e.stopPropagation(); dismissChange(c.file); }}>
                <Icon name="x" size={9} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 待沉淀卡片：长期记忆必须经过用户确认 */}
      <div className="memory-proposals">
          <div className="memory-proposals-head">
            <span><Icon name="bookmark" size={12} /> 记忆治理（{proposals.length}）</span>
            <select value={proposalStatus} onChange={(e) => { setProposalStatus(e.target.value); setSelectedProposals([]); }}>
              <option value="pending">待审核</option>
              <option value="all">全部历史</option>
              <option value="approved">已批准</option>
              <option value="rejected">已拒绝</option>
              <option value="merged">已合并</option>
            </select>
          </div>
          {selectedProposals.length >= 2 && <button className="btn-xs" onClick={() => { void handleMerge(); }} disabled={proposalLoading}>合并所选（首条为主建议）</button>}
          {proposalMsg && <div className="memory-proposal-msg">{proposalMsg}</div>}
          {proposals.length === 0 && <div className="memory-proposal-empty">当前筛选下没有记忆建议。</div>}
          {proposals.map((proposal) => (
            <div className="memory-proposal-row" key={proposal.id}>
              {proposal.status === "pending" && <input type="checkbox" checked={selectedProposals.includes(proposal.id)} onChange={() => toggleProposal(proposal.id)} title="选择合并" />}
              <div className="memory-proposal-copy">
                <strong>{proposal.section || MEMORY_CATEGORY_LABELS[String(proposal.category ?? "")] || String(proposal.category ?? "")} · {proposal.status === "pending" ? "待审核" : proposal.status}</strong>
                {editingProposal === proposal.id ? (
                  <textarea className="memory-proposal-edit" value={proposalDraft} onChange={(e) => setProposalDraft(e.target.value)} />
                ) : <span>{proposal.content}</span>}
                <small>来源：{proposal.source?.label || "Agent"} · Run：{proposal.runId || "无"} · v{proposal.version || 1}</small>
                {history?.id === proposal.id && <div className="memory-proposal-history">{(history.history || []).map((item) => <div key={`${item.version}-${item.action}`}><b>v{item.version} {item.action}</b><span>{item.at}</span></div>)}</div>}
              </div>
              <div className="memory-proposal-actions">
                {proposal.status === "pending" && (editingProposal === proposal.id ? <><button className="btn-xs primary" onClick={() => { void saveProposalEdit(proposal); }} disabled={proposalLoading}>保存</button><button className="btn-xs" onClick={() => setEditingProposal(null)}>取消</button></> : <><button className="btn-xs primary" onClick={() => { void handleApproveProposal(proposal.id); }} disabled={proposalLoading}>确认写入</button><button className="btn-xs" onClick={() => startProposalEdit(proposal)}>编辑</button><button className="btn-xs" onClick={() => { void handleRejectProposal(proposal.id); }} disabled={proposalLoading}>拒绝</button></>)}
                <button className="btn-xs" onClick={() => { void loadProposalHistory(proposal.id); }}>历史</button>
              </div>
            </div>
          ))}
      </div>

      {/* 工具栏 */}
      <div className="memory-toolbar">
        <button className="btn-sm" onClick={() => { void refresh(); }}>刷新</button>
        <button className="btn-sm" onClick={() => { void handleInit(); }} disabled={loading}>
          {loading ? "创建中..." : "初始化记忆"}
        </button>
      </div>

      {/* 文件列表 + 内容区 */}
      <div className="memory-layout">
        <div className="memory-file-list">
          {files.length === 0 && <div className="empty">暂无记忆文件，点击「初始化记忆」</div>}
          {files.map((f) => (
            <div
              key={f.rel}
              className={`memory-file-item ${active === f.rel ? "active" : ""}`}
              onClick={() => { void loadFile(f.rel); }}
            >
              <Icon name={f.type === "agents" ? "doc" : "file"} size={12} />
              <span className="memory-file-name">{f.rel}</span>
              <span className="memory-file-size">{((f.size as number) / 1024).toFixed(1)}k</span>
            </div>
          ))}
        </div>
        {active && (
          <div className="memory-editor">
            <div className="memory-editor-head">
              <span className="memory-editor-name">{active}</span>
              <div className="memory-editor-actions">
                <button className={`btn-xs ${editing ? "active" : ""}`} onClick={() => setEditing(!editing)}>
                  {editing ? "预览" : "编辑"}
                </button>
                {dirty && <button className="btn-xs" onClick={() => { void saveFile(); }}>保存</button>}
              </div>
            </div>
            <textarea
              className="memory-textarea"
              value={content}
              readOnly={!editing}
              onChange={(e) => { setContent(e.target.value); setDirty(true); }}
              placeholder="在此编辑记忆文件..."
            />
          </div>
        )}
      </div>
    </div>
  );
}
