export interface ServerProbe {
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/** 轮询 /api/status 直到服务就绪或超时 */
export async function waitForServerReady(url: string, timeoutMs = 120_000, intervalMs = 500): Promise<ServerProbe> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const probe = await probeOnce(url);
    if (probe.ok) return probe;
    lastError = probe.error ?? "";
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, error: `等待服务就绪超时（${Math.round(timeoutMs / 1000)}s）：${lastError}` };
}

export async function probeOnce(url: string): Promise<ServerProbe> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true, payload: await res.json().catch(() => undefined) };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
