import type { OpDesktopApi, ServerStatusPayload } from "../shared/desktop-protocol";

declare global {
  interface Window { opDesktop: OpDesktopApi }
}

const statusEl = document.getElementById("status") as HTMLDivElement;
const spinnerEl = document.getElementById("spinner") as HTMLDivElement;
const errorEl = document.getElementById("error") as HTMLDivElement;

function render(status: ServerStatusPayload): void {
  switch (status.phase) {
    case "starting":
      statusEl.textContent = "正在启动本地服务…";
      spinnerEl.classList.remove("hidden");
      errorEl.classList.remove("visible");
      break;
    case "ready":
      statusEl.textContent = "服务就绪，正在进入工作台…";
      spinnerEl.classList.add("hidden");
      break;
    case "failed":
    case "stopped": {
      statusEl.textContent = "启动失败";
      spinnerEl.classList.add("hidden");
      const lines = [status.message ?? "", ...(status.logTail ?? [])].filter(Boolean).join("\n");
      errorEl.textContent = lines || "未知错误";
      errorEl.classList.add("visible");
      break;
    }
  }
}

const api = window.opDesktop;
if (api) {
  void api.getServerStatus().then(render).catch(() => undefined);
  api.onServerStatus(render);
}
