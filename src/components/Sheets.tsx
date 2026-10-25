"use client";

import { useEffect, useId, useRef, useState } from "react";
import { sfx } from "@/lib/audio";
import type { Difficulty } from "@/lib/sudoku/core";
import {
  accountError,
  passkeySupported,
  prepareLogin,
  preparePasskey,
  prepareSignup,
  type AccountAction,
  type AccountState,
} from "@/lib/client/account";
import { ApiError, describeError, describeIssueError } from "@/lib/client/api";
import { disablePush, enablePush, loadPushState, type PushError, type PushState } from "@/lib/client/push";
import type { TextSize, Theme } from "@/lib/client/display";
import type { Settings } from "@/lib/client/settings";
import { SITE_HOST } from "@/lib/site";
import { formatCode } from "@/lib/transfer-code";
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
  busy = false,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
  /** 入力欄のあるシートは上に出し、iPhone のキーボードで隠れないようにする */
  top?: boolean;
  /** 処理中は閉じさせない（×・Escape・背景のタップ）。閉じた後に処理が終わると、ほかの画面でプレイヤーが替わり、失敗も示せない */
  busy?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);
  return (
    <div
      className={`sheet-backdrop${top ? " is-top" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      // pointerdown で閉じると、指を離したときの click が下のボタンに届いてしまう
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="sheet">
        <button
          type="button"
          className="icon-btn sheet-close"
          onClick={onClose}
          disabled={busy}
          aria-label="閉じる"
        >
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
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={`toggle-row${disabled ? " is-disabled" : ""}`}>
      <span>
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        className="toggle"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.checked);
          sfx.tap();
        }}
      />
    </label>
  );
}

const THEME_OPTIONS: [Theme, string][] = [
  ["auto", "自動"],
  ["light", "ライト"],
  ["dark", "ダーク"],
];

const TEXT_SIZE_OPTIONS: [TextSize, string][] = [
  ["normal", "標準"],
  ["large", "大"],
  ["xlarge", "特大"],
];

/** いくつかから 1 つを選ぶ項目（ラジオボタン。矢印キーでも選べる） */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <div className="choice-row" role="radiogroup" aria-labelledby={id}>
      <span id={id} className="toggle-label">
        {label}
      </span>
      <div className="segmented">
        {options.map(([v, text]) => (
          <label key={v} className={v === value ? "is-active" : undefined}>
            <input
              type="radio"
              name={id}
              value={v}
              checked={v === value}
              onChange={() => {
                onChange(v);
                sfx.tap();
              }}
            />
            {text}
          </label>
        ))}
      </div>
    </div>
  );
}

/** 毎日の通知の注記。届く条件は src/lib/server/push.ts の sendReminders と vercel.json の cron に合わせる */
const REMINDER_NOTES: Record<Exclude<PushState, "unavailable">, string> = {
  on: "今日の一問を 1 問もクリアしていない日の 20 時（日本時間）",
  off: "今日の一問を 1 問もクリアしていない日の 20 時（日本時間）",
  "needs-install": "ホーム画面に追加したアプリで設定できます",
  unsupported: "この端末では使えません",
  denied: "通知が許可されていません",
};

const REMINDER_ERRORS: Record<PushError, string> = {
  "rate-limited": "しばらくしてからもう一度試してください",
  offline: "オフラインです",
  failed: "設定できませんでした",
};

/**
 * 毎日の通知のトグル。状態を読み終えるまでと、サーバーに通知の設定が無いときは何も出さない。
 * 閉じる前に始めた操作がまだ終わっていなければ、loadPushState がそれを待つので、終わるまで出さない（押せない）
 */
function Reminder({ playerId }: { playerId: string }) {
  const [state, setState] = useState<PushState | null>(null);
  /** 操作中の切り替え先（操作中はトグルを押せなくする） */
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void loadPushState().then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (state === null || state === "unavailable") return null;

  // 有効にするときは、許可を求めるためにタップの処理の中で enablePush を呼ぶ（await の前に呼ぶ）
  const change = async (on: boolean) => {
    setPending(on);
    setError(null);
    const res = await (on ? enablePush(playerId) : disablePush(playerId));
    setState(res.state);
    setError(res.error ? REMINDER_ERRORS[res.error] : null);
    setPending(null);
  };
  return (
    <>
      <h3 className="toggle-heading">通知</h3>
      <Toggle
        label="毎日の通知"
        hint={REMINDER_NOTES[state]}
        checked={pending ?? state === "on"}
        disabled={pending !== null || (state !== "on" && state !== "off")}
        onChange={(v) => void change(v)}
      />
      {error && <p className="error-text">{error}</p>}
    </>
  );
}

export function SettingsSheet({
  settings,
  playerId,
  playerName,
  onChange,
  onRename,
  account,
  onAccount,
  onCreateTransfer,
  onClaim,
  onHowto,
  onClose,
}: {
  settings: Settings;
  playerId: string;
  playerName: string | null;
  onChange: (s: Settings) => void;
  onRename: () => void;
  account: AccountState;
  /** 設定を閉じてアカウントを開く。無ければアカウントの行を出さない */
  onAccount?: () => void;
  onCreateTransfer: () => Promise<{ code: string; expiresAt: number }>;
  /** 引き継ぎのコードを使う。無ければコードを入れさせない */
  onClaim?: (code: string) => Promise<void>;
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
        <Choice
          label="テーマ"
          value={settings.theme}
          options={THEME_OPTIONS}
          onChange={(v) => set({ theme: v })}
        />
        <Choice
          label="文字サイズ"
          value={settings.textSize}
          options={TEXT_SIZE_OPTIONS}
          onChange={(v) => set({ textSize: v })}
        />
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
        <Toggle
          label="時計と得点を隠す"
          checked={settings.hideClock}
          onChange={(v) => set({ hideClock: v })}
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
        <Reminder playerId={playerId} />
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
      {onAccount && <AccountRow account={account} onOpen={onAccount} />}
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

/**
 * 確認のシート。onConfirm が Promise を返すときは、終わるまで押せなくし、失敗したら describe の文言を出す
 * （describe が null を返す失敗は何も出さない）
 */
export function ConfirmSheet({
  title,
  body,
  confirm,
  onConfirm,
  describe = describeError,
  onClose,
}: {
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => void | Promise<void>;
  describe?: (err: unknown) => string | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    const done = onConfirm();
    if (!done) return;
    setBusy(true);
    try {
      await done;
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet label={title} onClose={onClose} busy={busy}>
      <h2 className="sheet-title">{title}</h2>
      <p className="muted">{body}</p>
      {error && <p className="error-text">{error}</p>}
      <div className="result-row">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          やめる
        </button>
        <button type="button" className="btn primary" onClick={() => void run()} disabled={busy}>
          {busy ? <span className="spinner" /> : confirm}
        </button>
      </div>
    </Sheet>
  );
}

/** 引き継ぎコードを使えなかったときの文言 */
function claimError(err: unknown): string {
  return err instanceof ApiError && (err.status === 404 || err.status === 400)
    ? "コードが見つかりません"
    : describeError(err);
}

/** 発行した引き継ぎコードとコピーのボタン */
function IssuedCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const pretty = formatCode(code);
  return (
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
  );
}

/**
 * 旧 URL から新しい URL へ移る。ふつうはコードを付けて新しい URL を開き（onIssue が開く）、
 * iOS のホーム画面に追加したアプリでは開かずに、コードと手順を出す
 */
export function MoveSheet({
  standalone,
  onIssue,
  onClose,
}: {
  /** iOS のホーム画面に追加したアプリか */
  standalone: boolean;
  /** コードを発行する。push は通知をオンにしていたか（オンなら旧 URL の通知を止めてある） */
  onIssue: () => Promise<{ code: string; push: boolean }>;
  onClose: () => void;
}) {
  const [issued, setIssued] = useState<{ code: string; push: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 移った先からブラウザの戻るで（ページを保存したまま）戻ってきたら、また押せるようにする
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const issue = async () => {
    sfx.tap();
    setBusy(true);
    setError(null);
    try {
      const res = await onIssue();
      // 新しい URL を開いた（onIssue が開く）ときは busy のまま返し、移るまで押せないままにする
      if (!standalone) return;
      setIssued(res);
    } catch (err) {
      setError(describeIssueError(err));
    }
    setBusy(false);
  };

  return (
    <Sheet label="新しい URL へ移る" onClose={onClose}>
      <h2 className="sheet-title">新しい URL へ移る</h2>
      <p className="move-url">{SITE_HOST}</p>
      {issued ? (
        <>
          <IssuedCode code={issued.code} />
          <ol className="howto-list move-steps">
            <li>Safari で {SITE_HOST} を開く</li>
            <li>共有メニューの「ホーム画面に追加」</li>
            <li>追加したアプリの設定で「コードを入力」</li>
          </ol>
          {issued.push && <p className="muted small">通知は新しい URL で設定し直してください</p>}
        </>
      ) : (
        <button type="button" className="btn primary" onClick={issue} disabled={busy}>
          {busy ? <span className="spinner" /> : standalone ? "コードを発行" : "記録を移して開く"}
        </button>
      )}
      {error && <p className="error-text">{error}</p>}
    </Sheet>
  );
}

/**
 * 新しい URL で、旧 URL から付けてきたコードを受け取る。開いただけでは使わず、「引き継ぐ」を押したときに使う
 * （知らないリンクで勝手にプレイヤーが替わったり、コードを使い切ったりしないように）
 */
export function ClaimSheet({
  code,
  push,
  replace,
  playerId,
  onClaim,
  onClose,
}: {
  code: string;
  /** 旧 URL で通知をオンにしていたか（引き継いだあとに通知の項目を出す） */
  push: boolean;
  /** この端末に記録があるか（プレイヤーが置き換わることを示す） */
  replace: boolean;
  playerId: string;
  onClaim: (code: string) => Promise<void>;
  onClose: () => void;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const claim = async () => {
    sfx.tap();
    setState("busy");
    setError(null);
    try {
      await onClaim(code);
      setState("done");
      sfx.ranked();
    } catch (err) {
      setError(claimError(err));
      setState("idle");
    }
  };

  return (
    <Sheet label="引き継ぎ" onClose={onClose}>
      <h2 className="sheet-title">引き継ぎ</h2>
      <div className="transfer-code">
        <span className="code mono">{formatCode(code)}</span>
      </div>
      {state === "done" ? (
        <>
          <p className="muted">引き継ぎました</p>
          {push && (
            <div className="toggle-list">
              <Reminder playerId={playerId} />
            </div>
          )}
        </>
      ) : (
        <>
          {replace && <p className="muted small">この端末のプレイヤーは置き換わります</p>}
          {error && <p className="error-text">{error}</p>}
          <div className="result-row">
            <button type="button" className="btn" onClick={onClose}>
              やめる
            </button>
            <button type="button" className="btn primary" onClick={claim} disabled={state === "busy"}>
              {state === "busy" ? <span className="spinner" /> : "引き継ぐ"}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/** 端末の引き継ぎ：コードを発行するか、別の端末で発行したコードを入れる（onClaim が無ければ入れられない） */
function Transfer({
  onCreate,
  onClaim,
}: {
  onCreate: () => Promise<{ code: string; expiresAt: number }>;
  onClaim?: (code: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"idle" | "issued" | "enter" | "done">("idle");
  const [code, setCode] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issue = async () => {
    sfx.tap();
    setBusy(true);
    setError(null);
    try {
      const res = await onCreate();
      setCode(res.code);
      setMode("issued");
    } catch (err) {
      setError(describeIssueError(err));
    } finally {
      setBusy(false);
    }
  };

  const claim = async () => {
    if (!onClaim) return;
    setBusy(true);
    setError(null);
    try {
      await onClaim(input);
      setMode("done");
      sfx.ranked();
    } catch (err) {
      setError(claimError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="transfer">
      <span className="toggle-label">引き継ぎ</span>
      {mode === "idle" && (
        <div className="transfer-actions">
          <button type="button" className="btn small" onClick={issue} disabled={busy}>
            コードを発行
          </button>
          {onClaim && (
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
          )}
        </div>
      )}
      {mode === "issued" && <IssuedCode code={code} />}
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

/** 設定のアカウントの行。確かめている途中・使えないサーバー（旧 URL など）では出さない */
function AccountRow({ account, onOpen }: { account: AccountState; onOpen: () => void }) {
  if (account.status !== "signed-in" && account.status !== "signed-out") return null;
  if (account.status === "signed-out" && !passkeySupported()) {
    return (
      <div className="settings-link">
        <span>
          <span className="toggle-label">アカウント</span>
          <span className="toggle-hint">この端末では使えません</span>
        </span>
      </div>
    );
  }
  return (
    <button type="button" className="settings-link" onClick={onOpen}>
      <span>
        <span className="toggle-label">アカウント</span>
        <span className="toggle-hint">
          {account.status === "signed-in" ? "ログイン中" : "ログインしていません"}
        </span>
      </span>
      <ChevronRight size={18} className="row-chevron" />
    </button>
  );
}

/**
 * アカウント（パスキー）。ログインしていなければログインと作成、ログイン中ならパスキーの追加とログアウト・削除。
 * パスキーの操作の options は開いたときと操作の後に先取りし、押したら待たずに操作を始める（onLogin・onCreate・onAdd が始める）。
 * ログインしていない表示は、パスキーを使える端末でだけ開く（AccountRow）
 */
export function AccountSheet({
  account,
  playerId,
  onLogin,
  onCreate,
  onAdd,
  onLogoutOthers,
  onLogout,
  onDelete,
  onClose,
}: {
  account: Extract<AccountState, { status: "signed-in" | "signed-out" }>;
  playerId: string;
  onLogin: () => Promise<void>;
  onCreate: () => Promise<void>;
  onAdd: () => Promise<void>;
  onLogoutOthers: () => Promise<void>;
  /** 確認のシートを開く */
  onLogout: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const accountPlayerId = account.status === "signed-in" ? account.account.playerId : null;
  /** ログイン中に、パスキーを足せるか（パスキーを使えない端末でも、ログイン中ならログアウトなどはできる） */
  const canAdd = accountPlayerId !== null && passkeySupported();
  /** 実行中の操作。押せなくするので、続けて押しても 1 回だけ */
  const [busy, setBusy] = useState<AccountAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 操作を終えた回数。終えるたびに options を取り直す（使った challenge は 1 回だけ） */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (accountPlayerId === null) {
      void prepareLogin();
      void prepareSignup(playerId);
    } else if (canAdd) {
      void preparePasskey(accountPlayerId);
    }
  }, [accountPlayerId, canAdd, playerId, attempt]);

  const run = (action: AccountAction, op: () => Promise<void>, success: string) => {
    if (busy) return;
    // パスキーの画面は、押した処理の中で最初の await より前に出す（op が始める）ので、ほかの処理より先に呼ぶ
    const done = op();
    sfx.tap();
    setBusy(action);
    setNotice(null);
    setError(null);
    done
      .then(
        () => setNotice(success),
        (err: unknown) => setError(accountError(err, action)),
      )
      .finally(() => {
        setBusy(null);
        setAttempt((n) => n + 1);
      });
  };
  const label = (action: AccountAction, text: string) =>
    busy === action ? <span className="spinner" /> : text;

  return (
    <Sheet label="アカウント" onClose={onClose} busy={busy !== null}>
      <h2 className="sheet-title">アカウント</h2>
      {account.status === "signed-in" ? (
        <>
          <div className="name-row">
            <span>
              <span className="toggle-label">パスキー</span>
              <span className="toggle-hint">{account.account.passkeys} 件</span>
            </span>
            {canAdd && (
              <button
                type="button"
                className="btn small"
                disabled={busy !== null}
                onClick={() => run("add", onAdd, "追加しました")}
              >
                {label("add", "追加")}
              </button>
            )}
          </div>
          <div className="account-actions">
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => run("other", onLogoutOthers, "ほかの端末をログアウトしました")}
            >
              {label("other", "ほかの端末をログアウト")}
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={onLogout}>
              ログアウト
            </button>
            <button type="button" className="btn danger" disabled={busy !== null} onClick={onDelete}>
              アカウントを削除
            </button>
          </div>
        </>
      ) : (
        <div className="account-actions">
          <button
            type="button"
            className="btn primary"
            disabled={busy !== null}
            onClick={() => run("login", onLogin, "ログインしました")}
          >
            {label("login", "ログイン")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => run("signup", onCreate, "作成しました")}
          >
            {label("signup", "アカウントを作成")}
          </button>
        </div>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
