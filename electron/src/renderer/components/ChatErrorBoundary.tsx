/**
 * 聊天错误边界（F3 批6a：自 client/src/components/ChatPanel.jsx 的 ErrorBoundary
 * 逐行迁移；console.error 文案保持 "ChatPanel error:" 原样）。
 */
import React from "react";
import Icon from "./Icon";

interface ChatErrorBoundaryProps {
  children?: React.ReactNode;
}

interface ChatErrorBoundaryState {
  hasError: boolean;
  error: unknown;
}

class ChatErrorBoundary extends React.Component<ChatErrorBoundaryProps, ChatErrorBoundaryState> {
  constructor(props: ChatErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: unknown): ChatErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: unknown, errorInfo: unknown): void {
    console.error("ChatPanel error:", error, errorInfo);
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="chat-error-boundary">
          <div className="error-content">
            <div className="error-icon"><Icon name="warning" size={32} /></div>
            <div className="error-text">组件出错，请刷新页面</div>
            <button className="btn" onClick={() => window.location.reload()}>
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ChatErrorBoundary;
