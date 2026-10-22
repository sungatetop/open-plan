/**
 * Agent OfficeCLI 命令拆分执行（B6-6-1，自 server/agent.mjs L4760-4790 逐行转录）。
 *
 * Agent 有时会把多个 DOM 路径放在同一个 get 命令中。
 * OfficeCLI 的原生命令一次只接收一个路径，这里按顺序拆分后合并 JSON 结果，
 * 让错误的模型参数不会把整轮文档审查卡死，同时仍保持每次调用的原始工作区边界。
 */

export interface OfficeCommandOutput {
  code?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  text?: unknown;
  json?: unknown;
  [key: string]: unknown;
}

export type OfficeCliRunner = (args: unknown, options: { cwd?: string }) => Promise<OfficeCommandOutput>;

export async function runAgentOfficeCommand(args: unknown, runOfficecli: OfficeCliRunner, cwd?: string): Promise<OfficeCommandOutput> {
  const command = String((args as unknown[] | null | undefined)?.[0] || "").toLowerCase();
  if (command !== "get" || !Array.isArray(args) || args.length < 4) return runOfficecli(args, { cwd });
  const rest = args.slice(2);
  const paths = rest.filter((value) => String(value || "").startsWith("/"));
  if (paths.length <= 1) return runOfficecli(args, { cwd });
  const options = rest.filter((value) => !String(value || "").startsWith("/"));
  const outputs: OfficeCommandOutput[] = [];
  for (const domPath of paths) {
    const result = await runOfficecli(["get", args[1]!, domPath, ...options], { cwd });
    outputs.push(result);
    if (Number(result.code) !== 0) return { ...result, command: args };
  }
  const jsonResults = outputs
    .map((item) => item.json)
    .filter((item): item is Record<string, any> => Boolean(item) && typeof item === "object");
  const allHaveResults = jsonResults.length === outputs.length && jsonResults.every((item) => Array.isArray(item.data?.results));
  if (!allHaveResults) {
    return {
      ...outputs[0]!,
      command: args,
      stdout: outputs.map((item) => item.stdout || "").join("\n"),
      text: outputs.map((item) => item.text || "").join("\n"),
    };
  }
  const mergedJson = {
    success: jsonResults.every((item) => item.success !== false),
    data: {
      matches: jsonResults.reduce((sum, item) => sum + Number(item.data?.matches || 0), 0),
      results: jsonResults.flatMap((item) => item.data.results),
    },
  };
  const stdout = JSON.stringify(mergedJson, null, 2);
  return {
    ...outputs[0]!,
    command: args,
    stdout,
    text: stdout,
    json: mergedJson,
    stderr: outputs.map((item) => item.stderr || "").filter(Boolean).join("\n"),
  };
}
