/**
 * 触覚フィードバック。Android などは Vibration API、
 * iOS Safari（18 以降）は switch 型チェックボックスのラベルを押したときの触覚を使う。
 * どちらも無い環境では何もしない。
 */
let enabled = true;
let label: HTMLLabelElement | null = null;

export function setHapticsEnabled(value: boolean) {
  enabled = value;
}

function iosLabel(): HTMLLabelElement | null {
  if (label) return label;
  if (typeof document === "undefined") return null;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");
  input.id = "haptic-switch";
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  label = document.createElement("label");
  label.htmlFor = input.id;
  label.setAttribute("aria-hidden", "true");
  label.style.cssText =
    "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;left:-9px;top:-9px";
  label.appendChild(input);
  document.body.appendChild(label);
  return label;
}

/** ラベルを押すとチェックボックスにフォーカスが移るので、元の要素に戻す */
function tap(l: HTMLLabelElement) {
  const prev = document.activeElement;
  l.click();
  const input = l.querySelector("input");
  if (input && document.activeElement === input) {
    input.blur();
    if (prev instanceof HTMLElement && prev !== document.body) prev.focus({ preventScroll: true });
  }
}

const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

export function haptic(kind: "light" | "medium" | "heavy" = "light") {
  if (!enabled || typeof window === "undefined") return;
  if (typeof navigator.vibrate === "function" && !isIOS()) {
    navigator.vibrate(kind === "heavy" ? [12, 40, 18] : kind === "medium" ? 14 : 8);
    return;
  }
  if (isIOS()) {
    const l = iosLabel();
    if (!l) return;
    tap(l);
    if (kind === "heavy") setTimeout(() => tap(l), 70);
  }
}
