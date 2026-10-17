"use client";

import { useEffect, useState } from "react";
import { iosNeedsInstall } from "@/lib/client/device";
import { KEYS, load, save } from "@/lib/client/storage";
import { Close, Share } from "./icons";

/** iOS の Safari には追加ボタンが出ないので、ホーム画面への追加方法を一度だけ案内する */
export function InstallHint() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (iosNeedsInstall() && !load<boolean>(KEYS.installHint)) setShow(true);
  }, []);
  if (!show) return null;
  return (
    <div className="hint-bar install-hint" role="note">
      <span className="install-step">
        <Share size={15} /> →「ホーム画面に追加」でアプリになります
      </span>
      <button
        type="button"
        className="icon-btn small"
        aria-label="閉じる"
        onClick={() => {
          save(KEYS.installHint, true);
          setShow(false);
        }}
      >
        <Close size={18} />
      </button>
    </div>
  );
}
