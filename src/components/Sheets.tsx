"use client";

import { useEffect, useRef, useState } from "react";
import { sfx } from "@/lib/audio";
import { DIFFICULTY_LABEL, type Difficulty } from "@/lib/sudoku/core";
import type { Settings } from "@/lib/client/settings";
import { Close } from "./icons";

function Sheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet">
        <button type="button" className="icon-btn sheet-close" onClick={onClose} aria-label="閉じる">
          <Close />
        </button>
        {children}
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        className="toggle"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked);
          sfx.tap();
        }}
      />
    </label>
  );
}

export function SettingsSheet({
  settings,
  playerName,
  onChange,
  onRename,
  onClose,
}: {
  settings: Settings;
  playerName: string | null;
  onChange: (s: Settings) => void;
  onRename: () => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  return (
    <Sheet label="設定" onClose={onClose}>
      <h2 className="sheet-title">設定</h2>
      <div className="toggle-list">
        <Toggle label="効果音" checked={settings.sound} onChange={(v) => set({ sound: v })} />
        <Toggle
          label="振動"
          hint="対応している端末のみ"
          checked={settings.haptics}
          onChange={(v) => set({ haptics: v })}
        />
        <Toggle
          label="間違いをすぐ表示"
          hint="フリープレイで答えと違う数字を赤くします"
          checked={settings.showMistakes}
          onChange={(v) => set({ showMistakes: v })}
        />
        <Toggle
          label="同じ数字を強調"
          checked={settings.highlightSame}
          onChange={(v) => set({ highlightSame: v })}
        />
      </div>
      <div className="name-row">
        <span>
          <span className="toggle-label">ランキングの名前</span>
          <span className="toggle-hint">{playerName ?? "未設定"}</span>
        </span>
        <button type="button" className="btn small" onClick={onRename}>
          変更
        </button>
      </div>
      <p className="muted small keys">
        キーボード：1〜9 で入力 · Shift+数字 でメモ · 矢印で移動 · N でメモ切替 · Backspace で消す · Z
        で元に戻す
      </p>
    </Sheet>
  );
}

export function NameSheet({
  initial,
  difficulty,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  initial: string;
  /** 日次を始める前に聞く場合の難易度 */
  difficulty: Difficulty | null;
  busy: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const valid = name.trim().length > 0;
  return (
    <Sheet label="名前" onClose={onClose}>
      <h2 className="sheet-title">{difficulty ? "ランキングに参加" : "名前を変更"}</h2>
      <p className="muted small">ランキングに表示される名前です（12文字まで）</p>
      <form
        className="name-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) onSubmit(name.trim());
        }}
      >
        <input
          ref={input}
          className="text-input"
          value={name}
          maxLength={24}
          onChange={(e) => setName(e.target.value)}
          placeholder="ニックネーム"
          autoComplete="nickname"
          enterKeyHint="go"
        />
        {difficulty && (
          <p className="muted small">
            「{DIFFICULTY_LABEL[difficulty]}」を始めます。時間はサーバーで計測され、一時停止はできません。
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
        <button type="submit" className="btn primary" disabled={!valid || busy}>
          {busy ? <span className="spinner" /> : difficulty ? "はじめる" : "保存"}
        </button>
      </form>
    </Sheet>
  );
}

export function ConfirmSheet({
  title,
  body,
  confirm,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet label={title} onClose={onClose}>
      <h2 className="sheet-title">{title}</h2>
      <p className="muted">{body}</p>
      <div className="result-row">
        <button type="button" className="btn" onClick={onClose}>
          やめる
        </button>
        <button type="button" className="btn primary" onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </Sheet>
  );
}
