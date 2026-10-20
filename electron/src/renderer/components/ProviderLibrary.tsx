import React, { useCallback, useEffect, useMemo, useState } from "react";
import Icon, { ProviderIcon } from "./Icon";
import { providerIdentity, providerLabel } from "../lib/provider-identity";
import { agentProviderCatalogRefresh, agentProviderDetail, agentProviderImport } from "../api/client-api";

/**
 * 供应商库：可搜索、按登录方式筛选，一键把 Base URL / 协议 / 模型能力写进配置。
 * F3 批5b-3：与 client/src/components/ProviderLibrary.jsx 逐行等价，对拍强制。
 * 旧版中文组件名按仓库命名规范映射：供应商库→ProviderLibrary、供应商导入对话框→ProviderImportDialog。
 */

export interface ProviderCatalogModel {
  id: string;
  name?: string;
  contextWindow?: number;
  vision?: boolean;
  reasoning?: boolean;
}

/** 列表与详情共有的供应商字段（两端的 configured 形态不同：列表为布尔，详情为对象）。 */
interface ProviderCore {
  id: string;
  name?: string;
  api?: string;
  apiLabel?: string;
  source?: string;
  isDefault?: boolean;
  configuredModelCount?: number;
  authError?: string;
  importable?: boolean;
  importBlockReason?: string;
  loginMethods?: string[];
  modelCount?: number;
  sampleModels?: ProviderCatalogModel[];
  capabilities?: { maxContext?: number; visionCount?: number; reasoningCount?: number };
  auth?: {
    oauth?: { name?: string } | null;
    apiKey?: { name?: string; envVars?: string[] } | null;
  };
  baseUrl?: string;
}

export interface ProviderCatalogEntry extends ProviderCore {
  configured?: boolean;
}

/** 详情端点返回的 provider：configured 为对象形态（keyConfigured / 已配置模型），并带完整模型清单。 */
export interface ProviderDetailEntry extends ProviderCore {
  configured?: { keyConfigured?: boolean; models?: ProviderCatalogModel[] } | null;
  models?: ProviderCatalogModel[];
}

export interface ProviderCatalogData {
  providers?: ProviderCatalogEntry[];
  sources?: {
    builtin?: { count?: number };
    modelsDev?: { count?: number; fetchedAt?: string; status?: string };
  } | null;
  totalModels?: number;
  error?: string;
}

export interface ProviderImportResult {
  name?: string;
  total?: number;
  defaultModel?: string;
}

/** 上下文窗口的紧凑写法：128000 → 128K，1000000 → 1M。 */
export function formatContext(value: unknown): string {
  const n = Number(value) || 0;
  if (!n) return "";
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** 供应商库列表默认渲染条数：models.dev 接入后目录可达 200+，超出部分折叠。 */
const LIST_PAGE_SIZE = 80;

/** models.dev 缓存状态的中文文案。 */
function sourceStatusText(status: string | undefined): string {
  if (status === "fresh") return "最新";
  if (status === "stale") return "已超过 7 天，建议刷新";
  return "离线 · 未拉取";
}

function LoginMethodBadge({ provider }: { provider: ProviderCore }) {
  const methods = Array.isArray(provider.loginMethods) ? provider.loginMethods : [];
  return (
    <span className="prov-login-badges">
      {methods.includes("oauth") && (
        <span className="sp-badge ok" title={provider.auth?.oauth?.name || "支持账号登录（浏览器授权）"}>
          <Icon name="lock" size={12} /> 账号登录
        </span>
      )}
      {methods.includes("apiKey") && (
        <span className="sp-badge" title={provider.auth?.apiKey?.envVars?.length ? `环境变量：${provider.auth.apiKey.envVars.join(" / ")}` : provider.auth?.apiKey?.name || "API Key"}>
          API Key
        </span>
      )}
    </span>
  );
}

function CapabilitySummary({ provider }: { provider: ProviderCore }) {
  const caps = provider.capabilities || {};
  const parts: string[] = [];
  if (provider.modelCount) parts.push(`${provider.modelCount} 个模型`);
  if (caps.maxContext) parts.push(`最大上下文 ${formatContext(caps.maxContext)}`);
  if (caps.visionCount) parts.push(`${caps.visionCount} 个支持图片`);
  return parts.join(" · ");
}

export interface ProviderLibraryProps {
  catalog?: ProviderCatalogData | null;
  onImported?: (result: ProviderImportResult) => void;
  onEditExisting?: (providerId: string) => void;
  onCatalogRefreshed?: () => void;
  refreshing?: boolean;
}

/**
 * 供应商库：可搜索、按登录方式筛选，一键把 Base URL / 协议 / 模型能力写进配置。
 * 目录 = Pi 内置快照 + models.dev 合并（/api/agent/provider-catalog），
 * 「刷新目录」从 models.dev 拉最新供应商与模型（离线自动降级用缓存）。
 */
export function ProviderLibrary({ catalog, onImported, onEditExisting, onCatalogRefreshed, refreshing = false }: ProviderLibraryProps) {
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState("all");
  const [detailId, setDetailId] = useState("");
  const [listExpanded, setListExpanded] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshNote, setRefreshNote] = useState("");
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : [];
  const sources = catalog?.sources || null;
  const modelsDev = sources?.modelsDev || null;

  const runRefresh = useCallback(async () => {
    if (refreshBusy) return;
    setRefreshBusy(true);
    setRefreshNote("正在拉取 models.dev 目录…");
    try {
      const data: ProviderCatalogRefreshResult = await agentProviderCatalogRefresh();
      setRefreshNote(data.fromCache
        ? `拉取失败，已沿用上次缓存${data.error ? ` · ${data.error}` : ""}`
        : `已更新：${data.providerCount} 家供应商 / ${data.modelCount} 个模型`);
      onCatalogRefreshed?.();
    } catch (err) {
      setRefreshNote(`刷新失败 · ${(err as Error).message}`);
    } finally {
      setRefreshBusy(false);
    }
  }, [refreshBusy, onCatalogRefreshed]);

  const filtered = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    const rank = (provider: ProviderCatalogEntry) => (provider.configured ? 0 : provider.importable ? 1 : 2);
    return providers
      .filter((provider) => {
        if (filter === "oauth" && !provider.loginMethods?.includes("oauth")) return false;
        if (filter === "apikey" && !provider.loginMethods?.includes("apiKey")) return false;
        if (filter === "configured" && !provider.configured) return false;
        if (filter === "available" && provider.configured) return false;
        if (!text) return true;
        const haystack = [
          provider.id,
          provider.name,
          providerLabel(provider.id),
          provider.apiLabel,
          provider.auth?.apiKey?.name,
          ...(provider.auth?.apiKey?.envVars || []),
          ...(provider.sampleModels || []).map((model) => model.id),
        ].join(" ").toLowerCase();
        return haystack.includes(text);
      })
      .sort((a, b) => rank(a) - rank(b) || Number(b.modelCount) - Number(a.modelCount) || a.id.localeCompare(b.id));
  }, [providers, keyword, filter]);

  const configuredCount = providers.filter((provider) => provider.configured).length;

  return (
    <div className="prov-library">
      <div className="prov-library-head">
        <div>
          <strong>供应商库</strong>
          <p>
            共 {providers.length} 个供应商（{catalog?.totalModels || 0} 个模型），已添加 {configuredCount} 个。
            添加时接口地址、协议、上下文窗口和图片能力会自动带出，只需补 Key。
          </p>
          {modelsDev && (
            <p className="prov-library-source">
              目录来源：Pi 内置 {sources?.builtin?.count ?? "—"} 家
              · models.dev {modelsDev.count ? `${modelsDev.count} 家` : "未拉取"}
              {modelsDev.fetchedAt ? ` · 更新于 ${new Date(modelsDev.fetchedAt).toLocaleString()}` : ""}
              （{sourceStatusText(modelsDev.status)}）
            </p>
          )}
        </div>
        <div className="prov-library-search">
          <Icon name="search" size={12} />
          <input
            className="sp-input"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索供应商 / 模型 / 环境变量"
            aria-label="搜索内置供应商"
          />
          {keyword && <button type="button" className="btn-xs" onClick={() => setKeyword("")}>清空</button>}
          <button
            type="button"
            className="btn-sm"
            disabled={refreshBusy}
            title="从 models.dev 拉取最新供应商与模型（离线时沿用缓存）"
            onClick={runRefresh}
          >
            {refreshBusy ? "刷新中…" : "刷新目录"}
          </button>
        </div>
      </div>
      {(refreshNote || refreshing) && (
        <div className="prov-library-source model-feedback">
          {refreshing ? "目录读取中…" : refreshNote}
        </div>
      )}
      <div className="prov-library-filters">
        {([
          ["all", `全部 ${providers.length}`],
          ["oauth", "支持账号登录"],
          ["apikey", "API Key"],
          ["available", "未添加"],
          ["configured", `已添加 ${configuredCount}`],
        ] as Array<[string, string]>).map(([id, label]) => (
          <button key={id} type="button" className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>
        ))}
        {refreshing && <span className="prov-library-refreshing">目录读取中…</span>}
      </div>
      {catalog?.error && <div className="model-feedback">内置目录读取失败：{catalog.error}</div>}
      {!providers.length && <div className="model-provider-empty">内置供应商目录为空：请先运行 node scripts/tools/extract-pi-provider-catalog.mjs 生成目录。</div>}
      {providers.length > 0 && !filtered.length && <div className="model-provider-empty">没有匹配的供应商，换个关键词试试。</div>}
      <div className="prov-library-list">
        {(listExpanded ? filtered : filtered.slice(0, LIST_PAGE_SIZE)).map((provider) => {
          const identity = providerIdentity(provider.id);
          return (
            <div className={`prov-library-item${provider.configured ? " configured" : ""}`} key={provider.id}>
              <span className="prov-mark" title={identity.label}>
                <ProviderIcon provider={identity.icon} size={18} />
              </span>
              <div className="prov-library-main">
                <div className="prov-library-title">
                  <strong>{provider.name || provider.id}</strong>
                  <code>{provider.id}</code>
                  {provider.source === "models-dev" && <span className="sp-badge" title="来自 models.dev 目录（opencode 同款数据源）">models.dev</span>}
                  {provider.isDefault && <span className="sp-badge ok">默认</span>}
                  {provider.configured && <span className="sp-badge ok">已添加{provider.configuredModelCount ? ` · ${provider.configuredModelCount} 模型` : ""}</span>}
                  {provider.authError && <span className="sp-badge warn" title={provider.authError}>凭据失效</span>}
                </div>
                <div className="prov-library-meta">
                  <span>{provider.apiLabel || provider.api}</span>
                  <span>{CapabilitySummary({ provider })}</span>
                  {provider.auth?.apiKey?.envVars?.[0] && <code className="prov-env">{provider.auth.apiKey.envVars[0]}</code>}
                </div>
                <div className="prov-library-badges">
                  <LoginMethodBadge provider={provider} />
                  {!provider.importable && <span className="sp-badge warn" title={provider.importBlockReason || ""}>{provider.importBlockReason || "需专用配置"}</span>}
                </div>
              </div>
              <div className="prov-library-actions">
                <button type="button" className="btn-xs" onClick={() => setDetailId(provider.id)}>查看模型</button>
                {provider.configured && onEditExisting ? (
                  <button type="button" className="btn-xs" onClick={() => onEditExisting(provider.id)}>管理</button>
                ) : null}
                <button
                  type="button"
                  className="btn-sm primary"
                  disabled={!provider.importable}
                  title={provider.importable ? `添加 ${provider.name}` : provider.importBlockReason || ""}
                  onClick={() => setDetailId(provider.id)}
                >
                  <Icon name="plus" size={12} /> {provider.configured ? "补充模型" : "添加"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {filtered.length > LIST_PAGE_SIZE && (
        <button type="button" className="btn-xs prov-dialog-more" onClick={() => setListExpanded((value) => !value)}>
          {listExpanded ? "收起列表" : `显示全部 ${filtered.length} 个供应商（当前显示前 ${LIST_PAGE_SIZE} 个）`}
        </button>
      )}
      {detailId && (
        <ProviderImportDialog
          providerId={detailId}
          onClose={() => setDetailId("")}
          onImported={(result) => { setDetailId(""); onImported?.(result); }}
        />
      )}
    </div>
  );
}

export interface ProviderImportDialogProps {
  providerId: string;
  onClose?: () => void;
  onImported?: (result: ProviderImportResult) => void;
}

/** 详情端点（/api/agent/provider-catalog/:id）返回体。 */
interface ProviderDetailData {
  provider?: ProviderDetailEntry | null;
  configured?: { models?: ProviderCatalogModel[] } | null;
}

/** 目录刷新端点返回体。 */
interface ProviderCatalogRefreshResult {
  fromCache?: boolean;
  error?: string;
  providerCount?: number;
  modelCount?: number;
}

/**
 * 添加 / 查看内置供应商：先看完整模型清单（带能力），勾选要导入的模型并补 Key。
 * 模型能力（上下文窗口、图片、思考）全部来自目录，不需要手填。
 */
export function ProviderImportDialog({ providerId, onClose, onImported }: ProviderImportDialogProps) {
  const [detail, setDetail] = useState<ProviderDetailData | null>(null);
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [setDefault, setSetDefault] = useState(false);
  const [selected, setSelected] = useState<Set<string> | null>(null); // Set<modelId>；null = 全部
  const [expandAll, setExpandAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError("");
    agentProviderDetail(providerId)
      .then((result) => { if (alive) setDetail(result as ProviderDetailData); })
      .catch((err) => { if (alive) setError((err as Error).message || "读取失败"); });
    return () => { alive = false; };
  }, [providerId]);

  const provider = detail?.provider || null;
  // {detail && ...} 分支内与旧 JS 同一假设：detail 为真则 provider 非空（服务端契约），
  // detail.provider 缺失时旧 JS 同样在取属性处抛 TypeError，这里不做额外兜底。
  const detailProvider = provider as ProviderDetailEntry;
  const models: ProviderCatalogModel[] = Array.isArray(provider?.models) ? provider.models : [];
  const configuredIds = new Set((detail?.configured?.models || []).map((model) => model.id));
  const selectedIds = selected ? [...selected] : models.map((model) => model.id);
  const isSelected = (id: string) => (selected ? selected.has(id) : true);
  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current || models.map((model) => model.id));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAll = () => setSelected(null);
  const selectNone = () => setSelected(new Set<string>());
  const selectVisionOnly = () => setSelected(new Set(models.filter((model) => model.vision).map((model) => model.id)));

  const runImport = useCallback(async () => {
    if (!provider || busy) return;
    if (!selectedIds.length) { setMessage("至少选择一个模型"); return; }
    setBusy(true);
    setMessage("正在添加…");
    try {
      const result = await agentProviderImport({
        provider: provider.id,
        modelIds: selectedIds,
        apiKey: apiKey.trim(),
        enabled,
        setDefault,
        defaultModel: selectedIds[0],
      });
      const data = result as ProviderImportResult;
      setMessage(`已添加 ${data.name || provider.id} · 共 ${data.total} 个模型${data.defaultModel ? ` · 默认模型 ${data.defaultModel}` : ""}`);
      onImported?.(data);
    } catch (err) {
      setMessage(`添加失败 · ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [provider, busy, selectedIds, apiKey, enabled, setDefault, onImported]);

  const visibleModels = expandAll ? models : models.slice(0, 12);
  const oauthOnly = Boolean(provider?.auth?.oauth) && !provider?.auth?.apiKey;

  return (
    <div className="prov-dialog-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="prov-dialog" role="dialog" aria-modal="true" aria-label={provider ? `添加 ${provider.name}` : "添加内置供应商"}>
        <div className="prov-dialog-head">
          <div className="prov-dialog-title">
            <span className="prov-mark"><ProviderIcon provider={providerIdentity(providerId).icon} size={20} /></span>
            <div>
              <strong>{provider?.name || providerId}</strong>
              <span className="prov-dialog-sub">
                <code>{providerId}</code>
                {provider?.apiLabel ? ` · ${provider.apiLabel}` : ""}
                {provider?.modelCount ? ` · ${provider.modelCount} 个模型` : ""}
              </span>
            </div>
          </div>
          <button type="button" className="btn-xs" onClick={onClose}>关闭</button>
        </div>

        {error && <div className="model-feedback">读取失败 · {error}</div>}
        {!detail && !error && <div className="sp-note">正在读取模型清单…</div>}

        {detail && (
          <>
            <div className="prov-dialog-row">
              <span className="prov-dialog-label">接口地址</span>
              <code className="prov-dialog-value">{detailProvider.baseUrl || "（由运行环境决定）"}</code>
            </div>
            <div className="prov-dialog-row">
              <span className="prov-dialog-label">能力</span>
              <span className="prov-dialog-value">{CapabilitySummary({ provider: detailProvider })}{detailProvider.capabilities?.reasoningCount ? ` · ${detailProvider.capabilities.reasoningCount} 个支持思考` : ""}</span>
            </div>
            {!detailProvider.importable && (
              <div className="model-feedback">这个供应商不能一键添加：{detailProvider.importBlockReason}</div>
            )}
            <div className="prov-dialog-models">
              <div className="prov-dialog-models-head">
                <strong>模型（已选 {selectedIds.length} / {models.length}）</strong>
                <div className="prov-dialog-models-actions">
                  <button type="button" className="btn-xs" onClick={selectAll}>全选</button>
                  <button type="button" className="btn-xs" onClick={selectNone}>全不选</button>
                  <button type="button" className="btn-xs" onClick={selectVisionOnly} disabled={!detailProvider.capabilities?.visionCount}>仅支持图片</button>
                </div>
              </div>
              {models.length > 200 && (
                <div className="sp-note">该供应商共 {models.length} 个模型，单次最多导入 200 个，建议按需勾选常用模型。</div>
              )}
              <div className="prov-dialog-model-list">
                {visibleModels.map((model) => (
                  <label className={`prov-dialog-model${configuredIds.has(model.id) ? " existing" : ""}`} key={model.id}>
                    <input type="checkbox" checked={isSelected(model.id)} onChange={() => toggle(model.id)} />
                    <span className="prov-dialog-model-id">{model.name || model.id}<code>{model.id}</code></span>
                    <span className="prov-dialog-model-caps">
                      {model.contextWindow ? `${formatContext(model.contextWindow)} 上下文` : "上下文未知"}
                      {model.vision ? " · 图片" : ""}
                      {model.reasoning ? " · 思考" : ""}
                      {configuredIds.has(model.id) ? " · 已存在" : ""}
                    </span>
                  </label>
                ))}
              </div>
              {models.length > 12 && (
                <button type="button" className="btn-xs prov-dialog-more" onClick={() => setExpandAll((value) => !value)}>
                  {expandAll ? "收起" : `展开全部 ${models.length} 个模型`}
                </button>
              )}
            </div>
            <div className="prov-dialog-form">
              {oauthOnly ? (
                <div className="sp-note">
                  该供应商只支持<b>账号登录</b>（{detailProvider.auth?.oauth?.name || "浏览器授权"}），没有 API Key 入口。
                  请在终端执行 <code>pi auth login {detailProvider.id}</code> 完成浏览器授权，
                  再回规聚用「从本地 Pi 导入配置」把凭据带进来。
                </div>
              ) : (
                <label className="prov-dialog-field">
                  <span>API Key {detailProvider.auth?.apiKey?.envVars?.[0] ? `（环境变量 ${detailProvider.auth.apiKey.envVars[0]}）` : ""}</span>
                  <input
                    className="sp-input"
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={detailProvider.configured?.keyConfigured ? "已保存；留空保持不变" : "粘贴 API Key（只保存到服务端凭据文件）"}
                  />
                </label>
              )}
              <div className="prov-dialog-checks">
                <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 启用该供应商</label>
                <label><input type="checkbox" checked={setDefault} onChange={(event) => setSetDefault(event.target.checked)} /> 设为默认模型供应商</label>
              </div>
            </div>
            <div className="prov-dialog-actions">
              <button type="button" className="btn-sm" onClick={onClose}>取消</button>
              <button type="button" className="btn-sm primary" onClick={runImport} disabled={busy || !detailProvider.importable || !selectedIds.length}>
                {busy ? "添加中…" : `添加 ${selectedIds.length} 个模型`}
              </button>
              {message && <span className="sp-auth-msg">{message}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default ProviderLibrary;
