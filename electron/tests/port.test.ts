import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { isPortFree, pickPreferredPort } from "../src/main/util/port";

const heldServers: net.Server[] = [];

function holdPort(port: number, host = "127.0.0.1"): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ port, host, exclusive: true }, () => {
      heldServers.push(server);
      resolve(server);
    });
  });
}

afterEach(() => {
  for (const server of heldServers.splice(0)) server.close();
});

describe("isPortFree", () => {
  it("未占用端口返回 true", async () => {
    const port = await findFreePort();
    await expect(isPortFree(port)).resolves.toBe(true);
  });

  it("已占用端口返回 false", async () => {
    const port = await findFreePort();
    await holdPort(port);
    await expect(isPortFree(port)).resolves.toBe(false);
  });
});

describe("pickPreferredPort", () => {
  it("首选端口空闲时直接返回首选端口", async () => {
    const free = await findFreePort();
    await expect(pickPreferredPort(free, free + 5)).resolves.toBe(free);
  });

  it("首选端口被占用时向上顺延", async () => {
    const base = await findFreePort();
    await holdPort(base);
    await expect(pickPreferredPort(base, base + 10)).resolves.toBe(base + 1);
  });

  it("区间全被占用时抛错", async () => {
    const base = await findFreePort();
    await holdPort(base);
    await holdPort(base + 1);
    await expect(pickPreferredPort(base, base + 1)).rejects.toThrow(/均被占用/);
  });
});

/** 让操作系统分配一个当前空闲端口，仅用于测试取值 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
