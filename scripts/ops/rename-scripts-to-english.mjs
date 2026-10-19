#!/usr/bin/env node
/**
 * 一次性迁移脚本：中文命名脚本/模块 → 英文命名 + scripts 结构调整。
 *
 * 步骤：
 *  1. git mv 完成全部重命名（含 scripts/assets/brand-vectors → scripts/assets/brand-vectors、
 *     server/工作流 → server/workflows，15 个数据管线/一次性工具迁入 scripts/tools/）
 *  2. 对代码/配置文本批量替换引用（全路径 → 裸文件名 → CI 参数名，长名优先）
 *  3. 对被移动的文件修正相对导入与 __dirname/new URL 深度
 *  4. 扫描残留中文名引用并报告
 *
 * 用法: node scripts/ops/rename-scripts-to-english.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const posix = path.posix;

/* ---------------- 重命名映射（from 相对 ROOT，posix 风格） ---------------- */

// scripts 根目录：测试与入口（原位改名）
const scriptsInPlace = [
  ["editorial-pipeline-test.mjs", "editorial-pipeline-test.mjs"],
  ["artifact-credibility-test.mjs", "artifact-credibility-test.mjs"],
  ["map-report-test.mjs", "map-report-test.mjs"],
  ["map-chat-scene-test.mjs", "map-chat-scene-test.mjs"],
  ["map-chat-adapter-test.mjs", "map-chat-adapter-test.mjs"],
  ["map-visual-unification-test.mjs", "map-visual-unification-test.mjs"],
  ["map-visual-panel-scene-test.mjs", "map-visual-panel-scene-test.mjs"],
  ["map-template-test.mjs", "map-template-test.mjs"],
  ["map-layer-model-test.mjs", "map-layer-model-test.mjs"],
  ["map-layer-entry-scene-test.mjs", "map-layer-entry-scene-test.mjs"],
  ["map-perf-baseline.mjs", "map-perf-baseline.mjs"],
  ["map-readonly-temp-layer-test.mjs", "map-readonly-temp-layer-test.mjs"],
  ["phase2-memory-governance-test.mjs", "phase2-memory-governance-test.mjs"],
  ["phase3-project-session-test.mjs", "phase3-project-session-test.mjs"],
  ["motion-governance-test.mjs", "motion-governance-test.mjs"],
  ["chat-flow-backpressure-test.mjs", "chat-flow-backpressure-test.mjs"],
  ["chat-flow-perf-regression-test.mjs", "chat-flow-perf-regression-test.mjs"],
  ["service-supervisor.mjs", "service-supervisor.mjs"],
  ["service-supervisor-test.mjs", "service-supervisor-test.mjs"],
  ["amap-mcp-bridge-test.mjs", "amap-mcp-bridge-test.mjs"],
  ["workflow-ui-wiring-test.mjs", "workflow-ui-wiring-test.mjs"],
  ["workflow-contract-test.mjs", "workflow-contract-test.mjs"],
  ["workspace-isolation-test.mjs", "workspace-isolation-test.mjs"],
  ["provider-catalog-import-test.mjs", "provider-catalog-import-test.mjs"],
  ["memory-admission-test.mjs", "memory-admission-test.mjs"],
  ["interaction-ownership-test.mjs", "interaction-ownership-test.mjs"],
  ["traffic-sources-visual-descriptor-test.mjs", "traffic-sources-visual-descriptor-test.mjs"],
  ["phase6-runtime-test.mjs", "phase6-runtime-test.mjs"],
  ["phase7-real-regression-test.mjs", "phase7-real-regression-test.mjs"],
  ["phase5-9-test.mjs", "phase5-9-test.mjs"],
  ["phase1-stability-test.mjs", "phase1-stability-test.mjs"],
  ["progress-narration-test.mjs", "progress-narration-test.mjs"],
  ["spatial-analysis-test.mjs", "spatial-analysis-test.mjs"],
  ["cross-layer-regression-test.mjs", "cross-layer-regression-test.mjs"],
  ["web-search-test.mjs", "web-search-test.mjs"],
  ["domain-guard-test.mjs", "domain-guard-test.mjs"],
  ["builtin-browser-test.mjs", "builtin-browser-test.mjs"],
  ["capability-contract-test.mjs", "capability-contract-test.mjs"],
  ["batch-export-test.mjs", "batch-export-test.mjs"],
  ["startup-session-restore-test.mjs", "startup-session-restore-test.mjs"],
  ["task-conclusion-event-test.mjs", "task-conclusion-event-test.mjs"],
  ["task-center-credibility-test.mjs", "task-center-credibility-test.mjs"],
  ["design-tokens-consistency-test.mjs", "design-tokens-consistency-test.mjs"],
  ["approval-scope-test.mjs", "approval-scope-test.mjs"],
  ["event-payload-validation-test.mjs", "event-payload-validation-test.mjs"],
  ["event-archive-test.mjs", "event-archive-test.mjs"],
  ["event-registry-test.mjs", "event-registry-test.mjs"],
  ["first-token-latency-test.mjs", "first-token-latency-test.mjs"],
  ["datasource-adapter-test.mjs", "datasource-adapter-test.mjs"],
  ["doc-engine-test.mjs", "doc-engine-test.mjs"],
  ["file-diff-test.mjs", "file-diff-test.mjs"],
  ["a11y-narrow-screen-test.mjs", "a11y-narrow-screen-test.mjs"],
  ["project-pack-test.mjs", "project-pack-test.mjs"],
  ["write-lock-concurrency-test.mjs", "write-lock-concurrency-test.mjs"],
  ["perf-traffic-baseline-test.mjs", "perf-traffic-baseline-test.mjs"],
  ["verify.mjs", "verify.mjs"],
  ["legacy-ten-items-test.mjs", "legacy-ten-items-test.mjs"],
  ["optimization-acceptance.mjs", "optimization-acceptance.mjs"],
  ["preview-identity-test.mjs", "preview-identity-test.mjs"],
  ["native-files-test.mjs", "native-files-test.mjs"],
  ["run-budget-test.mjs", "run-budget-test.mjs"],
  ["run-display-projection-test.mjs", "run-display-projection-test.mjs"],
  ["stream-budget-dedup-test.mjs", "stream-budget-dedup-test.mjs"],
  ["run-trace-reduction-test.mjs", "run-trace-reduction-test.mjs"],
  ["abort-drain-test.mjs", "abort-drain-test.mjs"],
  ["repeat-guard-test.mjs", "repeat-guard-test.mjs"],
  ["main-flow-credibility-test.mjs", "main-flow-credibility-test.mjs"],
  ["subagent-orchestrator-test.mjs", "subagent-orchestrator-test.mjs"],
  ["subagent-event-reduction-test.mjs", "subagent-event-reduction-test.mjs"],
  ["component-spec-test.mjs", "component-spec-test.mjs"],
  ["final-model-regression-test.mjs", "final-model-regression-test.mjs"],
  ["ci-runner.mjs", "ci-runner.mjs"],
  ["gis-e2e-test.mjs", "gis-e2e-test.mjs"],
  ["icon-reference-test.mjs", "icon-reference-test.mjs"],
  ["pi-iteration-fullchain-test.mjs", "pi-iteration-fullchain-test.mjs"],
  ["pi-connectivity-test.mjs", "pi-connectivity-test.mjs"],
  ["pi-config-isolation-test.mjs", "pi-config-isolation-test.mjs"],
  ["pi-config-api-test.mjs", "pi-config-api-test.mjs"],
  ["review-fix-regression-test.mjs", "review-fix-regression-test.mjs"],
  ["review-fix-e2e-verify.mjs", "review-fix-e2e-verify.mjs"],
  ["sse-protocol-regression-test.mjs", "sse-protocol-regression-test.mjs"],
];

// scripts 根目录 → scripts/tools/（数据管线与一次性工具，深度 +1）
const scriptsToTools = [
  ["import-provincial-data.mjs", "import-provincial-data.mjs"],
  ["road-network-tagging.mjs", "road-network-tagging.mjs"],
  ["migrate-map-layer-ownership.mjs", "migrate-map-layer-ownership.mjs"],
  ["migrate-map-glyph-paths.mjs", "migrate-map-glyph-paths.mjs"],
  ["cleanup-map-layers.mjs", "cleanup-map-layers.mjs"],
  ["cleanup-legacy-artifacts.mjs", "cleanup-legacy-artifacts.mjs"],
  ["task-retrospective.mjs", "task-retrospective.mjs"],
  ["generate-map-glyphs.mjs", "generate-map-glyphs.mjs"],
  ["generate-brand-graphics.mjs", "generate-brand-graphics.mjs"],
  ["generate-m2-data.mjs", "generate-m2-data.mjs"],
  ["extract-pi-provider-catalog.mjs", "extract-pi-provider-catalog.mjs"],
  ["fetch-boundaries.mjs", "fetch-boundaries.mjs"],
  ["prepare-map-data.mjs", "prepare-map-data.mjs"],
  ["build-vector-tiles.mjs", "build-vector-tiles.mjs"],
  ["install-officecli.mjs", "install-officecli.mjs"],
];

const scriptsOps = [
  ["ops/backfill-doc-frontmatter.mjs", "ops/backfill-doc-frontmatter.mjs"],
  ["ops/apply-review-comments.bat", "ops/apply-review-comments.bat"],
  ["ops/start-service.ps1", "ops/start-service.ps1"],
  ["ops/start-service-background.ps1", "ops/start-service-background.ps1"],
  ["ops/stop-service.ps1", "ops/stop-service.ps1"],
];

const scriptsReporting = [
  ["reporting/insert-convergence-chart.mjs", "reporting/insert-convergence-chart.mjs"],
  ["reporting/build-offline-video.mjs", "reporting/build-offline-video.mjs"],
  ["reporting/reorder-offline-pages.mjs", "reporting/reorder-offline-pages.mjs"],
  ["reporting/merge-report-video.mjs", "reporting/merge-report-video.mjs"],
  ["reporting/warmwhite-report-opt-r2.mjs", "reporting/warmwhite-report-opt-r2.mjs"],
  ["reporting/warmwhite-report-opt-r3.mjs", "reporting/warmwhite-report-opt-r3.mjs"],
  ["reporting/warmwhite-report-opt-r4.mjs", "reporting/warmwhite-report-opt-r4.mjs"],
  ["reporting/warmwhite-video-merge.mjs", "reporting/warmwhite-video-merge.mjs"],
  ["reporting/embed-template-library.mjs", "reporting/embed-template-library.mjs"],
  ["reporting/generate-speech-script-docx.mjs", "reporting/generate-speech-script-docx.mjs"],
  ["reporting/update-template-library-title.mjs", "reporting/update-template-library-title.mjs"],
  ["reporting/update-homepage-title.mjs", "reporting/update-homepage-title.mjs"],
];

// server 模块（原位改名；工作流/ 目录先改名为 workflows/）
const serverInPlace = [
  ["editorial-pipeline.mjs", "editorial-pipeline.mjs"],
  ["artifact-verification.mjs", "artifact-verification.mjs"],
  ["artifact-management.mjs", "artifact-management.mjs"],
  ["artifact-acceptance.mjs", "artifact-acceptance.mjs"],
  ["persistence-utils.mjs", "persistence-utils.mjs"],
  ["map-report.mjs", "map-report.mjs"],
  ["map-visualization.mjs", "map-visualization.mjs"],
  ["map-template.mjs", "map-template.mjs"],
  ["map-demo.mjs", "map-demo.mjs"],
  ["workflow-validation.mjs", "workflow-validation.mjs"],
  ["workflow-registry.mjs", "workflow-registry.mjs"],
  ["provider-catalog.mjs", "provider-catalog.mjs"],
  ["memory-management.mjs", "memory-management.mjs"],
  ["memory-admission.mjs", "memory-admission.mjs"],
  ["cambodia-od.mjs", "cambodia-od.mjs"],
  ["traffic-sources.mjs", "traffic-sources.mjs"],
  ["spatial-analysis.mjs", "spatial-analysis.mjs"],
  ["web-search.mjs", "web-search.mjs"],
  ["stream-connection.mjs", "stream-connection.mjs"],
  ["turn-budget.mjs", "turn-budget.mjs"],
  ["command-safety-policy.mjs", "command-safety-policy.mjs"],
  ["models-dev-catalog.mjs", "models-dev-catalog.mjs"],
  ["kernel-sidecar.mjs", "kernel-sidecar.mjs"],
  ["builtin-browser.mjs", "builtin-browser.mjs"],
  ["batch-export.mjs", "batch-export.mjs"],
  ["migrate-legacy-data.mjs", "migrate-legacy-data.mjs"],
  ["approval-policy.mjs", "approval-policy.mjs"],
  ["event-storage.mjs", "event-storage.mjs"],
  ["event-normalization.mjs", "event-normalization.mjs"],
  ["event-protocol.mjs", "event-protocol.mjs"],
  ["event-registry.mjs", "event-registry.mjs"],
  ["first-token-latency.mjs", "first-token-latency.mjs"],
  ["datasource-adapter-ext.mjs", "datasource-adapter-ext.mjs"],
  ["plan-catalog.mjs", "plan-catalog.mjs"],
  ["layer-repository.mjs", "layer-repository.mjs"],
  ["web-reader.mjs", "web-reader.mjs"],
  ["doc-engine.mjs", "doc-engine.mjs"],
  ["file-diff.mjs", "file-diff.mjs"],
  ["file-permission-error.mjs", "file-permission-error.mjs"],
  ["project-pack.mjs", "project-pack.mjs"],
  ["project-management.mjs", "project-management.mjs"],
  ["project-trust.mjs", "project-trust.mjs"],
  ["write-coordination.mjs", "write-coordination.mjs"],
  ["native-files.mjs", "native-files.mjs"],
  ["run-trace.mjs", "run-trace.mjs"],
  ["feature-flags.mjs", "feature-flags.mjs"],
  ["run-evaluation.mjs", "run-evaluation.mjs"],
  ["run-budget.mjs", "run-budget.mjs"],
  ["agent-management.mjs", "agent-management.mjs"],
  ["subagent-orchestrator.mjs", "subagent-orchestrator.mjs"],
  ["mcp-management.mjs", "mcp-management.mjs"],
  ["office-params.mjs", "office-params.mjs"],
  ["pi-package-catalog.mjs", "pi-package-catalog.mjs"],
  ["pi-extension-management.mjs", "pi-extension-management.mjs"],
  ["pi-builtin-providers.json", "pi-builtin-providers.json"],
  ["pi-config-management.mjs", "pi-config-management.mjs"],
  ["pi-network-proxy.mjs", "pi-network-proxy.mjs"],
  ["pi-runtime-management.mjs", "pi-runtime-management.mjs"],
];

// server/workflows/（目录改名后内部文件）
const serverWorkflows = [
  ["workflows/report-orchestration.mjs", "workflows/report-orchestration.mjs"],
  ["workflows/spec-compliance-review.mjs", "workflows/spec-compliance-review.mjs"],
  ["workflows/reachability-analysis.mjs", "workflows/reachability-analysis.mjs"],
  ["workflows/road-network-assessment.mjs", "workflows/road-network-assessment.mjs"],
  ["workflows/datasource-integration.mjs", "workflows/datasource-integration.mjs"],
  ["workflows/od-demand-analysis.mjs", "workflows/od-demand-analysis.mjs"],
];

const serverPiExt = [["pi-extensions/workspace-guard.mjs", "pi-extensions/workspace-guard.mjs"]];

// client/src
const clientInPlace = [
  ["artifact-types.js", "artifact-types.js"],
  ["object-aggregation.js", "object-aggregation.js"],
  ["provider-identity.js", "provider-identity.js"],
  ["ui-appearance.js", "ui-appearance.js"],
  ["browser-linkage.js", "browser-linkage.js"],
  ["event-display.js", "event-display.js"],
  ["first-token-latency-tracker.js", "first-token-latency-tracker.js"],
  ["layer-registry.js", "layer-registry.js"],
  ["file-urls.js", "file-urls.js"],
  ["run-trace.js", "run-trace.js"],
  ["feature-flags.js", "feature-flags.js"],
  ["run-display-projection.js", "run-display-projection.js"],
  ["stream-budget.js", "stream-budget.js"],
  ["components/MapExportView.jsx", "components/MapExportView.jsx"],
  ["components/ObjectBar.jsx", "components/ObjectBar.jsx"],
  ["components/SemanticToolIcon.jsx", "components/SemanticToolIcon.jsx"],
  ["components/WorkArtifactPanel.jsx", "components/WorkArtifactPanel.jsx"],
  ["components/WorkflowLauncher.jsx", "components/WorkflowLauncher.jsx"],
  ["components/ProviderLibrary.jsx", "components/ProviderLibrary.jsx"],
  ["components/SupplierBrandGraphics.js", "components/SupplierBrandGraphics.js"],
  ["components/SearchChat.jsx", "components/SearchChat.jsx"],
  ["components/StageBar.jsx", "components/StageBar.jsx"],
  ["components/VisualPanel.jsx", "components/VisualPanel.jsx"],
  ["components/StreamingTextQueue.js", "components/StreamingTextQueue.js"],
  ["components/BuiltinBrowserPanel.jsx", "components/BuiltinBrowserPanel.jsx"],
  ["components/MarqueeText.jsx", "components/MarqueeText.jsx"],
  ["components/TaskCenter.jsx", "components/TaskCenter.jsx"],
  ["components/DocPagination.js", "components/DocPagination.js"],
  ["components/DocOutline.js", "components/DocOutline.js"],
  ["components/FileSorting.js", "components/FileSorting.js"],
  ["components/AcceptanceStatus.js", "components/AcceptanceStatus.js"],
  ["components/DesktopAgentPrototype.css", "components/DesktopAgentPrototype.css"],
  ["components/DesktopAgentPrototype.jsx", "components/DesktopAgentPrototype.jsx"],
  ["components/SubagentDetailPanel.jsx", "components/SubagentDetailPanel.jsx"],
];

/* ---------------- 组装映射 ---------------- */

const moves = [];
for (const [f, t] of scriptsInPlace) moves.push([`scripts/${f}`, `scripts/${t}`]);
for (const [f, t] of scriptsToTools) moves.push([`scripts/${f}`, `scripts/tools/${t}`]);
for (const [f, t] of scriptsOps) moves.push([`scripts/${f}`, `scripts/${t}`]);
for (const [f, t] of scriptsReporting) moves.push([`scripts/${f}`, `scripts/${t}`]);
for (const [f, t] of serverInPlace) moves.push([`server/${f}`, `server/${t}`]);
for (const [f, t] of serverWorkflows) moves.push([`server/${f}`, `server/${t}`]);
for (const [f, t] of serverPiExt) moves.push([`server/${f}`, `server/${t}`]);
for (const [f, t] of clientInPlace) moves.push([`client/src/${f}`, `client/src/${t}`]);

const dirMoves = [
  ["scripts/assets/brand-vectors", "scripts/assets/brand-vectors"],
  ["server/工作流", "server/workflows"],
];

// 重复基名断言（同名同扩展名的两个文件不允许只按基名替换）
const byBase = new Map();
for (const [from, to] of moves) {
  const base = posix.basename(from);
  if (byBase.has(base) && byBase.get(base) !== to) {
    console.error(`重复基名冲突: ${base} -> ${byBase.get(base)} / ${to}`);
    process.exit(1);
  }
  byBase.set(base, to);
}

/* ---------------- 1. git mv ---------------- */

function gitMv(fromAbs, toAbs) {
  if (!fs.existsSync(fromAbs)) {
    if (fs.existsSync(toAbs)) return; // 已完成（幂等重跑）
    throw new Error(`源不存在且目标也不存在: ${fromAbs}`);
  }
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  const r = spawnSync("git", ["mv", fromAbs, toAbs], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    // 未跟踪的新文件走文件系统重命名
    if (/not under version control/.test(String(r.stderr))) {
      fs.renameSync(fromAbs, toAbs);
      return;
    }
    throw new Error(`git mv 失败: ${fromAbs} -> ${toAbs}\n${r.stderr}${r.stdout}`);
  }
}

for (const [from, to] of dirMoves) gitMv(path.join(ROOT, from), path.join(ROOT, to));
for (const [from, to] of moves) gitMv(path.join(ROOT, from), path.join(ROOT, to));
console.log(`git mv 完成: ${dirMoves.length} 个目录 + ${moves.length} 个文件`);

/* ---------------- 2. 文本替换 ---------------- */

// CI 里以裸测试名作参数（scripts/ci-runner.mjs <name>）
const ciArgPairs = [
  ["run-trace-reduction-test", "run-trace-reduction-test"],
  ["event-registry-test", "event-registry-test"],
  ["task-conclusion-event-test", "task-conclusion-event-test"],
  ["artifact-credibility-test", "artifact-credibility-test"],
  ["motion-governance-test", "motion-governance-test"],
  ["main-flow-credibility-test", "main-flow-credibility-test"],
  ["chat-flow-perf-regression-test", "chat-flow-perf-regression-test"],
  ["stream-budget-dedup-test", "stream-budget-dedup-test"],
  ["map-readonly-temp-layer-test", "map-readonly-temp-layer-test"],
  ["map-layer-model-test", "map-layer-model-test"],
  ["traffic-sources-visual-descriptor-test", "traffic-sources-visual-descriptor-test"],
  ["map-visual-unification-test", "map-visual-unification-test"],
  ["map-chat-adapter-test", "map-chat-adapter-test"],
  ["workspace-isolation-test", "workspace-isolation-test"],
  ["provider-catalog-import-test", "provider-catalog-import-test"],
  ["review-fix-regression-test", "review-fix-regression-test"],
];

const extraPairs = [
  ["scripts/assets/brand-vectors", "scripts/assets/brand-vectors"],
  ["server/workflows/", "server/workflows/"],
  ["service-supervisor.log", "service-supervisor.log"],
  ["stop-service", "stop-service"], // stop-service.ps1 的自识别标记与注释
];

const scopedPairs = new Map([
  // workflow-registry.mjs 扫描目录名（避免全局误替换「工作流」概念词）
  ["server/workflows/workflow-registry.mjs", [[`, "工作流")`, `, "workflows")`]]],
]);

const pairSet = new Map();
const addPair = (from, to) => { if (pairSet.has(from) && pairSet.get(from) !== to) throw new Error(`替换对冲突: ${from}`); pairSet.set(from, to); };
for (const [from, to] of moves) addPair(from, to); // 全路径（含目录前缀）
for (const [from, to] of moves) addPair(posix.basename(from), posix.basename(to)); // 裸文件名
for (const [f, t] of ciArgPairs) addPair(f, t);
for (const [f, t] of extraPairs) addPair(f, t);
const pairs = [...pairSet.entries()].sort((a, b) => b[0].length - a[0].length);

const TEXT_EXTS = new Set([".mjs", ".js", ".jsx", ".json", ".ps1", ".bat", ".yml", ".yaml", ".md", ".css", ".html"]);
const SCAN_ROOTS = ["scripts", "server", "client/src"];
const EXTRA_FILES = ["package.json", ".github/workflows/ci.yml", "README.md", "AGENT.MD", "docs/README.md", ".trae/rules/project_rules.md"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function walkText(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) out.push(...walkText(path.join(dir, entry.name))); }
    else if (entry.isFile() && TEXT_EXTS.has(path.extname(entry.name))) out.push(entry.name.endsWith(".json") && entry.name === "pi-builtin-providers.json" ? path.join(dir, entry.name) : path.join(dir, entry.name));
  }
  return out;
}

const files = [...SCAN_ROOTS.flatMap((d) => walkText(path.join(ROOT, d))), ...EXTRA_FILES.map((f) => path.join(ROOT, f))];
let changedFiles = 0;
let totalReplaced = 0;
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, "utf8");
  const hasBom = raw.startsWith("\uFEFF");
  let content = hasBom ? raw.slice(1) : raw;
  let count = 0;
  const relForScope = path.relative(ROOT, file).replace(/\\/g, "/");
  const scoped = scopedPairs.get(relForScope) || [];
  for (const [from, to] of [...pairs, ...scoped]) {
    if (!content.includes(from)) continue;
    count += content.split(from).length - 1;
    content = content.split(from).join(to);
  }
  if (count > 0) {
    fs.writeFileSync(file, (hasBom ? "\uFEFF" : "") + content, "utf8");
    changedFiles++;
    totalReplaced += count;
  }
}
console.log(`引用替换: ${totalReplaced} 处 / ${changedFiles} 个文件`);

/* ---------------- 3. 被移动文件的相对导入与深度修正 ---------------- */

const mapByFrom = new Map(moves.map(([f, t]) => [f, t]));
let fixedSpecs = 0;
for (const [from, to] of moves) {
  const oldDir = posix.dirname(from);
  const newDir = posix.dirname(to);
  if (oldDir === newDir) continue;
  const abs = path.join(ROOT, to);
  if (!fs.existsSync(abs)) continue;
  let content = fs.readFileSync(abs, "utf8");

  // 3a. import/export/dynamic import 的相对说明符
  content = content.replace(/(from\s+|import\s*\(\s*|import\s+)(["'])(\.\.?\/[^"']+)\2/g, (m, pre, q, spec) => {
    const oldAbs = posix.normalize(posix.join(oldDir, spec));
    const newAbs = mapByFrom.get(oldAbs) || oldAbs;
    let rel = posix.relative(newDir, newAbs).replace(/\\/g, "/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    if (rel !== spec) fixedSpecs++;
    return `${pre}${q}${rel}${q}`;
  });

  // 3b. new URL("..", import.meta.url) 深度
  const depth = posix.relative(newDir, "").replace(/\\/g, "/"); // 如 "../.."
  content = content.replace(/new URL\("(\.\.(?:\/\.\.)*)"\s*,\s*import\.meta\.url\)/g, () => {
    fixedSpecs++;
    return `new URL("${depth}", import.meta.url)`;
  });

  // 3c. path.resolve(__dirname, "..") 深度
  const depthArgs = depth.split("/").map(() => '".."').join(", ");
  if (content.includes('path.resolve(__dirname, "..")')) {
    content = content.split('path.resolve(__dirname, "..")').join(`path.resolve(__dirname, ${depthArgs})`);
    fixedSpecs++;
  }

  fs.writeFileSync(abs, content, "utf8");
}
console.log(`相对导入/深度修正: ${fixedSpecs} 处`);

/* ---------------- 4. 残留扫描 ---------------- */

const cjkRef = /[\u4e00-\u9fff][\u4e00-\u9fff0-9A-Za-z_]*\.(mjs|js|jsx|ps1|bat|json)\b|scripts\/[\u4e00-\u9fff]|server\/[\u4e00-\u9fff]|client\/src\/[\u4e00-\u9fff]/g;
const leftovers = [];
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const content = fs.readFileSync(file, "utf8");
  for (const m of content.matchAll(cjkRef)) leftovers.push(`${rel}: ${m[0]}`);
}
if (leftovers.length) {
  console.log(`残留中文路径引用 ${leftovers.length} 处:`);
  for (const l of [...new Set(leftovers)]) console.log("  " + l);
} else {
  console.log("残留扫描: 代码与配置中无中文脚本名引用");
}
