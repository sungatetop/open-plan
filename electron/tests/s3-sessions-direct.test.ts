/**
 * S3-1 会话族直调对拍（agent-sessions-direct.ts + session-files.ts）。
 *
 * 覆盖面（行号锚点均指 server/index.mjs）：
 *   - manifest 锚点：9 条 op:sessions:* 通道与 DESKTOP_CHANNELS 清单一致、路由指向已审计路径；
 *   - 存储域（session-files.ts，L1994-2044/L2739-3034/L3547-3602/L3714-3745 逐点）：
 *     findSessionFile / listSessionFiles（去重排序）/ 指纹缓存 / sessionMetaFor
 *     （标题清洗 + isOaw）/ updateSessionHeader / parseJsonl / cleanSessionTitle /
 *     compactSessionEntryForChat；
 *   - 路由编排（agent-sessions-direct.ts，L3367-3396/L3606-3895 逐点）：
 *     9 通道校验规则（400 文案逐字）、404/500、响应形状、过滤与联接逻辑；
 *   - 会话族为文件族共享态：与 sidecar 读写同一批 JSONL，直调即时语义等价（无 S2 空态过渡）。
 *
 * 模块级重状态隔离（B2-2 先例）：beforeAll stubEnv（OAW_SESSIONS_DIR/OAW_SESSIONS_META_STORE
 * =tmp）后动态 import——session-files 模块加载期冻结 env 锚点，静态 import 会错过 stub。
 */
import { describe, expect, test, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as SessionFilesModule from "../src/main/backend/agent/session-files";
import type * as SessionsDirectModule from "../src/main/ipc/agent-sessions-direct";
import { DESKTOP_CHANNELS, type InvokeEnvelope } from "../src/shared/protocol/channels";

let sf: typeof SessionFilesModule;
let svc: typeof SessionsDirectModule;
let tmpSessions = "";
let tmpMetaStore = "";

beforeAll(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "s3sessions-"));
  tmpSessions = path.join(base, "sessions");
  tmpMetaStore = path.join(base, "meta", "sessions-meta.json");
  fs.mkdirSync(tmpSessions, { recursive: true });
  vi.stubEnv("OAW_SESSIONS_DIR", tmpSessions);
  vi.stubEnv("OAW_SESSIONS_META_STORE", tmpMetaStore);
  sf = await import("../src/main/backend/agent/session-files");
  svc = await import("../src/main/ipc/agent-sessions-direct");
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** deps 桩：runs/projects/workspace 三域联接面（会话族编排的跨域依赖）。 */
function makeDeps(overrides: Partial<SessionsDirectModule.AgentSessionsDirectDeps> = {}): SessionsDirectModule.AgentSessionsDirectDeps & {
  listRunSummaries: ReturnType<typeof vi.fn>;
  getProject: ReturnType<typeof vi.fn>;
  getProjectForWorkspace: ReturnType<typeof vi.fn>;
  getWorkspace: ReturnType<typeof vi.fn>;
  normalizeWorkspace: ReturnType<typeof vi.fn>;
} {
  return {
    listRunSummaries: vi.fn(() => []),
    getProject: vi.fn(() => null),
    getProjectForWorkspace: vi.fn(() => null),
    getWorkspace: vi.fn(() => "D:\\默认工作区"),
    normalizeWorkspace: vi.fn((dir: unknown) => (dir ? String(dir) : null)),
    ...overrides
  } as never;
}

function invoke(channel: SessionsDirectModule.AgentSessionsDirectChannel, envelope: InvokeEnvelope | undefined, deps = makeDeps()) {
  return svc.invokeAgentSessionsDirect(channel, envelope, deps);
}

/** 写一个会话 JSONL 文件（header + 可选 entries），返回文件名。 */
function writeSession(id: string, headerExtra: Record<string, unknown> = {}, lines: unknown[] = []): string {
  const header = { type: "header", id, sessionId: id, threadId: id, cwd: tmpSessions, created: "2026-01-01T00:00:00.000Z", label: "", pinned: false, frozen: false, ...headerExtra };
  const body = [JSON.stringify(header), ...lines.map((l) => JSON.stringify(l))].join("\n") + "\n";
  fs.writeFileSync(path.join(tmpSessions, `${id}.jsonl`), body, "utf8");
  return `${id}.jsonl`;
}

function userMessage(text: string, id = "m1"): Record<string, unknown> {
  return { type: "message", id, parentId: null, message: { role: "user", content: text } };
}

describe("S3-1 manifest 锚点", () => {
  test("9 条通道全部在 DESKTOP_CHANNELS 且路由指向 /api/sessions* 已审计路径", () => {
    expect(svc.AGENT_SESSIONS_DIRECT_CHANNELS).toHaveLength(9);
    const expectedRoutes: Record<string, { method: string; path: string }> = {
      "op:sessions:list": { method: "GET", path: "/api/sessions" },
      "op:sessions:create": { method: "POST", path: "/api/sessions" },
      "op:sessions:get": { method: "GET", path: "/api/sessions/:id" },
      "op:sessions:delete": { method: "DELETE", path: "/api/sessions/:id" },
      "op:sessions:batch-delete": { method: "POST", path: "/api/sessions/batch-delete" },
      "op:sessions:rename": { method: "POST", path: "/api/sessions/:id/rename" },
      "op:sessions:pin": { method: "POST", path: "/api/sessions/:id/pin" },
      "op:sessions:freeze": { method: "POST", path: "/api/sessions/:id/freeze" },
      "op:sessions:fork": { method: "POST", path: "/api/sessions/:id/fork" }
    };
    for (const channel of svc.AGENT_SESSIONS_DIRECT_CHANNELS) {
      expect(DESKTOP_CHANNELS[channel as keyof typeof DESKTOP_CHANNELS]).toEqual(expectedRoutes[channel]);
    }
  });
});

describe("S3-1 存储域：findSessionFile / listSessionFiles（server L2739-2973）", () => {
  test("findSessionFile：文件名精确匹配 → 首行 sessionId 匹配", () => {
    writeSession("s-abc");
    expect(sf.findSessionFile("s-abc")?.fileName).toBe("s-abc.jsonl");
    // id 与文件名不一致：按首行 header.sessionId 匹配
    const renamed = path.join(tmpSessions, "legacy-name.jsonl");
    fs.writeFileSync(renamed, `${JSON.stringify({ type: "header", id: "s-xyz", sessionId: "s-xyz" })}\n`, "utf8");
    expect(sf.findSessionFile("s-xyz")?.fileName).toBe("legacy-name.jsonl");
    expect(sf.findSessionFile("s-none")).toBeNull();
  });

  test("listSessionFiles：只收 .jsonl、mtime 新→旧、同 id 去重新目录优先", async () => {
    const a = path.join(tmpSessions, "dup.jsonl");
    fs.writeFileSync(a, `${JSON.stringify({ id: "dup-1", sessionId: "dup-1" })}\n`, "utf8");
    // 同 id 的第二份（模拟迁移残留）：应被去重
    const b = path.join(tmpSessions, "sub");
    fs.mkdirSync(b, { recursive: true });
    const c = path.join(b, "dup-copy.jsonl");
    fs.writeFileSync(c, `${JSON.stringify({ id: "dup-1", sessionId: "dup-1" })}\n`, "utf8");
    fs.utimesSync(c, new Date(), new Date(Date.now() + 50));
    const files = sf.listSessionFiles();
    const dupFiles = files.filter((f) => f.fileName.startsWith("dup"));
    expect(dupFiles).toHaveLength(1);
    expect(dupFiles[0]!.fileName).toBe("dup-copy.jsonl"); // mtime 新者优先
    // 非 .jsonl 不收集
    fs.writeFileSync(path.join(tmpSessions, "no.txt"), "x", "utf8");
    expect(sf.listSessionFiles().some((f) => f.fileName === "no.txt")).toBe(false);
  });

  test("readSessionTextCached：mtime+size 指纹失效后重读", () => {
    const p = path.join(tmpSessions, "fp.jsonl");
    fs.writeFileSync(p, "line1\n", "utf8");
    expect(sf.readSessionTextCached(p)).toBe("line1\n");
    fs.writeFileSync(p, "line1\nline2\n", "utf8");
    expect(sf.readSessionTextCached(p)).toBe("line1\nline2\n");
    // 文件被删：回空串（不抛）
    fs.unlinkSync(p);
    expect(sf.readSessionTextCached(p)).toBe("");
  });

  test("updateSessionHeader：patch 合并 + updatedAt 刷新 + 落盘生效", async () => {
    writeSession("s-upd", { label: "旧标题" });
    const result = sf.updateSessionHeader("s-upd", { label: "新标题", pinned: true });
    expect(result.ok).toBe(true);
    const header = result.header as Record<string, any>;
    expect(header.label).toBe("新标题");
    expect(header.pinned).toBe(true);
    expect(typeof header.updatedAt).toBe("string");
    // 落盘可查（绕开缓存直读磁盘）
    const raw = JSON.parse(fs.readFileSync(path.join(tmpSessions, "s-upd.jsonl"), "utf8").split("\n")[0]!);
    expect(raw.label).toBe("新标题");
  });

  test("updateSessionHeader：not found → {ok:false,status:404}；空文件 → 400 empty file", () => {
    expect(sf.updateSessionHeader("s-missing", { label: "x" })).toEqual({ ok: false, status: 404, error: "not found" });
    fs.writeFileSync(path.join(tmpSessions, "s-empty.jsonl"), "", "utf8");
    // 空文件名匹配 findSessionFile("s-empty") → startsWith 命中自身
    const result = sf.updateSessionHeader("s-empty", { label: "x" });
    expect(result).toEqual({ ok: false, status: 400, error: "empty file" });
  });

  test("parseJsonl：跳过空行与坏行", () => {
    expect(sf.parseJsonl('{"a":1}\n\nbroken\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe("S3-1 存储域：sessionMetaFor 与标题清洗（server L2863-2954/L3547-3602）", () => {
  test("isOaw（项目内会话）+ 用户消息标题提取", () => {
    writeSession("s-meta", {}, [userMessage("帮我整理这个文档", "m1")]);
    const found = sf.findSessionFile("s-meta")!;
    const meta = sf.sessionMetaFor(found)!;
    expect(meta.isOaw).toBe(true); // storeDir === SESSIONS_DIR
    expect(meta.hasUserMessage).toBe(true);
    expect(meta.title).toBe("帮我整理这个文档");
  });

  test("系统提示消息跳过标题（isSystemHintMessage），取下一条真实用户消息", () => {
    writeSession("s-hint", {}, [
      userMessage("[模式: 对话] 你可以调用所有 skills 和工具生成新文件（文档/HTML/PPT等），产物保存到当前工作区。", "h1"),
      userMessage("把报告导出为 docx", "h2")
    ]);
    const meta = sf.sessionMetaFor(sf.findSessionFile("s-hint")!)!;
    expect(meta.title).toBe("把报告导出为 docx");
  });

  test("TaskEnvelope 目标提取（envelopeGoal 分支）", () => {
    writeSession("s-goal", {}, [
      userMessage("## 当前任务\n目标：生成季度总结 PPT\n模式：对话\n动态上下文：……", "g1")
    ]);
    const meta = sf.sessionMetaFor(sf.findSessionFile("s-goal")!)!;
    expect(meta.title).toBe("生成季度总结 PPT");
  });

  test("cleanSessionTitle：前缀清洗 + 长文本句子截断（>50 字符）", () => {
    expect(sf.cleanSessionTitle("[当前打开文件:报告.docx] 帮我修改格式")).toBe("帮我修改格式");
    expect(sf.cleanSessionTitle("")).toBe("");
    const long = "这是一段特别长的任务描述没有标点符号超过五十个字了继续往下写还有很多内容需要被截断处理掉尾巴请再长一点凑够字符数";
    expect(long.length).toBeGreaterThan(50);
    expect(sf.cleanSessionTitle(long)).toBe(long.slice(0, 50) + "…");
  });

  test("buildSessionMeta：isOpenPlan 判定分支（storeDir 非 SESSIONS_DIR + cwd 无标记 → false；cwd 含 open-plan → true）", () => {
    const external = { fileName: "x.jsonl", fullPath: "D:\\elsewhere\\x.jsonl", storeDir: "D:\\elsewhere", mtime: 1, size: 10 };
    expect(sf.buildSessionMeta(external, { cwd: "D:\\其他目录" }, "").isOaw).toBe(false);
    expect(sf.buildSessionMeta(external, { cwd: "D:\\open-plan\\子目录" }, "").isOaw).toBe(true);
    expect(sf.buildSessionMeta(external, { cwd: "D:\\Open Plan\\子目录" }, "").isOaw).toBe(true);
    // isProjectSession（storeDir === SESSIONS_DIR）短路为 true
    expect(sf.buildSessionMeta(external, {}, "").isProjectSession).toBe(false);
  });

  test("isBootstrapSessionTitle：venv activate 标题识别", () => {
    expect(sf.isBootstrapSessionTitle('d:\\proj\\.venv\\Scripts\\activate.bat')).toBe(true);
    expect(sf.isBootstrapSessionTitle("正常标题")).toBe(false);
    // venv 标题会话从列表剔除
    writeSession("s-venv", {}, [userMessage('d:\\env\\.venv\\Scripts\\activate.bat', "v1")]);
    const meta = sf.sessionMetaFor(sf.findSessionFile("s-venv")!)!;
    expect(sf.isBootstrapSessionTitle(meta.title)).toBe(true);
  });

  test("非项目目录 + cwd 无标记 → isOaw=false 已由 buildSessionMeta 覆盖；此处验证项目内空会话保留", () => {
    // writeSession 的文件在 SESSIONS_DIR 内 → isProjectSession=true 短路 isOaw
    writeSession("s-ext", { cwd: "D:\\其他目录" }, [userMessage("外部消息", "e1")]);
    const meta = sf.sessionMetaFor(sf.findSessionFile("s-ext")!)!;
    expect(meta.isOaw).toBe(true); // isProjectSession 短路（server L2906-2908 同）
  });

  test("compactSessionEntryForChat：长文本折叠 / 图片替换 / toolResult 过滤", () => {
    const long = "x".repeat(12001);
    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "image", url: "blob:x" },
          { type: "text", text: long },
          { type: "toolCall", input: long }
        ]
      }
    };
    const compacted = sf.compactSessionEntryForChat(entry) as any;
    expect(compacted.message.content[0]).toEqual({ type: "text", text: "[历史图片已省略，可重新打开原会话查看]" });
    expect(compacted.message.content[1].text).toContain("…[历史输出已折叠]");
    expect(compacted.message.content[2].input).toContain("…[历史输出已折叠]");
    const toolResult = sf.compactSessionEntryForChat({ type: "message", message: { role: "toolResult", content: [{ type: "image" }, { type: "text", text: long }] } }) as any;
    // server 忠实语义：数组 content 先经 image→text 替换（第一个 if），再经 toolResult
    // 的 filter text（第二个 if）——替换后的图片文本被保留，共 2 条
    expect(toolResult.message.content).toHaveLength(2);
    expect(toolResult.message.content[0]).toEqual({ type: "text", text: "[历史图片已省略，可重新打开原会话查看]" });
    expect(toolResult.message.content[1].text).toContain("…[历史输出已折叠]");
    // 非 message entry 原样返回
    expect(sf.compactSessionEntryForChat({ type: "header" } as any)).toEqual({ type: "header" });
  });
});

describe("S3-1 op:sessions:list（server L3606-3683）", () => {
  test("空态：无过滤全量返回，runStatus 缺省 idle", async () => {
    writeSession("s-l1", { label: "列表一" }, [userMessage("消息一", "lm1")]);
    const result = await invoke("op:sessions:list", {});
    expect(result.ok).toBe(true);
    const row = (result.data as any).sessions.find((s: any) => s.id === "s-l1");
    expect(row).toMatchObject({
      id: "s-l1", threadId: "s-l1", label: "列表一", title: "列表一",
      runStatus: "idle", runId: null, mode: "", artifactCount: 0,
      pinned: false, frozen: false, fileName: "s-l1.jsonl"
    });
    expect(typeof row.modified).toBe("number");
  });

  test("runStatus/pinned/frozen/projectId 过滤 + runs 联接（每会话最新一条，runs 按新→旧）", async () => {
    writeSession("s-l2", { label: "列表二", pinned: true }, [userMessage("消息二", "lm2")]);
    const runs = [
      { id: "r2", sessionId: "s-l2", status: "running", mode: "task", startedAt: "2026-01-03T00:00:00.000Z", artifactCount: 1, threadId: "t-new" },
      { id: "r1", sessionId: "s-l2", status: "finished", mode: "chat", startedAt: "2026-01-02T00:00:00.000Z", finishedAt: "2026-01-02T01:00:00.000Z", artifactCount: 3, threadId: "t-old" }
    ];
    const result = await invoke("op:sessions:list", { query: { runStatus: "running" } }, makeDeps({ listRunSummaries: vi.fn(() => runs) }));
    const row = (result.data as any).sessions.find((s: any) => s.id === "s-l2");
    expect(row).toMatchObject({ runStatus: "running", runId: "r2", mode: "task", lastRunAt: "2026-01-03T00:00:00.000Z", artifactCount: 1, threadId: "s-l2" });
    // pinned=true 过滤：s-l1（未 pin）被剔除
    const pinned = await invoke("op:sessions:list", { query: { pinned: "true" } });
    expect((pinned.data as any).sessions.some((s: any) => s.id === "s-l1")).toBe(false);
    expect((pinned.data as any).sessions.some((s: any) => s.id === "s-l2")).toBe(true);
    // frozen 过滤
    writeSession("s-l3", { label: "列表三", frozen: true }, [userMessage("消息三", "lm3")]);
    const frozen = await invoke("op:sessions:list", { query: { frozen: "true" } });
    expect((frozen.data as any).sessions.map((s: any) => s.id)).toContain("s-l3");
    // runStatus 无匹配 → 空结果（finished 只匹配 s-l2 的旧 run，但 latestRun 是 r2 running）
    const finished = await invoke("op:sessions:list", { query: { runStatus: "finished" } }, makeDeps({ listRunSummaries: vi.fn(() => runs) }));
    expect((finished.data as any).sessions.some((s: any) => s.id === "s-l2")).toBe(false);
  });

  test("projectId 过滤走项目联接（buildSessionMeta 无 projectId 字段 → getProject(undefined) → cwd fallback 命中）", async () => {
    writeSession("s-l4", { label: "列表四", projectId: "p-1" }, [userMessage("消息四", "lm4")]);
    const deps = makeDeps({
      getProject: vi.fn((id: unknown) => (id === "p-1" ? { id: "p-1", name: "项目一", type: "office", status: "active" } : null)),
      getProjectForWorkspace: vi.fn((cwd: unknown) => (cwd === tmpSessions ? { id: "p-1", name: "项目一", type: "office", status: "active" } : null))
    });
    const hit = await invoke("op:sessions:list", { query: { projectId: "p-1" } }, deps);
    expect((hit.data as any).sessions.map((s: any) => s.id)).toContain("s-l4");
    const row = (hit.data as any).sessions.find((s: any) => s.id === "s-l4");
    expect(row).toMatchObject({ projectId: "p-1", projectName: "项目一" });
    const miss = await invoke("op:sessions:list", { query: { projectId: "p-other" } }, deps);
    expect((miss.data as any).sessions.map((s: any) => s.id)).not.toContain("s-l4");
  });

  test("fileFilter：会话内容提及才保留；无用户消息且无 label 的非项目会话剔除", async () => {
    writeSession("s-l5", {}, [userMessage("请处理 年报.xlsx 的数据", "lf1")]);
    const hit = await invoke("op:sessions:list", { query: { file: "年报.xlsx" } });
    expect((hit.data as any).sessions.map((s: any) => s.id)).toContain("s-l5");
    const miss = await invoke("op:sessions:list", { query: { file: "别的文件.docx" } });
    expect((miss.data as any).sessions.map((s: any) => s.id)).not.toContain("s-l5");
    // 空会话（无 label/无用户消息）：项目内（isProjectSession=true）保留——server 注释
    // "项目内会话即使尚未发送首条消息也保留"（server L3639-3641）
    writeSession("s-empty2");
    const all = await invoke("op:sessions:list", {});
    expect((all.data as any).sessions.map((s: any) => s.id)).toContain("s-empty2");
  });
});

describe("S3-1 op:sessions:create（server L3686-3712）", () => {
  test("ok：header JSONL 落盘 + 响应形状逐点", async () => {
    const deps = makeDeps({ getProjectForWorkspace: vi.fn(() => ({ id: "p-9" })) });
    const result = await invoke("op:sessions:create", { body: { cwd: "D:\\工作区甲", label: " 新会话 ", frozen: true } }, deps);
    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data).toMatchObject({ fileName: `${data.id}.jsonl`, cwd: "D:\\工作区甲", projectId: "p-9", status: "idle", pinned: false, frozen: true });
    expect(typeof data.created).toBe("string");
    // 落盘 header 逐点
    const raw = JSON.parse(fs.readFileSync(path.join(tmpSessions, data.fileName), "utf8").split("\n")[0]!);
    expect(raw).toMatchObject({ type: "header", id: data.id, sessionId: data.id, threadId: data.id, cwd: "D:\\工作区甲", projectId: "p-9", label: "新会话", pinned: false, frozen: true });
    expect(raw.updatedAt).toBe(raw.created);
  });

  test("cwd 缺省走 getWorkspace；label 缺省空串；frozen 缺省 false", async () => {
    const result = await invoke("op:sessions:create", { body: {} });
    const data = result.data as any;
    expect(data.cwd).toBe("D:\\默认工作区");
    expect(data.frozen).toBe(false);
    const raw = JSON.parse(fs.readFileSync(path.join(tmpSessions, data.fileName), "utf8").split("\n")[0]!);
    expect(raw.label).toBe("");
  });
});

describe("S3-1 op:sessions:get（server L3748-3819）", () => {
  test("404：找不到会话", async () => {
    expect(await invoke("op:sessions:get", { params: { id: "nope" } })).toEqual({ ok: false, status: 404, data: { error: "not found" } });
  });

  test("全量视图：entries/tree/leafId/info 形状逐点", async () => {
    writeSession("s-g1", { label: "详情会话" }, [
      { type: "message", id: "e1", parentId: null },
      { type: "message", id: "e2", parentId: "e1" }
    ]);
    const result = await invoke("op:sessions:get", { params: { id: "s-g1" } });
    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data.entries.map((e: any) => e.id)).toEqual(["e1", "e2"]);
    expect(data.tree).toEqual({ null: ["e1"], e1: ["e2"] });
    expect(data.leafId).toBe("e2"); // 首个无子节点 entry
    expect(data.info).toMatchObject({
      id: "s-g1", cwd: tmpSessions, label: "详情会话", pinned: false, frozen: false,
      parentSessionId: null, chatView: false, fileName: "s-g1.jsonl"
    });
    expect(typeof data.info.modified).toBe("number");
    expect(data.info.historyTotal).toBeUndefined();
  });

  test("chat 视图：尾部窗口 + 折叠 + history 簿记（chatLimit 下限 80：limit=85 → 85 条窗）", async () => {
    const lines = Array.from({ length: 90 }, (_, i) => ({ type: "message", id: `c${i}`, parentId: i ? `c${i - 1}` : null, message: { role: "assistant", content: "y".repeat(13000) } }));
    writeSession("s-g2", {}, lines);
    const result = await invoke("op:sessions:get", { params: { id: "s-g2" }, query: { view: "chat", limit: "85" } });
    const data = result.data as any;
    expect(data.info.chatView).toBe(true);
    expect(data.info.historyTotal).toBe(90);
    expect(data.info.historyEnd).toBe(90);
    expect(data.info.historyStart).toBe(5);
    expect(data.info.historyHasMore).toBe(true);
    expect(data.entries).toHaveLength(85);
    expect(data.entries[0]!.id).toBe("c5");
    expect(data.entries[0]!.message.content).toContain("…[历史输出已折叠]");
    expect(data.tree).toEqual({});
    // before 游标翻页
    const before = await invoke("op:sessions:get", { params: { id: "s-g2" }, query: { view: "chat", limit: "85", before: "5" } });
    expect((before.data as any).info).toMatchObject({ historyStart: 0, historyEnd: 5, historyHasMore: false });
    expect((before.data as any).entries.map((e: any) => e.id)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
  });
});

describe("S3-1 op:sessions:delete / batch-delete（server L3822-3866）", () => {
  test("delete：ok 删文件；404 缺失", async () => {
    writeSession("s-d1");
    const ok = await invoke("op:sessions:delete", { params: { id: "s-d1" } });
    expect(ok).toEqual({ ok: true, status: 200, data: { ok: true } });
    expect(fs.existsSync(path.join(tmpSessions, "s-d1.jsonl"))).toBe(false);
    expect(await invoke("op:sessions:delete", { params: { id: "s-d1" } })).toEqual({ ok: false, status: 404, data: { error: "not found" } });
  });

  test("batch-delete：400 无 ids；活跃运行跳过；missing 收集；去重", async () => {
    const noIds = await invoke("op:sessions:batch-delete", { body: { ids: [] } });
    expect(noIds).toEqual({ ok: false, status: 400, data: { error: "ids required" } });

    writeSession("s-b1");
    writeSession("s-b2");
    writeSession("s-b3");
    const deps = makeDeps({
      listRunSummaries: vi.fn(() => [{ sessionId: "s-b2", status: "running" }])
    });
    const result = await invoke("op:sessions:batch-delete", { body: { ids: ["s-b1", "s-b2", "s-b3", "s-b1", " ", "s-gone"] } }, deps);
    expect(result.data).toEqual({
      ok: true,
      deleted: ["s-b1", "s-b3"],
      skipped: [{ id: "s-b2", reason: "会话正在运行" }],
      missing: ["s-gone"]
    });
    expect(fs.existsSync(path.join(tmpSessions, "s-b1.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(tmpSessions, "s-b2.jsonl"))).toBe(true);
    // runs 消费 limit:500
    expect(deps.listRunSummaries).toHaveBeenCalledWith({ limit: 500 });
  });

  // 未做：unlink 失败 → skipped 分支的真实 IO 注入（server L3848-3850）。Node 在
  // Windows 以 FILE_SHARE_DELETE 打开文件，句柄占用无法阻断 unlink；该分支为
  // catch → skipped.push(error.message) 直录语义，不单独造 flaky 用例。
});

describe("S3-1 rename / pin / freeze（server L3869-3895）", () => {
  test("rename：ok {ok:true,label}；404 data 透传 result", async () => {
    writeSession("s-r1", { label: "旧名" });
    const ok = await invoke("op:sessions:rename", { params: { id: "s-r1" }, body: { label: " 新名 " } });
    expect(ok).toEqual({ ok: true, status: 200, data: { ok: true, label: "新名" } });
    const missing = await invoke("op:sessions:rename", { params: { id: "s-none" }, body: { label: "x" } });
    expect(missing).toEqual({ ok: false, status: 404, data: { ok: false, status: 404, error: "not found" } });
  });

  test("pin：缺省 true；pinned:false 透传", async () => {
    writeSession("s-p1");
    expect(await invoke("op:sessions:pin", { params: { id: "s-p1" }, body: {} }))
      .toEqual({ ok: true, status: 200, data: { ok: true, sessionId: "s-p1", pinned: true } });
    expect(await invoke("op:sessions:pin", { params: { id: "s-p1" }, body: { pinned: false } }))
      .toEqual({ ok: true, status: 200, data: { ok: true, sessionId: "s-p1", pinned: false } });
  });

  test("freeze：缺省冻结 + 默认快照形状；解冻保留原快照", async () => {
    writeSession("s-f1", { projectId: "p-5" });
    const freeze = await invoke("op:sessions:freeze", { params: { id: "s-f1" }, body: {} });
    const fdata = (freeze.data as any);
    expect(fdata).toMatchObject({ ok: true, sessionId: "s-f1", frozen: true, freezeReason: "用户冻结会话" });
    expect(fdata.contextSnapshot).toMatchObject({ workspace: tmpSessions, projectId: "p-5", source: "session-freeze" });
    expect(typeof fdata.contextSnapshot.capturedAt).toBe("string");
    // 自定义 reason + snapshot
    const custom = await invoke("op:sessions:freeze", { params: { id: "s-f1" }, body: { reason: "切会话", snapshot: { capturedAt: "x", source: "custom" } } });
    expect((custom.data as any).freezeReason).toBe("切会话");
    expect((custom.data as any).contextSnapshot).toEqual({ capturedAt: "x", source: "custom" });
    // 解冻：frozen=false、freezeReason 清空、contextSnapshot 保留
    const unfreeze = await invoke("op:sessions:freeze", { params: { id: "s-f1" }, body: { frozen: false } });
    expect((unfreeze.data as any)).toMatchObject({ ok: true, frozen: false, freezeReason: "", contextSnapshot: { source: "custom" } });
    // 404
    const missing = await invoke("op:sessions:freeze", { params: { id: "s-none" }, body: {} });
    expect(missing).toEqual({ ok: false, status: 404, data: { ok: false, status: 404, error: "not found" } });
  });
});

describe("S3-1 op:sessions:fork（server L3367-3396）", () => {
  test("ok：新 JSONL 落盘 + 响应形状 + 分支 header 字段", async () => {
    writeSession("s-o1", { label: "源会话", projectId: "p-3" }, [userMessage("源消息", "o1")]);
    const result = await invoke("op:sessions:fork", { params: { id: "s-o1" }, body: { sourceMessageId: "o1", purpose: "重新生成" } });
    expect(result.ok).toBe(true);
    const data = result.data as any;
    expect(data).toMatchObject({ ok: true, parentSessionId: "s-o1", cwd: tmpSessions, threadId: data.id, label: "源会话（分支）", projectId: "p-3" });
    expect(data.fileName).toBe(`${data.id}.jsonl`);
    expect(fs.existsSync(path.join(tmpSessions, data.fileName))).toBe(true);
    // 分支 header 逐点：id 三元组换新、pinned/frozen 复位、entries 保留
    const rawLines = fs.readFileSync(path.join(tmpSessions, data.fileName), "utf8").split("\n").filter(Boolean);
    const header = JSON.parse(rawLines[0]!);
    expect(header).toMatchObject({ id: data.id, sessionId: data.id, threadId: data.id, parentSessionId: "s-o1", branchSourceMessageId: "o1", branchPurpose: "重新生成", pinned: false, frozen: false, label: "源会话（分支）" });
    expect(header.created).toBe(header.updatedAt);
    expect(rawLines).toHaveLength(2); // header + 源 entry
    // label 覆盖
    const relabeled = await invoke("op:sessions:fork", { params: { id: "s-o1" }, body: { label: "自定分支" } });
    expect((relabeled.data as any).label).toBe("自定分支");
  });

  test("404 / 400 empty session", async () => {
    expect(await invoke("op:sessions:fork", { params: { id: "nope" } }))
      .toEqual({ ok: false, status: 404, data: { error: "not found" } });
    fs.writeFileSync(path.join(tmpSessions, "s-blank.jsonl"), "\n\n", "utf8");
    expect(await invoke("op:sessions:fork", { params: { id: "s-blank" } }))
      .toEqual({ ok: false, status: 400, data: { error: "empty session" } });
  });
});

describe("S3-1 兜底与语义", () => {
  test("deps 抛错 → 500（dispatcher 兜底，对齐 http-forward 网络失败形态）", async () => {
    const result = await invoke("op:sessions:list", {}, makeDeps({ listRunSummaries: vi.fn(() => { throw new Error("runs 域故障"); }) }));
    expect(result).toEqual({ ok: false, status: 500, data: { error: "runs 域故障" } });
  });

  test("会话族文件族共享态：直调写入对同目录读取即时可见（无实例空态过渡）", async () => {
    const created = await invoke("op:sessions:create", { body: { label: "共享验证" } });
    const id = (created.data as any).id as string;
    // 另一路由（不经缓存直读磁盘的 batch-delete 之外，list 走 meta 缓存但指纹一致即命中新文件）
    const list = await invoke("op:sessions:list", {});
    expect((list.data as any).sessions.map((s: any) => s.id)).toContain(id);
    // 直调 rename 与磁盘一致
    await invoke("op:sessions:rename", { params: { id }, body: { label: "改名后" } });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpSessions, `${id}.jsonl`), "utf8").split("\n")[0]!);
    expect(raw.label).toBe("改名后");
  });
});
