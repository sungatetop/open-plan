import React, { useCallback, useMemo, useState } from "react";
import ChatPanel from "./panel";
import type { LastPromptInfo } from "./panel";
import type { ChatModel, ChatReference } from "../../lib/chat-shared";

/**
 * 知识库 / Skills 入口共用的只读 Chat（自 client/components/SearchChat.jsx 逐行等价转录，F3 批7a）。
 * 它复用主 ChatPanel 的 Pi SSE、重连、工具事件和会话处理，避免页面入口各自维护一套对话协议。
 */
export interface RetrievalChatProps {
  scope?: string;
  title?: string;
  clientId: string;
  workspace?: string;
  project?: Record<string, unknown> | null;
  models?: ChatModel[];
  defaultModel?: string;
  contextLabel?: string;
  contextText?: string;
  references?: ChatReference[];
  onClose?: () => void;
  onPromoteToAgent?: (payload: LastPromptInfo) => void;
}

export default function RetrievalChat({
  scope = "knowledge",
  title = "检索 Chat",
  clientId,
  workspace = "",
  project = null,
  models = [],
  defaultModel = "",
  contextLabel = "",
  contextText = "",
  references = [],
  onClose,
  onPromoteToAgent,
}: RetrievalChatProps): React.JSX.Element {
  const storageKey = `oaw_retrieval_thread_${scope}`;
  const [threadId] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) return saved;
      const next = `retrieval-${scope}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
      localStorage.setItem(storageKey, next);
      return next;
    } catch {
      return `retrieval-${scope}`;
    }
  });
  // referenceKey 只是把数组内容序列化成可比对的字符串：references 每次渲染都是新引用，
  // 不能直接进依赖，否则 initialReferences（下游 ChatPanel 的引用初始化）会反复重建。
  const referenceKey = useMemo(
    () => references.map((item) => `${String(item.id || "")}:${String(item.kind || "")}:${String(item.target || "")}`).join("|"),
    [references]
  );
  const initialReferences = useMemo(() => references, [referenceKey]);
  const promote = useCallback((payload: LastPromptInfo) => {
    onPromoteToAgent?.({
      ...payload,
      references: payload?.references?.length ? payload.references : initialReferences,
      contextText: [contextText, payload?.contextText].filter(Boolean).join("\n\n"),
    });
  }, [contextText, initialReferences, onPromoteToAgent]);

  return (
    <div className="retrieval-chat-shell">
      <div className="retrieval-chat-head">
        <div>
          <div className="retrieval-chat-title">{title}</div>
          <div className="retrieval-chat-subtitle">只读搜索与说明 · 不修改文件</div>
        </div>
        {onClose && <button className="btn-xs" onClick={onClose}>关闭</button>}
      </div>
      <ChatPanel
        clientId={clientId}
        threadId={threadId}
        workspace={workspace}
        project={project}
        currentDoc={contextLabel}
        models={models}
        defaultModel={defaultModel}
        embedded
        forcedMode="chat"
        panelTitle="Chat"
        contextText={contextText}
        initialReferences={initialReferences}
        onPromoteToAgent={promote}
        onFileChanged={() => {}}
        onMapAction={() => {}}
        onNewSession={() => {}}
        onRefreshSessions={() => {}}
        onSessionChange={() => {}}
        sessions={[]}
        unreadByThread={{}}
      />
    </div>
  );
}
