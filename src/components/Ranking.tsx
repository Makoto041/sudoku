"use client";

import { useCallback, useEffect, useState } from "react";
import { sfx } from "@/lib/audio";
import { DIFFICULTIES, DIFFICULTY_LABEL, type Difficulty } from "@/lib/sudoku/core";
import { formatTime } from "@/lib/game/state";
import { api, describeError, type LeaderboardResponse } from "@/lib/client/api";
import { ChevronLeft, Refresh } from "./icons";

type Scope = "daily" | "best";

type Props = {
  today: string;
  playerId: string;
  initialDifficulty: Difficulty;
  initialDate?: string;
  onBack: () => void;
};

export function Ranking({ today, playerId, initialDifficulty, initialDate, onBack }: Props) {
  const [scope, setScope] = useState<Scope>("daily");
  const [difficulty, setDifficulty] = useState<Difficulty>(initialDifficulty);
  const date = initialDate ?? today;
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await api.leaderboard({ scope, difficulty, date: scope === "daily" ? date : undefined, playerId }),
      );
    } catch (err) {
      setError(describeError(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [scope, difficulty, date, playerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const meVisible = data?.entries.some((e) => e.isMe);

  return (
    <div className="screen ranking">
      <header className="bar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="戻る">
          <ChevronLeft />
        </button>
        <div className="bar-title">
          <span className="bar-kicker">
            {scope === "daily" ? `今日の一問 · ${date.replaceAll("-", "/")}` : "全期間"}
          </span>
          <span className="bar-main">ランキング</span>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            sfx.tap();
            void load();
          }}
          aria-label="更新"
        >
          <Refresh className={loading ? "spin" : ""} />
        </button>
      </header>

      <div className="ranking-body">
        <div className="segmented" role="tablist">
          {(["daily", "best"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={scope === s}
              className={scope === s ? "is-active" : ""}
              onClick={() => {
                sfx.tap();
                setScope(s);
              }}
            >
              {s === "daily" ? "今日" : "歴代ベスト"}
            </button>
          ))}
        </div>

        <div className="diff-tabs" role="tablist">
          {DIFFICULTIES.map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={difficulty === d}
              className={difficulty === d ? "is-active" : ""}
              onClick={() => {
                sfx.tap();
                setDifficulty(d);
              }}
            >
              {DIFFICULTY_LABEL[d]}
            </button>
          ))}
        </div>

        <p className="muted small ranking-note">
          {scope === "daily"
            ? "今日の問題の最初のクリアタイム。日付は日本時間 0 時に切り替わります"
            : "今日の一問でのそれぞれの最速タイム"}
        </p>

        <div className="board-list" aria-busy={loading}>
          {error && <p className="empty">{error}</p>}
          {!error && data && data.entries.length === 0 && (
            <p className="empty">
              まだ記録がありません
              <br />
              <span className="muted small">最初のクリアを狙いましょう</span>
            </p>
          )}
          {!error && !data && loading && (
            <ol className="rows skeleton">
              {Array.from({ length: 6 }, (_, k) => (
                <li key={k} className="row" />
              ))}
            </ol>
          )}
          {data && data.entries.length > 0 && (
            <ol className="rows">
              {data.entries.map((e, k) => (
                <li key={k} className={`row${e.isMe ? " is-me" : ""}`}>
                  <span className={`rank rank-${e.rank <= 3 ? e.rank : "n"}`}>{e.rank}</span>
                  <span className="name">
                    {e.name}
                    {e.isMe && <span className="me-tag">あなた</span>}
                  </span>
                  <span className="time mono">{formatTime(e.timeMs)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        {data && (
          <div className="me-bar">
            {data.me ? (
              <>
                <span>
                  あなた <strong>{data.me.rank}</strong> 位<span className="muted"> / {data.total}人</span>
                </span>
                <span className="mono">{formatTime(data.me.timeMs)}</span>
              </>
            ) : (
              <span className="muted">
                {data.total}人が参加{meVisible ? "" : " · まだ記録がありません"}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
