/**
 * 文件树排序（时间 / 类型）。
 * 目录始终排在文件前面；时间=按修改时间倒序，类型=按扩展名分组（同组按名称）。
 * 目录通常没有 mtime，此时退回按名称排序，避免出现"看起来没反应"的排序。
 *
 * 与 client/src/components/FileSorting.js 逐函数等价（tests/f1-FileSorting-parity.test.ts 对拍强制）。
 */

function timeOf(file: any): number {
  const value = Date.parse(file?.mtime || 0);
  return Number.isFinite(value) ? value : 0;
}

function nameOf(file: any): string {
  return String(file?.name || "");
}

function byName(a: any, b: any): number {
  return nameOf(a).localeCompare(nameOf(b), "zh-Hans-CN");
}

export function sortFiles(list: unknown, mode: unknown = "time"): unknown[] {
  const items: any[] = Array.isArray(list) ? [...list] : [];
  const dirs = items.filter((item) => item?.isDir);
  const files = items.filter((item) => !item?.isDir);
  if (mode === "type") {
    dirs.sort((a, b) => byName(a, b) || timeOf(b) - timeOf(a));
    files.sort((a, b) => {
      const extA = String(a.ext || "").toLowerCase() || "zzzz";
      const extB = String(b.ext || "").toLowerCase() || "zzzz";
      return extA.localeCompare(extB) || byName(a, b);
    });
  } else {
    dirs.sort((a, b) => timeOf(b) - timeOf(a) || byName(a, b));
    files.sort((a, b) => timeOf(b) - timeOf(a) || byName(a, b));
  }
  return [...dirs, ...files];
}
