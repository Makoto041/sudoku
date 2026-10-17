"use client";

import { useEffect, useRef, useState } from "react";
import { sfx } from "@/lib/audio";
import type { Difficulty } from "@/lib/sudoku/core";
import { ApiError, describeError } from "@/lib/client/api";
import type { Settings } from "@/lib/client/settings";
import { ChevronRight, Close } from "./icons";

/** 各難易度で必要になる手筋（問題の作り方と同じ基準） */
const LEVEL_TECHNIQUES: [string, string][] = [
  ["かんたん", "シングル"],
  ["ふつう", "ロックドキャンディデート"],
  ["むずかしい", "ペア・トリプル・X-Wing"],
  ["エキスパート", "XY-Wing・XYZ-Wing・ソードフィッシュ"],
  ["鬼", "チェーンや仮定"],
  ["極", "何段も重ねた仮定"],
];

/** 遊び方の操作（ボタンの名前と、すること） */
const HOWTO_CONTROLS: [string, string][] = [
  ["数字", "マスを選んで数字を押す"],
  ["メモ", "ON の間は、数字を候補として書く"],
  ["消す", "選んだマスの数字やメモを消す。色が ON の間は色を外す"],
  ["戻す・進む", "1 手ずつ取り消す・やり直す"],
  ["複数選択", "盤面をなぞって選ぶ。数字はメモとしてまとめて入る。消すはメモだけ"],
  ["色", "ON の間は、選んだマスに色を付ける"],
  ["ヒント", "次に使える手筋を示す（今日の一問を除く）"],
  ["自動メモ", "候補をすべて書く（フリープレイ）"],
];

function Sheet({
  label,
  onClose,
  children,
  top = false,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
  /** 入力欄のあるシートは上に出し、iPhone のキーボードで隠れないようにする */
  top?: boolean;
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
      className={`sheet-backdrop${top ? " is-top" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      // pointerdown で閉じると、指を離したときの click が下のボタンに届いてしまう
      onClick={(e) => {
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
  onCreateTransfer,
  onClaim,
  onHowto,
  onClose,
}: {
  settings: Settings;
  playerName: string | null;
  onChange: (s: Settings) => void;
  onRename: () => void;
  onCreateTransfer: () => Promise<{ code: string; expiresAt: number }>;
  onClaim: (code: string) => Promise<void>;
  /** 設定を閉じて遊び方を開く */
  onHowto: () => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  return (
    <Sheet label="設定" onClose={onClose} top>
      <h2 className="sheet-title">設定</h2>
      <div className="toggle-list">
        <h3 className="toggle-heading">音と振動</h3>
        <Toggle label="効果音" checked={settings.sound} onChange={(v) => set({ sound: v })} />
        <Toggle label="振動" checked={settings.haptics} onChange={(v) => set({ haptics: v })} />
        <h3 className="toggle-heading">表示</h3>
        <Toggle
          label="間違いをすぐ表示"
          checked={settings.showMistakes}
          onChange={(v) => set({ showMistakes: v })}
        />
        <Toggle
          label="同じ数字を強調"
          checked={settings.highlightSame}
          onChange={(v) => set({ highlightSame: v })}
        />
        <Toggle
          label="行・列・ブロックを強調"
          checked={settings.highlightPeers}
          onChange={(v) => set({ highlightPeers: v })}
        />
        <Toggle
          label="残りの数を表示"
          checked={settings.showRemaining}
          onChange={(v) => set({ showRemaining: v })}
        />
        <Toggle
          label="揃ったら光らせる"
          hint="解き終えたときも含む"
          checked={settings.unitFx}
          onChange={(v) => set({ unitFx: v })}
        />
        <h3 className="toggle-heading">入力</h3>
        <Toggle
          label="周りのメモを自動で消す"
          hint="置いた数字を、同じ行・列・ブロックのメモから消す"
          checked={settings.autoClearNotes}
          onChange={(v) => set({ autoClearNotes: v })}
        />
        <Toggle
          label="ヒントの前に確認"
          checked={settings.confirmHint}
          onChange={(v) => set({ confirmHint: v })}
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
      <Transfer onCreate={onCreateTransfer} onClaim={onClaim} />
      <button type="button" className="settings-link" onClick={onHowto}>
        <span className="toggle-label">遊び方</span>
        <ChevronRight size={18} className="row-chevron" />
      </button>
    </Sheet>
  );
}

/** 遊び方。onPractice があれば、ルールの後に練習を開くボタンを出す */
export function HowtoSheet({ onPractice, onClose }: { onPractice?: () => void; onClose: () => void }) {
  return (
    <Sheet label="遊び方" onClose={onClose}>
      <h2 className="sheet-title">遊び方</h2>
      <section className="howto-section">
        <h3 className="toggle-heading">ルール</h3>
        <ul className="howto-list">
          <li>9×9 のマスに 1〜9 の数字を入れる</li>
          <li>各行・各列・各ブロック（3×3）に、同じ数字を入れない</li>
          <li>最初から入っている数字は変えられない</li>
        </ul>
        {onPractice && (
          <button type="button" className="btn small howto-try" onClick={onPractice}>
            練習してみる
          </button>
        )}
      </section>
      <section className="howto-section">
        <h3 className="toggle-heading">操作</h3>
        <dl className="howto-defs">
          {HOWTO_CONTROLS.map(([label, text]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="howto-section">
        <h3 className="toggle-heading">点数</h3>
        <ul className="howto-list">
          <li>正しい数字を置くと加点。続けて正解するとコンボで増える</li>
          <li>間違えると減点し、コンボが切れる</li>
          <li>行・列・ブロックが埋まるとボーナス</li>
          <li>速く解き終えるほど時間ボーナスが多い</li>
          <li>ヒントを使うとコンボが切れる。ヒントで埋めたマスは 0 点</li>
        </ul>
      </section>
      <section className="howto-section">
        <h3 className="toggle-heading">今日の一問</h3>
        <ul className="howto-list">
          <li>難易度ごとに 1 日 1 問。全員が同じ問題</li>
          <li>日本時間 0 時に切り替わる</li>
          <li>一時停止はできない</li>
          <li>ヒントと自動メモは使えない</li>
          <li>ランキングに載るのは最初のクリアだけ</li>
        </ul>
      </section>
      <section className="howto-section">
        <h3 className="toggle-heading">難易度と手筋</h3>
        <dl className="howto-defs">
          {LEVEL_TECHNIQUES.map(([label, techniques]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{techniques}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="howto-section howto-keys">
        <h3 className="toggle-heading">キーボード</h3>
        <dl className="keys muted small">
          <dt>1–9</dt>
          <dd>入力</dd>
          <dt>Shift + 1–9</dt>
          <dd>メモ</dd>
          <dt>ドラッグ</dt>
          <dd>複数選択（数字はメモ、消すはメモだけ）</dd>
          <dt>Shift / Ctrl / Cmd + クリック</dt>
          <dd>選択にマスを足す・外す</dd>
          <dt>矢印 / WASD</dt>
          <dd>移動</dd>
          <dt>N</dt>
          <dd>メモ切替</dd>
          <dt>C</dt>
          <dd>色切替（1–9 で色を選ぶ）</dd>
          <dt>Backspace</dt>
          <dd>消す</dd>
          <dt>Z</dt>
          <dd>戻す</dd>
          <dt>Shift + Z</dt>
          <dd>進む</dd>
          <dt>H</dt>
          <dd>ヒント（今日の一問を除く）</dd>
          <dt>Space</dt>
          <dd>一時停止（フリープレイ）</dd>
          <dt>Esc</dt>
          <dd>選択を外す</dd>
        </dl>
      </section>
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
    <Sheet label="名前" onClose={onClose} top>
      <h2 className="sheet-title">{difficulty ? "ランキングに表示する名前" : "名前を変更"}</h2>
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
          maxLength={12}
          onChange={(e) => setName(e.target.value)}
          placeholder="ニックネーム"
          autoComplete="nickname"
          enterKeyHint="go"
        />
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

/** 端末の引き継ぎ：コードを発行するか、別の端末で発行したコードを入れる */
function Transfer({
  onCreate,
  onClaim,
}: {
  onCreate: () => Promise<{ code: string; expiresAt: number }>;
  onClaim: (code: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"idle" | "issued" | "enter" | "done">("idle");
  const [code, setCode] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const issue = async () => {
    sfx.tap();
    setBusy(true);
    setError(null);
    try {
      const res = await onCreate();
      setCode(res.code);
      setMode("issued");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      await onClaim(input);
      setMode("done");
      sfx.ranked();
    } catch (err) {
      setError(
        err instanceof ApiError && (err.status === 404 || err.status === 400)
          ? "コードが見つかりません"
          : describeError(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const pretty = code ? `${code.slice(0, 4)}-${code.slice(4)}` : "";

  return (
    <div className="transfer">
      <span className="toggle-label">引き継ぎ</span>
      {mode === "idle" && (
        <div className="transfer-actions">
          <button type="button" className="btn small" onClick={issue} disabled={busy}>
            コードを発行
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              sfx.tap();
              setMode("enter");
            }}
          >
            コードを入力
          </button>
        </div>
      )}
      {mode === "issued" && (
        <div className="transfer-code">
          <span className="code mono">{pretty}</span>
          <button
            type="button"
            className="btn small"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(pretty);
                setCopied(true);
              } catch {
                /* 選んでコピーしてもらう */
              }
            }}
          >
            {copied ? "コピーしました" : "コピー"}
          </button>
          <span className="toggle-hint">24時間有効・1回だけ使えます</span>
        </div>
      )}
      {mode === "enter" && (
        <form
          className="transfer-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim() && !busy) void claim();
          }}
        >
          <input
            className="text-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="ABCD-EFGH"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={12}
            aria-label="引き継ぎコード"
            onFocus={(e) => {
              // キーボードが出たあとで入力欄を見える位置へ
              const el = e.currentTarget;
              setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 350);
            }}
          />
          <button type="submit" className="btn small primary" disabled={!input.trim() || busy}>
            引き継ぐ
          </button>
        </form>
      )}
      {mode === "done" && <span className="toggle-hint">引き継ぎました</span>}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
