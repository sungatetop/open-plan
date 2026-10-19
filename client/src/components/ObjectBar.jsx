import React, { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "./Icon.jsx";
import {
  listArtifacts,
  listSkills,
  listMcpServers,
  listMemoryProposals,
  listAgentRuntimes,
  getStatus,
  browserState,
} from "../api.js";
import { 聚合对象栏 } from "../object-aggregation.js";

/**
 * 对象栏（Qoder 对标 P1-8，收敛版）。
 *
 * 只读汇总「本轮对象」：产出 / 来源 / 技能与 MCP / 网页查阅 / 记忆，
 * 另附环境信息与后台调度。全部数据自取（复用既有只读端点，无新增后端接口），
 * 因此可以整体挂在右栏作为第三个页签，而不改动对话流、任务中心等核心组件。
 *
 * 由 App 侧 `flag("qoderObjectBar")` 门控：开关关闭时该组件不会被渲染。
 */
export default function 对象栏({ workspace = "", projectId = "", model = "", references = [], clientId = "", threadId = "", onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const 刷新 = useCallback(async () => {
    setLoading(true);
    setError("");
    // 单个数据源失败不应让整栏空白：各自兜底为空，最后只要有一个成功就正常渲染。
    const 安全 = async (fn, fallback) => {
      try { return await fn(); } catch { return fallback; }
    };
    const [产出, 技能, MCP, 记忆, 运行时, 状态, 浏览器] = await Promise.all([
      安全(() => listArtifacts({ cwd: workspace, projectId }), null),
      安全(() => listSkills(), null),
      安全(() => listMcpServers(), null),
      安全(() => listMemoryProposals(workspace, "", projectId), null),
      安全(() => listAgentRuntimes(), null),
      安全(() => getStatus(), null),
      安全(() => (clientId ? browserState(clientId, threadId) : null), null),
    ]);
    if (!产出 && !技能 && !MCP && !记忆 && !运行时 && !状态) {
      setError("对象数据读取失败，请检查服务端连接");
      setLoading(false);
      return;
    }
    setData({
      artifacts: 产出?.artifacts || [],
      skills: 技能?.skills || [],
      mcpServers: MCP?.servers || [],
      memoryProposals: 记忆?.proposals || [],
      scheduler: 运行时?.scheduler || null,
      runtimeInfo: 状态
        ? ["Pi " + (状态.piPackageVersion || "?"), 状态.platform || ""].filter(Boolean).join(" · ")
        : "",
      browser: 浏览器?.state || null,
    });
    setLoading(false);
  }, [workspace, projectId, clientId, threadId]);

  useEffect(() => { void 刷新(); }, [刷新]);

  const 视图 = useMemo(() => 聚合对象栏({
    artifacts: data?.artifacts || [],
    references,
    skills: data?.skills || [],
    mcpServers: data?.mcpServers || [],
    memoryProposals: data?.memoryProposals || [],
    browser: data?.browser || null,
    scheduler: data?.scheduler || null,
    environment: { workspace, model, runtime: data?.runtimeInfo || "" },
  }), [data, references, workspace, model]);

  const 空 = !loading && !error && 视图.groups.every((group) => group.count === 0) && 视图.background.count === 0;

  return (
    <div className="object-bar">
      <div className="object-bar-toolbar">
        <span className="object-bar-summary" title="本轮对象总数（产出 + 来源 + 记忆）">
          <Icon name="layers" size={13} /> 本轮对象 <b>{视图.objectCount}</b>
        </span>
        <span className="object-bar-actions">
          <button className="btn-icon" onClick={() => void 刷新()} disabled={loading} title="刷新对象栏" aria-label="刷新对象栏">
            <Icon name={loading ? "loading" : "refresh"} size={14} />
          </button>
          {onClose && <button className="btn-icon" onClick={onClose} title="隐藏对象栏" aria-label="隐藏对象栏"><Icon name="close" size={14} /></button>}
        </span>
      </div>

      {error && <div className="object-bar-error" role="alert"><Icon name="warning" size={13} /> {error}</div>}
      {loading && !data && <div className="object-bar-loading"><Icon name="loading" size={14} /> 正在汇总本轮对象…</div>}
      {空 && <div className="object-bar-empty">本轮还没有可汇总的对象。产出、引用、技能与记忆出现后会自动汇总到这里。</div>}

      {!空 && (
        <div className="object-bar-body">
          {视图.groups.map((group) => (
            <section key={group.key} className="object-group" data-empty={group.count === 0 ? "1" : "0"}>
              <header className="object-group-head">
                <Icon name={group.icon} size={13} />
                <span>{group.label}</span>
                <b>{group.count}</b>
              </header>
              {group.count === 0 ? (
                <div className="object-group-none">暂无</div>
              ) : (
                <ul className="object-list">
                  {group.items.map((item, index) => (
                    <li key={`${group.key}-${index}`} className="object-item" title={item.name}>
                      <span className="object-item-name">{item.name}</span>
                      {item.meta && <span className="object-item-meta">{item.meta}</span>}
                    </li>
                  ))}
                  {group.hidden > 0 && <li className="object-item object-item-more">还有 {group.hidden} 项未展开</li>}
                </ul>
              )}
            </section>
          ))}

          <section className="object-group" data-empty="0">
            <header className="object-group-head">
              <Icon name="terminal" size={13} />
              <span>后台进程</span>
              <b>{视图.background.count}</b>
            </header>
            {视图.background.count === 0 ? (
              <div className="object-group-none">空闲</div>
            ) : (
              <ul className="object-list">
                {视图.background.items.map((item, index) => (
                  <li key={`bg-${index}`} className={`object-item ${item.status === "running" ? "running" : ""}`} title={item.name}>
                    <span className="object-item-name">{item.name}</span>
                    {item.meta && <span className="object-item-meta">{item.meta}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="object-group object-group-env" data-empty="0">
            <header className="object-group-head"><Icon name="gear" size={13} /><span>环境</span></header>
            <ul className="object-list">
              <li className="object-item"><span className="object-item-name">工作区</span><span className="object-item-meta">{视图.environment.workspace}</span></li>
              <li className="object-item"><span className="object-item-name">模型</span><span className="object-item-meta">{视图.environment.model}</span></li>
              <li className="object-item"><span className="object-item-name">运行时</span><span className="object-item-meta">{视图.environment.runtime}</span></li>
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
