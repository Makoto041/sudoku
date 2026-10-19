"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setSoundEnabled, sfx, unlockAudio } from "@/lib/audio";
import { setHapticsEnabled } from "@/lib/haptics";
import { DIFFICULTIES, parseGrid, type Difficulty } from "@/lib/sudoku/core";
import { generateExtremeAsync, generatePuzzle, jstDateKey } from "@/lib/sudoku/generator";
import { newGame, withSolution, type GameState } from "@/lib/game/state";
import { api, describeError, type SubmitResponse } from "@/lib/client/api";
import { adoptPlayer, getPlayer, setPlayerName, type Player } from "@/lib/client/player";
import { deviceRecords, loadRecords } from "@/lib/client/history";
import { summarize } from "@/lib/client/records";
import { loadStats, mergeStats, recordFreeStart } from "@/lib/client/stats";
import { firstUnsolved, loadPracticeProgress, markPracticeSolved } from "@/lib/client/practiceProgress";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "@/lib/client/settings";
import { KEYS, load, remove, save } from "@/lib/client/storage";
import { howtoSeen, markHowtoSeen } from "@/lib/client/howto";
import { updateAchievements } from "@/lib/client/achievements";
import { disablePush, refreshPush, reminderOn } from "@/lib/client/push";
import { iosStandalone } from "@/lib/client/device";
import {
  fromLegacy,
  hasLocalData,
  isLegacyHost,
  legacyTarget,
  markMovedWithReminder,
  movedWithReminder,
  moveUrl,
  navigationAllowsClaim,
  parseMoveHash,
} from "@/lib/client/move";
import { loadPractice, type PracticeItem, type PracticeKey } from "@/lib/sudoku/practice";
import { Game } from "./Game";
import { Home, type DailyStatus } from "./Home";
import { Practice } from "./Practice";
import { PracticeList } from "./PracticeList";
import { Ranking } from "./Ranking";
import { Records } from "./Records";
import { ClaimSheet, ConfirmSheet, HowtoSheet, MoveSheet, NameSheet, SettingsSheet } from "./Sheets";

type View =
  | { name: "home" }
  | { name: "game"; game: GameState; key: number }
  | { name: "ranking"; difficulty: Difficulty; date?: string }
  | { name: "records" }
  | { name: "practiceList" }
  | { name: "practice"; key: PracticeKey; index: number };

type SheetState =
  | { kind: "settings" }
  | { kind: "howto" }
  | { kind: "name"; difficulty: Difficulty | null }
  | { kind: "confirmFree"; difficulty: Difficulty }
  | { kind: "move" }
  | { kind: "claim"; code: string; push: boolean; replace: boolean }
  | null;

function freeSeed() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return `${a[0].toString(36)}${a[1].toString(36)}`;
}

/**
 * 「今日」はサーバーの時計で決める。端末の時計がずれていても、保存した盤面と同じ日付で探せるように
 * サーバーとの差を覚えておく（今日の一問を始めたときに更新）。
 */
let clockOffset = 0;
const serverToday = () => jstDateKey(new Date(Date.now() + clockOffset));

function loadGame(key: string): GameState | null {
  const g = load<GameState>(key);
  return g && g.version === 1 && Array.isArray(g.values) && g.values.length === 81 ? g : null;
}

export function App() {
  const [mounted, setMounted] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [player, setPlayer] = useState<Player>({ id: "", name: null });
  const [view, setView] = useState<View>({ name: "home" });
  const [sheet, setSheet] = useState<SheetState>(null);
  const [today, setToday] = useState(() => serverToday());
  const [starting, setStarting] = useState<Difficulty | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [howtoHint, setHowtoHint] = useState(false);
  /**
   * 前の本番の URL で開いているとき（新しい URL へ移る案内を出す）。
   * standalone は iOS のホーム画面に追加したアプリか（新しい URL を開かずにコードを出す）
   */
  const [legacy, setLegacy] = useState<{ standalone: boolean } | null>(null);

  useEffect(() => {
    // 記録があるかは、開いたときに作る保存データ（プレイヤー・実績など）を書く前に見る
    const hadData = hasLocalData();
    const onLegacy = isLegacyHost(location.hostname);
    // 旧 URL で記録の無い端末は、そのまま新しい URL へ移る（何も保存しない）
    if (onLegacy && !hadData) {
      location.replace(legacyTarget(location.pathname, location.search));
      return;
    }
    // 引き継ぎのリンク（#code=）は通信の前に読み、URL から消す（履歴やブックマークにコードを残さない）。
    // 受け取るシートを開くのは、新しい URL で、旧 URL のページから新しく開かれたときだけ
    // （ほかのページから送られたリンクで、1 回のタップでプレイヤーを差し替えられないように。ほかは設定から入力する）
    const link = parseMoveHash(location.hash);
    if (link) history.replaceState(history.state, "", location.pathname + location.search);
    const [navigation] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (onLegacy) {
      setLegacy({ standalone: iosStandalone() });
      setSheet({ kind: "move" });
    } else if (link?.code && fromLegacy(document.referrer) && navigationAllowsClaim(navigation?.type)) {
      setSheet({ kind: "claim", code: link.code, push: link.push, replace: hadData });
    }
    clockOffset = load<number>(KEYS.clockOffset) ?? 0;
    setToday(serverToday());
    setSettings(loadSettings());
    setPlayer(getPlayer());
    setHowtoHint(!howtoSeen());
    // 実績の最初の判定。更新前からの達成は通知せずに保存し、次のクリアから新しく解除したものだけを出す
    // （ホームを描く前に済ませ、最初のクリアが初めての判定にならないようにする）
    updateAchievements(serverToday(), null, false);
    setMounted(true);
    // 日付が変わったときのために、画面に戻るたびに今日を確認する
    const onVisible = () => {
      if (document.visibilityState === "visible") setToday(serverToday());
    };
    document.addEventListener("visibilitychange", onVisible);
    // iOS は最初のタップで音を有効にする
    // タッチの pointerdown はユーザー操作とみなされないことがあるので、指を離したときにも再開する
    // （アプリ切り替えや着信で止まった後も、次の操作で鳴るようにする）
    const unlock = () => unlockAudio();
    const UNLOCK_EVENTS = ["pointerdown", "pointerup", "touchend", "keydown"] as const;
    for (const type of UNLOCK_EVENTS) window.addEventListener(type, unlock, { capture: true });
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      for (const type of UNLOCK_EVENTS) window.removeEventListener(type, unlock, { capture: true });
    };
  }, []);

  useEffect(() => {
    setSoundEnabled(settings.sound);
    setHapticsEnabled(settings.haptics);
  }, [settings]);

  const viewName = useRef(view.name);
  viewName.current = view.name;

  // ブラウザの戻る操作でホームへ。練習の局面からは一覧へ
  // （再読み込みするとホームから始まり、履歴に一覧の印が残るので、局面から戻るときだけ一覧にする）
  useEffect(() => {
    const onPop = () => {
      setSheet(null);
      if (history.state?.v === "practiceList" && viewName.current === "practice") {
        setView({ name: "practiceList" });
        return;
      }
      setView({ name: "home" });
      setToday(serverToday());
      setRefresh((n) => n + 1);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ホームから出るときと、練習の一覧から局面を開くときに履歴を積む（ブラウザの戻るで 1 つ前の画面へ）
  const go = useCallback((next: View) => {
    const from = viewName.current;
    if ((from === "home" && next.name !== "home") || (from === "practiceList" && next.name === "practice"))
      history.pushState({ v: next.name }, "");
    setView(next);
  }, []);

  const goHome = useCallback(() => {
    sfx.tap();
    if (history.state?.v) history.back();
    else {
      setView({ name: "home" });
      setToday(serverToday());
      setRefresh((n) => n + 1);
    }
  }, []);

  const daily = useMemo(() => {
    const out = {} as Record<Difficulty, DailyStatus>;
    for (const d of DIFFICULTIES) {
      out[d] = mounted
        ? { game: loadGame(KEYS.daily(today, d)), result: load<SubmitResponse>(KEYS.dailyResult(today, d)) }
        : { game: null, result: null };
    }
    return out;
    // refresh でホームに戻ったときに読み直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, today, refresh, view.name]);

  // 連続日数（端末の結果と、前回取ったサーバーの履歴から。開いたときに裏で取り直す）
  const [historyTick, setHistoryTick] = useState(0);
  useEffect(() => {
    if (!mounted || !player.id) return;
    void loadRecords(player.id).then(() => setHistoryTick((n) => n + 1));
  }, [mounted, player.id, refresh]);
  const streak = useMemo(
    () => (mounted ? summarize(deviceRecords(), today).streak : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mounted, today, refresh, historyTick, view.name],
  );

  // 毎日の通知を有効にしている端末は、開いたときに購読を登録し直す（期限を延ばす）。
  // 引き継ぎでプレイヤーが変わったときも、購読を新しいプレイヤーに移す
  useEffect(() => {
    if (mounted && player.id) void refreshPush(player.id);
  }, [mounted, player.id]);

  const free = useMemo(
    () => (mounted ? loadGame(KEYS.free) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mounted, refresh, view.name],
  );

  const openGame = useCallback(
    (game: GameState) => go({ name: "game", game: withSolution(game), key: Date.now() }),
    [go],
  );

  const startDaily = useCallback(
    async (difficulty: Difficulty, p: Player = player) => {
      setError(null);
      const saved = loadGame(KEYS.daily(today, difficulty));
      if (saved) {
        sfx.tap();
        openGame(saved);
        return;
      }
      if (!p.name) {
        sfx.tap();
        setSheet({ kind: "name", difficulty });
        return;
      }
      setStarting(difficulty);
      try {
        const res = await api.start(p.id, difficulty);
        // 端末の日付がずれていても、サーバーの日付で保存済みの盤面があればそれを続ける
        clockOffset = res.serverNow - Date.now();
        save(KEYS.clockOffset, clockOffset);
        setToday(res.date);
        const existing = loadGame(KEYS.daily(res.date, difficulty));
        if (existing && existing.daily?.sessionId === res.sessionId) {
          setSheet(null);
          sfx.tap();
          openGame(existing);
          return;
        }
        const game = newGame({
          mode: "daily",
          difficulty,
          seed: res.date,
          puzzle: parseGrid(res.puzzle),
          solution: null,
          daily: {
            sessionId: res.sessionId,
            date: res.date,
            startedAt: res.startedAt,
            clockOffset: res.serverNow - Date.now(),
          },
        });
        setSheet(null);
        if (res.finished) {
          setError("クリア済みです");
          return;
        }
        save(KEYS.daily(res.date, difficulty), game);
        sfx.tap();
        openGame(game);
      } catch (err) {
        setError(describeError(err));
        setSheet(null);
      } finally {
        setStarting(null);
      }
    },
    [player, today, openGame],
  );

  const [generating, setGenerating] = useState<Difficulty | null>(null);
  // 問題を作っている間は新しく始めない。続けて押されると、先に作った問題を途中の問題として開始数を二重に数える
  // （state はボタンを描き直すまで反映されないので ref で止める）
  const generatingRef = useRef(false);
  const startFree = useCallback(
    (difficulty: Difficulty) => {
      if (generatingRef.current) return;
      generatingRef.current = true;
      setSheet(null);
      sfx.tap();
      // 難しい問題は作るのに時間がかかるので、読み込み表示を描いてから作る
      setGenerating(difficulty);
      setTimeout(async () => {
        try {
          // 極は候補をたくさん作って選ぶので、少しずつ作って画面を止めない（端末では候補を少なめに）
          const p =
            difficulty === "extreme"
              ? await generateExtremeAsync(freeSeed(), 24)
              : generatePuzzle(freeSeed(), difficulty);
          const game = newGame({
            mode: "free",
            difficulty,
            seed: p.seed,
            puzzle: p.puzzle,
            solution: p.solution,
          });
          // 途中のフリープレイを上書きするなら、その経過時間も記録に足す（解き終えた問題は足さない）
          const prev = loadGame(KEYS.free);
          recordFreeStart(difficulty, prev && prev.status !== "solved" ? prev : null);
          save(KEYS.free, game);
          openGame(game);
        } finally {
          generatingRef.current = false;
          setGenerating(null);
        }
      }, 30);
    },
    [openGame],
  );

  const requestFree = useCallback(
    (difficulty: Difficulty) => {
      const cur = loadGame(KEYS.free);
      if (cur && cur.status !== "solved" && cur.history.length > 0) {
        sfx.tap();
        setSheet({ kind: "confirmFree", difficulty });
      } else {
        startFree(difficulty);
      }
    },
    [startFree],
  );

  // 手筋の練習。局面のデータは一覧を開くときに読む（最初の読み込みに含めない）
  const [practice, setPractice] = useState<PracticeItem[] | null>(null);
  const [practiceFailed, setPracticeFailed] = useState(false);
  const loadPracticeItems = useCallback(() => {
    setPracticeFailed(false);
    loadPractice().then(setPractice, () => setPracticeFailed(true));
  }, []);
  const openPracticeList = () => {
    sfx.tap();
    go({ name: "practiceList" });
    if (!practice) loadPracticeItems();
  };
  const openPractice = (key: PracticeKey) => {
    const item = practice?.find((i) => i.key === key);
    if (!practice || !item) return;
    sfx.tap();
    go({ name: "practice", key, index: firstUnsolved(item, loadPracticeProgress(practice)) });
  };
  const backToPracticeList = () => {
    sfx.tap();
    if (history.state?.v === "practice") history.back();
    else setView({ name: "practiceList" });
  };
  const practiceItem = view.name === "practice" ? practice?.find((i) => i.key === view.key) : undefined;

  // 実績の判定。notify はクリア・正解したときの判定で、新しく解除したものを fresh で返す
  const judge = useCallback(
    (notify: boolean) => updateAchievements(today, practice, notify),
    [today, practice],
  );
  // 実績：クリア以外で記録が変わったとき（サーバーの履歴を取り直した・練習のデータを読んだ）は、通知せずに保存する
  useEffect(() => {
    if (mounted) judge(false);
  }, [mounted, historyTick, judge]);

  // 遊び方の「練習してみる」：一覧を開き、局面のデータが揃ったら最初の項目（ネイキッドシングル）を開く。
  // 一覧の描画後に開くので、履歴は ホーム → 一覧 → 局面 になる（戻ると一覧、もう一度でホーム）。
  // 揃う前に一覧から離れたら開かない。読み込みに失敗しても、一覧の再試行で揃えばそのまま開く
  const [tryPractice, setTryPractice] = useState(false);
  useEffect(() => {
    if (!tryPractice) return;
    const onList = view.name === "practiceList";
    if (onList && !practice) return;
    setTryPractice(false);
    if (onList) openPractice("naked-single");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tryPractice, view.name, practice]);
  const startTryPractice = () => {
    setSheet(null);
    setTryPractice(true);
    openPracticeList();
  };

  const dismissHowtoHint = () => {
    markHowtoSeen();
    setHowtoHint(false);
  };
  const openHowto = () => {
    sfx.tap();
    dismissHowtoHint();
    setSheet({ kind: "howto" });
  };

  const updateSettings = (s: Settings) => {
    setSettings(s);
    saveSettings(s);
  };

  // 旧版や手で書き換えた余計な項目を送ると、サーバーの上限を超えて発行できないことがある
  const createTransfer = () => api.transfer({ playerId: player.id, name: player.name, stats: loadStats() });

  /** 引き継ぎコードを使い、受け取ったプレイヤーと記録に切り替える */
  const claim = async (code: string) => {
    const res = await api.claim(code);
    const next = adoptPlayer(res.playerId, res.name);
    if (res.stats && typeof res.stats === "object") mergeStats(res.stats);
    // 引き継いだ記録での達成は、クリアしたときに出さないよう先に保存する
    judge(false);
    setPlayer(next);
    setRefresh((n) => n + 1);
    void loadRecords(next.id);
  };

  /**
   * 新しい URL へ移るコードを発行し、ホーム画面に追加したアプリでなければ、コードを付けて新しい URL を開く。
   * 通知をオンにしていたら、この URL の購読を外す（移った先でもオンにすると 2 通届く）。
   * 外すと通知の印も消えるので、先に移るときの印を残し、発行し直したときも新しい URL で通知の項目を出す
   */
  const issueMove = async () => {
    const { code } = await createTransfer();
    const reminder = reminderOn();
    const push = reminder || movedWithReminder();
    if (reminder) {
      markMovedWithReminder();
      await disablePush(player.id);
    }
    if (!legacy?.standalone) location.assign(moveUrl(code, push));
    return { code, push };
  };

  const openMove = () => {
    sfx.tap();
    setSheet({ kind: "move" });
  };

  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const submitName = async (name: string, difficulty: Difficulty | null) => {
    setNameBusy(true);
    setNameError(null);
    const next = setPlayerName(name);
    setPlayer(next);
    try {
      if (difficulty) {
        await startDaily(difficulty, next);
      } else {
        await api.rename(next.id, name).catch(() => {});
        setSheet(null);
      }
    } catch (err) {
      setNameError(describeError(err));
    } finally {
      setNameBusy(false);
    }
  };

  if (!mounted) return <div className="screen boot" />;

  return (
    <>
      {view.name === "home" && (
        <>
          <Home
            today={today}
            daily={daily}
            free={free}
            starting={starting}
            generating={generating}
            error={error}
            onDaily={(d) => void startDaily(d)}
            onContinue={() => {
              const g = loadGame(KEYS.free);
              if (g) {
                sfx.tap();
                openGame(g);
              }
            }}
            onNewFree={requestFree}
            streak={streak}
            onRecords={() => {
              sfx.tap();
              go({ name: "records" });
            }}
            onRanking={() => {
              sfx.tap();
              go({ name: "ranking", difficulty: "easy" });
            }}
            onSettings={() => {
              sfx.tap();
              setSheet({ kind: "settings" });
            }}
            onPractice={openPracticeList}
            onHowto={openHowto}
            howtoHint={howtoHint}
            onCloseHowtoHint={dismissHowtoHint}
            onMove={legacy ? openMove : undefined}
          />
        </>
      )}
      {view.name === "game" && (
        <Game
          key={view.key}
          initial={view.game}
          settings={settings}
          player={player}
          onCleared={() => judge(true).fresh}
          generating={generating !== null}
          onExit={goHome}
          onOpenSettings={() => {
            sfx.tap();
            setSheet({ kind: "settings" });
          }}
          onRanking={(g) => {
            sfx.tap();
            setView({ name: "ranking", difficulty: g.difficulty, date: g.daily?.date });
          }}
          onNewFree={(g) => {
            remove(KEYS.free);
            startFree(g.difficulty);
          }}
        />
      )}
      {view.name === "records" && <Records today={today} playerId={player.id} onBack={goHome} />}
      {view.name === "practiceList" && (
        <PracticeList
          items={practice}
          failed={practiceFailed}
          onRetry={loadPracticeItems}
          onBack={goHome}
          onOpen={openPractice}
        />
      )}
      {view.name === "practice" && practice && practiceItem && (
        <Practice
          key={practiceItem.positions[view.index].id}
          item={practiceItem}
          index={view.index}
          settings={settings}
          onBack={backToPracticeList}
          onNext={() => {
            if (view.index + 1 < practiceItem.positions.length) {
              sfx.tap();
              setView({ ...view, index: view.index + 1 });
            } else backToPracticeList();
          }}
          onSolved={(id) => {
            markPracticeSolved(practice, view.key, id);
            return judge(true).fresh;
          }}
          onOpenSettings={() => {
            sfx.tap();
            setSheet({ kind: "settings" });
          }}
        />
      )}
      {view.name === "ranking" && (
        <Ranking
          today={today}
          playerId={player.id}
          initialDifficulty={view.difficulty}
          initialDate={view.date}
          onBack={goHome}
        />
      )}

      {sheet?.kind === "settings" && (
        <SettingsSheet
          settings={settings}
          playerId={player.id}
          playerName={player.name}
          onChange={updateSettings}
          onRename={() => setSheet({ kind: "name", difficulty: null })}
          onCreateTransfer={createTransfer}
          onClaim={claim}
          onHowto={openHowto}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "move" && legacy && (
        <MoveSheet standalone={legacy.standalone} onIssue={issueMove} onClose={() => setSheet(null)} />
      )}
      {sheet?.kind === "claim" && (
        <ClaimSheet
          code={sheet.code}
          push={sheet.push}
          replace={sheet.replace}
          playerId={player.id}
          onClaim={claim}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "howto" && (
        <HowtoSheet
          // 練習はホームから開いたときだけ（ゲームや練習の途中から開くと、戻る操作で一覧を通らない）
          onPractice={view.name === "home" ? startTryPractice : undefined}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "name" && (
        <NameSheet
          initial={player.name ?? ""}
          difficulty={sheet.difficulty}
          busy={nameBusy || starting !== null}
          error={nameError}
          onSubmit={(name) => void submitName(name, sheet.difficulty)}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.kind === "confirmFree" && (
        <ConfirmSheet
          title="新しい問題を始めますか？"
          body="途中のフリープレイは消えます。"
          confirm="新しく始める"
          onConfirm={() => startFree(sheet.difficulty)}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );
}
