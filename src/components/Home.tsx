"use client";

import { DIFFICULTIES, DIFFICULTY_LABEL, type Difficulty } from "@/lib/sudoku/core";
import { elapsedOf, formatTime, type GameState } from "@/lib/game/state";
import type { SubmitResponse } from "@/lib/client/api";
import { bestScores } from "@/lib/client/stats";
import { formatPoints } from "@/lib/game/score";
import { ChevronRight, Gear, Trophy } from "./icons";
import { InstallHint } from "./InstallHint";
import { Logo } from "./Logo";

export type DailyStatus = { game: GameState | null; result: SubmitResponse | null };

type Props = {
  today: string;
  daily: Record<Difficulty, DailyStatus>;
  free: GameState | null;
  starting: Difficulty | null;
  /** フリープレイの問題を作っている難易度 */
  generating: Difficulty | null;
  error: string | null;
  onDaily: (difficulty: Difficulty) => void;
  onContinue: () => void;
  onNewFree: (difficulty: Difficulty) => void;
  onRanking: () => void;
  onSettings: () => void;
};

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

function longDate(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const w = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}月${d}日（${w}）`;
}

export function Home(props: Props) {
  const { today, daily, free, starting, generating, error } = props;
  const best = bestScores();
  const freeInProgress = free && free.status !== "solved" ? free : null;

  return (
    <div className="screen home">
      <header className="home-head">
        <div className="brand">
          <Logo size={34} />
          <h1>数独</h1>
        </div>
        <button type="button" className="icon-btn" onClick={props.onSettings} aria-label="設定">
          <Gear />
        </button>
      </header>

      <section className="card daily" aria-labelledby="daily-title">
        <div className="card-head">
          <div>
            <h2 id="daily-title">今日の一問</h2>
            <p className="muted small">{longDate(today)}</p>
          </div>
          <button type="button" className="chip-btn" onClick={props.onRanking}>
            <Trophy size={16} /> ランキング
          </button>
        </div>
        <ul className="daily-list">
          {DIFFICULTIES.map((d) => {
            const st = daily[d];
            const result = st.result;
            const playing = st.game && st.game.status !== "solved" && !result;
            const unsent = st.game?.status === "solved" && !result;
            return (
              <li key={d}>
                <button
                  type="button"
                  className={`daily-row${result ? " is-done" : ""}`}
                  onClick={() => props.onDaily(d)}
                  disabled={starting !== null}
                >
                  <span className={`level level-${d}`} aria-hidden="true">
                    {DIFFICULTIES.map((_, k) => (
                      <i key={k} className={k <= DIFFICULTIES.indexOf(d) ? "on" : ""} />
                    ))}
                  </span>
                  <span className="daily-name">{DIFFICULTY_LABEL[d]}</span>
                  <span className="daily-status">
                    {starting === d ? (
                      <span className="spinner" aria-label="読み込み中" />
                    ) : result ? (
                      <>
                        <span className="mono">
                          {result.points !== undefined
                            ? `${formatPoints(result.points)}点`
                            : formatTime(result.timeMs)}
                        </span>
                        {result.rank !== null && <span className="rank-pill">{result.rank}位</span>}
                      </>
                    ) : unsent ? (
                      <span className="accent">未送信</span>
                    ) : playing ? (
                      <span className="accent">続ける · {formatTime(elapsedOf(st.game!))}</span>
                    ) : (
                      <span className="muted">挑戦する</span>
                    )}
                  </span>
                  <ChevronRight size={18} className="row-chevron" />
                </button>
              </li>
            );
          })}
        </ul>
        {error && <p className="error-text">{error}</p>}
      </section>

      <section className="card" aria-labelledby="free-title">
        <div className="card-head">
          <div>
            <h2 id="free-title">フリープレイ</h2>
            <p className="muted small">ヒントと一時停止が使えます</p>
          </div>
        </div>
        {freeInProgress && (
          <button type="button" className="continue" onClick={props.onContinue}>
            <span>
              <span className="continue-label">続きから</span>
              <span className="continue-meta">
                {DIFFICULTY_LABEL[freeInProgress.difficulty]} · {formatTime(freeInProgress.elapsedMs)} ·{" "}
                {progress(freeInProgress)}%
              </span>
            </span>
            <ChevronRight size={20} />
          </button>
        )}
        <div className="free-grid">
          {DIFFICULTIES.map((d) => (
            <button
              key={d}
              type="button"
              className={`free-btn free-${d}`}
              onClick={() => props.onNewFree(d)}
              disabled={generating !== null}
            >
              <span className="free-name">{DIFFICULTY_LABEL[d]}</span>
              <span className="free-best muted">
                {generating === d ? (
                  <span className="spinner" aria-label="作成中" />
                ) : best[d] != null ? (
                  `ベスト ${formatPoints(best[d]!)}点`
                ) : (
                  "新しい問題"
                )}
              </span>
            </button>
          ))}
        </div>
      </section>

      <InstallHint />
    </div>
  );
}

function progress(g: GameState) {
  const total = g.puzzle.filter((v) => !v).length;
  const filled = g.values.filter((v, i) => v && !g.puzzle[i]).length;
  return Math.round((filled / Math.max(1, total)) * 100);
}
