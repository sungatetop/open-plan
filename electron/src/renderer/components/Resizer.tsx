import { useRef, type MouseEvent } from "react";

/**
 * 拖拽分隔条（client/src/components/Resizer.jsx 逐行等价迁移）。
 * 在两个 flex 面板之间拖动，更新 documentElement 上的 CSS 宽度变量。
 */
export default function Resizer({
  side = "left",
  min = 140,
  max = 600,
  cssVar,
  rootSelector = ".app",
  className = ""
}: {
  side?: "left" | "right";
  min?: number;
  max?: number;
  cssVar: string;
  rootSelector?: string;
  className?: string;
}): React.JSX.Element {
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = (e: MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    startX.current = e.clientX;
    const root = document.querySelector(rootSelector);
    const panel = side === "left" ? root?.previousElementSibling || root?.parentElement?.querySelector(".sidebar") : root?.nextElementSibling;
    void panel; // 面板宽度实际由 CSS 变量驱动，此处仅保持与旧实现的查询时序一致
    // get current width from computed style
    const computed = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
    startW.current = parseInt(computed) || 220;

    document.body.classList.add("resizing");

    const onMouseMove = (ev: globalThis.MouseEvent): void => {
      const delta = ev.clientX - startX.current;
      const newW = Math.min(max, Math.max(min, startW.current + (side === "left" ? delta : -delta)));
      document.documentElement.style.setProperty(cssVar, newW + "px");
    };

    const onMouseUp = (): void => {
      document.body.classList.remove("resizing");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  return <div className={`resizer ${className}`.trim()} onMouseDown={onMouseDown} />;
}
