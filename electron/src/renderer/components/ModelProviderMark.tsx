/**
 * 模型供应商标识 + 模型选项行（F3 批6a：自 client/src/components/ChatPanel.jsx
 * 的 ModelProviderMark / ModelOptionRow 逐行迁移，JSX 与 className 保持不变）。
 */
import React from "react";
import Icon, { ProviderIcon } from "./Icon";
import {
  modelProvider,
  modelProviderMeta,
  modelDisplayName,
  modelCapabilityLabel,
  providerInitials,
  providerHue,
  type ChatModel,
} from "../lib/chat-shared";

export interface ModelProviderMarkProps {
  model: ChatModel | null | undefined;
  size?: number;
}

const ModelProviderMark: React.FunctionComponent<ModelProviderMarkProps> = ({ model, size = 18 }) => {
  const provider = modelProvider(model);
  const meta = modelProviderMeta(model);
  const known = meta.icon !== "custom";
  const fontSize = Math.max(9, Math.round(size * 0.52));
  return (
    <span
      className={`model-provider-mark provider-${provider}${known ? "" : " provider-initials"}`}
      style={known ? { width: size, height: size } : { width: size, height: size, fontSize, background: `hsl(${providerHue(provider)} 46% 42%)` }}
      aria-hidden="true"
      title={meta.label}
    >
      {known ? <ProviderIcon provider={meta.icon} size={Math.max(11, size - 4)} /> : providerInitials(provider)}
    </span>
  );
};

export default ModelProviderMark;

// 模型行：选择区 + 收藏按钮分开，键盘焦点与点击区域互不干扰；
// 能力标签统一走 modelCapabilityLabel（真实元数据）。
export interface ModelOptionRowProps {
  model: ChatModel;
  current?: boolean;
  favorite?: boolean;
  onPick: (id: string | undefined) => void;
  onToggleFavorite: (id: string | undefined) => void;
}

export const ModelOptionRow: React.FunctionComponent<ModelOptionRowProps> = ({ model, current, favorite, onPick, onToggleFavorite }) => {
  const unavailable = model.available === false;
  return (
    <div className={`model-option-row ${current ? "active" : ""} ${unavailable ? "disabled" : ""}`}>
      <button
        type="button"
        className="ct-pop-item model-option"
        onClick={() => { if (!unavailable) onPick(model.id); }}
        title={unavailable ? `${model.id}（当前不可用）` : model.id}
        disabled={unavailable}
      >
        <ModelProviderMark model={model} size={17} />
        <span><strong>{modelDisplayName(model)}</strong><small>{modelCapabilityLabel(model)} · {model.id}</small></span>
        {unavailable && <span className="model-unavailable-badge" title="当前不可用：供应商缺少密钥、无模型权限或网络不可达（可在设置里配置后重新扫描）">不可用</span>}
        {current && <Icon name="check" size={12} />}
      </button>
      <button
        type="button"
        className={`model-fav-btn ${favorite ? "active" : ""}`}
        onClick={(event) => { event.stopPropagation(); onToggleFavorite(model.id); }}
        aria-pressed={favorite}
        aria-label={favorite ? `取消收藏 ${modelDisplayName(model)}` : `收藏 ${modelDisplayName(model)}`}
        title={favorite ? "取消收藏（仅存本机偏好）" : "收藏（仅存本机偏好，不复制密钥）"}
      >
        <Icon name="star" size={12} />
      </button>
    </div>
  );
};
