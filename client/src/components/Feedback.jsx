import React, { useCallback, useEffect, useRef, useState } from "react";
import { flag } from "../feature-flags.js";
import Icon from "./Icon.jsx";

/**
 * 统一反馈基座（交互评审 P0-1 / N1 修正案）。
 *
 * - notify* / askConfirm 是全项目唯一的反馈入口；client/src 其余文件禁止直接调用
 *   window.alert / window.confirm（构建期由 grep 断言守护）。
 * - 开关 feedbackV2（OAW_FEEDBACK_V2，默认关）关闭时逐点回退原生 alert/confirm，
 *   与历史基线行为一致；开启时走应用内 toast 队列与确认对话框。
 * - 本文件是原生 alert/confirm 的唯一白名单落点。
 */

const TONE_META = {
  error: { icon: "warning", className: "fb-toast-error" },
  success: { icon: "check", className: "fb-toast-success" },
  warn: { icon: "info", className: "fb-toast-warn" },
};
const TOAST_TTL_MS = 3200;
const MAX_TOASTS = 4;

let pushToastExternal = null;
let askConfirmExternal = null;

function nativeText(message) {
  return String(message ?? "");
}

/** 错误类反馈（替代 alert）。 */
export function notifyError(message) {
  if (flag("feedbackV2") && pushToastExternal) pushToastExternal({ tone: "error", message: nativeText(message) });
  else window.alert(nativeText(message));
}

/** 成功类反馈（替代成功语义的 alert）。 */
export function notifySuccess(message) {
  if (flag("feedbackV2") && pushToastExternal) pushToastExternal({ tone: "success", message: nativeText(message) });
  else window.alert(nativeText(message));
}

/** 警告类反馈。 */
export function notifyWarn(message) {
  if (flag("feedbackV2") && pushToastExternal) pushToastExternal({ tone: "warn", message: nativeText(message) });
  else window.alert(nativeText(message));
}

/**
 * 确认类反馈（替代 confirm），返回 Promise<boolean>：
 * flag 关闭时回退原生 window.confirm（同步语义经 Promise 包装，调用方 await 即可）。
 */
export function askConfirm(message) {
  const text = nativeText(message);
  if (flag("feedbackV2") && askConfirmExternal) return askConfirmExternal(text);
  return Promise.resolve(window.confirm(text));
}

function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="fb-toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => {
        const meta = TONE_META[t.tone] || TONE_META.warn;
        return (
          <div key={t.id} className={`fb-toast ${meta.className}`}>
            <Icon name={meta.icon} size={14} />
            <span className="fb-toast-text">{t.message}</span>
            <button type="button" className="fb-toast-close" title="关闭" aria-label="关闭提示" onClick={() => onDismiss(t.id)}>
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ConfirmDialog({ pending, onResolve }) {
  if (!pending) return null;
  return (
    <div className="fb-confirm-backdrop" onClick={() => onResolve(false)}>
      <div className="fb-confirm" role="alertdialog" aria-modal="true" aria-label="确认操作" onClick={(e) => e.stopPropagation()}>
        <div className="fb-confirm-body">{pending.message}</div>
        <div className="fb-confirm-actions">
          <button type="button" className="fb-btn" onClick={() => onResolve(false)}>取消</button>
          <button type="button" className="fb-btn fb-btn-danger" autoFocus onClick={() => onResolve(true)}>确定</button>
        </div>
      </div>
    </div>
  );
}

export default function FeedbackHost() {
  const [toasts, setToasts] = useState([]);
  const [pending, setPending] = useState(null);
  const seqRef = useRef(0);
  const pendingResolveRef = useRef(null);

  useEffect(() => {
    pushToastExternal = ({ tone, message }) => {
      const id = ++seqRef.current;
      setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, tone, message }]);
      window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_TTL_MS);
    };
    askConfirmExternal = (message) => new Promise((resolve) => {
      pendingResolveRef.current = resolve;
      setPending({ message });
    });
    return () => {
      pushToastExternal = null;
      askConfirmExternal = null;
    };
  }, []);

  const resolvePending = useCallback((value) => {
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;
    setPending(null);
    resolve?.(value);
  }, []);

  useEffect(() => {
    if (!pending) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") resolvePending(false);
      else if (e.key === "Enter") resolvePending(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, resolvePending]);

  return (
    <>
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />
      <ConfirmDialog pending={pending} onResolve={resolvePending} />
    </>
  );
}
