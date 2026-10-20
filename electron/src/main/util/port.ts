import net from "node:net";

/** 探测端口在指定主机上是否可绑定 */
export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const done = (free: boolean) => {
      server.removeAllListeners("error");
      server.removeAllListeners("listening");
      try { server.close(() => resolve(free)); } catch { resolve(free); }
    };
    server.once("error", () => done(false));
    server.once("listening", () => done(true));
    try { server.listen({ port, host, exclusive: true }); } catch { done(false); }
  });
}

/**
 * 在首选端口空闲时优先使用之；否则从 preferred+1 向上扫描至 rangeEnd。
 * 主进程与服务进程存在检测-绑定竞态，这里只做尽力而为的端口选择；
 * 服务进程启动失败由上层以日志与退出码兜底。
 */
export async function pickPreferredPort(preferred = 3002, rangeEnd = 3099): Promise<number> {
  if (await isPortFree(preferred)) return preferred;
  for (let port = preferred + 1; port <= rangeEnd; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`端口 ${preferred}-${rangeEnd} 均被占用，无法启动本地服务`);
}
