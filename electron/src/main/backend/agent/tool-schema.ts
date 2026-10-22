/**
 * Agent 工具 Schema 工具族（B6-6-1，自 server/agent.mjs L116-164 逐行转录）。
 *
 * - schemaToTypeBox：JSON Schema → TypeBox Schema（Pi 工具定义层）
 * - safePiToolName：工具名归一（Pi 对工具名字符集有限制）
 * - extensionToolNames：从 Pi 扩展 loader 中筛出显式启用扩展注册的工具名
 */
import path from "node:path";
import { Type, type TSchema } from "typebox";

type SchemaRecord = Record<string, unknown>;

export function schemaToTypeBox(schema: unknown = {}, depth = 0): TSchema {
  if (!schema || typeof schema !== "object" || depth > 8) return Type.Any();
  const s = schema as SchemaRecord;
  if (Array.isArray(s.enum) && s.enum.length && s.enum.length <= 50) {
    const literals = s.enum.map((value) => {
      if (["string", "number", "boolean"].includes(typeof value) || value === null) return Type.Literal(value as never);
      return null;
    });
    if (literals.every(Boolean)) {
      const found = literals as TSchema[];
      return found.length === 1 ? found[0]! : Type.Union(found);
    }
  }
  const union = (s.anyOf || s.oneOf) as unknown;
  if (Array.isArray(union) && union.length > 0 && union.length <= 12) {
    const options = union.map((item) => schemaToTypeBox(item, depth + 1));
    return options.length === 1 ? options[0]! : Type.Union(options);
  }
  const type = Array.isArray(s.type) ? (s.type as unknown[]).find((item) => item !== "null") : s.type;
  if (type === "object" || s.properties) {
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const properties = Object.fromEntries(
      Object.entries((s.properties || {}) as SchemaRecord).slice(0, 100).map(([key, child]) => {
        const value = schemaToTypeBox(child, depth + 1);
        return [key, required.has(key) ? value : Type.Optional(value)];
      }),
    );
    return Type.Object(properties, { additionalProperties: s.additionalProperties === false ? false : true });
  }
  if (type === "array") {
    return Type.Array(schemaToTypeBox(s.items || {}, depth + 1), { maxItems: Number.isFinite(s.maxItems as number) ? (s.maxItems as number) : 1000 });
  }
  if (type === "string") {
    return Type.String({
      ...(Number.isFinite(s.maxLength as number) ? { maxLength: s.maxLength as number } : {}),
      ...(Number.isFinite(s.minLength as number) ? { minLength: s.minLength as number } : {}),
    });
  }
  if (type === "integer" || type === "number") return Type.Number();
  if (type === "boolean") return Type.Boolean();
  if (type === "null") return Type.Null();
  return Type.Any();
}

export function safePiToolName(value: unknown, max = 64): string {
  const clean = String(value || "tool").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  return clean.slice(0, max);
}

export interface PiExtensionEntry {
  path: string;
}

export interface PiExtensionRecord {
  resolvedPath?: string;
  path?: string;
  tools?: Map<string, unknown>;
}

export interface PiExtensionLoader {
  getExtensions?: () => { extensions?: PiExtensionRecord[] };
}

export function extensionToolNames(loader: PiExtensionLoader, enabledEntries: readonly PiExtensionEntry[]): string[] {
  const roots = enabledEntries.map((entry) => path.resolve(entry.path));
  const names = new Set<string>();
  for (const extension of loader.getExtensions?.().extensions || []) {
    const resolved = path.resolve(extension.resolvedPath || extension.path || "");
    const isExplicitlyEnabled = roots.some((root) => {
      const relative = path.relative(root, resolved);
      return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    });
    if (isExplicitlyEnabled) for (const name of extension.tools?.keys?.() || []) names.add(String(name));
  }
  return [...names];
}
