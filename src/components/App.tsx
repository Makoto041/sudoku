"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setSoundEnabled, sfx, unlockAudio } from "@/lib/audio";
import { setHapticsEnabled } from "@/lib/haptics";
import { DIFFICULTIES, parseGrid, type Difficulty } from "@/lib/sudoku/core";
import { generateExtremeAsync, generatePuzzle, jstDateKey } from "@/lib/sudoku/generator";
import { newGame, withSolution, type GameState } from "@/lib/game/state";
import { api, describeError, type SubmitResponse } from "@/lib/client/api";
import { getPlayer, setPlayerName, type Player } from "@/lib/client/player";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "@/lib/client/settings";
import { KEYS, load, remove, save } from "@/lib/client/storage";
import { Game } from "./Game";
import { Home, type DailyStatus } from "./Home";
import { Ranking } from "./Ranking";
import { ConfirmSheet, NameSheet, SettingsSheet } from "./Sheets";

type View =
  | { name: "home" }
  | { name: "game"; game: GameState; key: number }
  | { name: "ranking"; difficulty: Difficulty; date?: string };

type SheetState =
  | { kind: "settings" }
  | { kind: "name"; difficulty: Difficulty | null }
  | { kind: "confirmFree"; difficulty: Difficulty }
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

  useEffect(() => {
    clockOffset = load<number>(KEYS.clockOffset) ?? 0;
    setToday(serverToday());
    setSettings(loadSettings());
    setPlayer(getPlayer());
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

  // ブラウザの戻る操作でホームへ
  useEffect(() => {
    const onPop = () => {
      setView({ name: "home" });
      setSheet(null);
      setToday(serverToday());
      setRefresh((n) => n + 1);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const viewName = useRef(view.name);
  viewName.current = view.name;
  const go = useCallback((next: View) => {
    if (viewName.current === "home" && next.name !== "home") history.pushState({ v: next.name }, "");
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
  const startFree = useCallback(
    (difficulty: Difficulty) => {
      setSheet(null);
      sfx.tap();
      // 難しい問題は作るのに時間がかかるので、読み込み表示を描いてから作る
      setGenerating(difficulty);
      setTimeout(async () => {
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
        save(KEYS.free, game);
        setGenerating(null);
        openGame(game);
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

  const updateSettings = (s: Settings) => {
    setSettings(s);
    saveSettings(s);
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
            onRanking={() => {
              sfx.tap();
              go({ name: "ranking", difficulty: "easy" });
            }}
            onSettings={() => {
              sfx.tap();
              setSheet({ kind: "settings" });
            }}
          />
        </>
      )}
      {view.name === "game" && (
        <Game
          key={view.key}
          initial={view.game}
          settings={settings}
          player={player}
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
          playerName={player.name}
          onChange={updateSettings}
          onRename={() => setSheet({ kind: "name", difficulty: null })}
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
