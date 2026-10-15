"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sfx } from "@/lib/audio";
import { DIFFICULTIES, DIFFICULTY_LABEL, type Difficulty } from "@/lib/sudoku/core";
import { formatPoints } from "@/lib/game/score";
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

  // タブを素早く切り替えたとき、遅れて届いた古い応答で表示を上書きしない
  const latest = useRef(0);
  const load = useCallback(async () => {
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.leaderboard({
        scope,
        difficulty,
        date: scope === "daily" ? date : undefined,
        playerId,
      });
      if (id === latest.current) setData(res);
    } catch (err) {
      if (id !== latest.current) return;
      setError(describeError(err));
      setData(null);
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, [scope, difficulty, date, playerId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 選んだ難易度のタブが横にはみ出していたら見える位置まで寄せる
  const tabs = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabs.current
      ?.querySelector<HTMLElement>("[aria-selected=true]")
      ?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  }, [difficulty]);

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

        <div className="diff-tabs" role="tablist" ref={tabs}>
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

        <div className="board-list" aria-busy={loading}>
          {error && <p className="empty">{error}</p>}
          {!error && data && data.entries.length === 0 && <p className="empty">まだ記録がありません</p>}
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
                  <span className="score">
                    <span className="points mono">{formatPoints(e.points)}</span>
                    <span className="time mono">{formatTime(e.timeMs)}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        {data?.me && (
          <div className="me-bar">
            <span>
              あなた <strong>{data.me.rank}</strong> 位<span className="muted"> / {data.total}人</span>
            </span>
            <span className="mono">{formatPoints(data.me.points)}点</span>
          </div>
        )}
      </div>
    </div>
  );
}
