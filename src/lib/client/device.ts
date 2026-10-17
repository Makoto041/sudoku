/**
 * iOS（iPhone・iPad）の Safari で、ホーム画面に追加していないページとして開いているか。
 * ホーム画面への追加の案内と、通知（iOS ではホーム画面に追加したアプリでだけ使える）の判定に使う。
 * アプリ内ブラウザ（iOS の Chrome・Firefox・Edge・LINE）は、Safari の共有メニューの案内が当てはまらないので含めない
 */
export function iosNeedsInstall(): boolean {
  const ua = navigator.userAgent;
  // iPadOS の Safari は Mac と名乗るので、タッチの点数で見分ける
  const ios =
    /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  const inApp = /CriOS|FxiOS|EdgiOS|Line\//.test(ua);
  return ios && !standalone && !inApp;
}
