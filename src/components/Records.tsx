"use client";

import { useEffect, useMemo, useState } from "react";
import { sfx } from "@/lib/audio";
import { DIFFICULTIES, DIFFICULTY_LABEL } from "@/lib/sudoku/core";
import { formatPoints } from "@/lib/game/score";
import { formatTime } from "@/lib/game/state";
import { loadRecords } from "@/lib/client/history";
import { monthView, summarize, type ClearRecord } from "@/lib/client/records";
import { bestScores } from "@/lib/client/stats";
import { ChevronLeft, ChevronRight } from "./icons";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

type Props = { today: string; playerId: string; onBack: () => void };

export function Records({ today, playerId, onBack }: Props) {
  const [records, setRecords] = useState<ClearRecord[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [ym, setYm] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) }));

  useEffect(() => {
    let alive = true;
    void loadRecords(playerId).then((r) => {
      if (!alive) return;
      setRecords(r.records);
      setOffline(r.offline);
    });
    return () => {
      alive = false;
    };
  }, [playerId]);

  const summary = useMemo(() => summarize(records ?? [], today), [records, today]);
  const month = useMemo(() => monthView(summary, ym.y, ym.m, today), [summary, ym, today]);
  const free = bestScores();
  const isCurrentMonth = `${ym.y}-${String(ym.m).padStart(2, "0")}` === today.slice(0, 7);

  const shift = (n: number) => {
    sfx.tap();
    setYm(({ y, m }) => {
      const t = y * 12 + (m - 1) + n;
      return { y: Math.floor(t / 12), m: (t % 12) + 1 };
    });
  };

  return (
    <div className="screen records">
      <header className="bar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="戻る">
          <ChevronLeft />
        </button>
        <div className="bar-title">
          <span className="bar-main">記録</span>
        </div>
        <span />
      </header>

      <section className="card streak-card" aria-label="連続記録">
        <div className="streak-main">
          <span className="streak-num mono">{summary.streak}</span>
          <span className="streak-unit">日連続</span>
        </div>
        <div className="streak-sub muted">
          最長 {summary.longest}日{offline && " · オフライン"}
        </div>
      </section>

      <section className="card" aria-label="カレンダー">
        <div className="cal-head">
          <button type="button" className="icon-btn small" onClick={() => shift(-1)} aria-label="前の月">
            <ChevronLeft size={18} />
          </button>
          <span className="cal-title">
            {ym.y}年{ym.m}月{month.perfect && <span className="perfect-chip">皆勤</span>}
          </span>
          <button
            type="button"
            className="icon-btn small"
            onClick={() => shift(1)}
            disabled={isCurrentMonth}
            aria-label="次の月"
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="cal-grid" role="grid">
          {WEEK.map((w) => (
            <span key={w} className="cal-week">
              {w}
            </span>
          ))}
          {Array.from({ length: month.firstWeekday }, (_, k) => (
            <span key={`b${k}`} />
          ))}
          {month.days.map((d) => (
            <span
              key={d.date}
              className={`cal-day${d.count ? " is-played" : ""}${d.isToday ? " is-today" : ""}${d.isFuture ? " is-future" : ""}`}
              style={d.count ? { ["--n" as string]: d.count } : undefined}
              aria-label={`${d.day}日 ${d.count ? `${d.count}問クリア` : ""}`}
            >
              {d.day}
            </span>
          ))}
        </div>
        <div className="cal-foot muted small">
          {month.played} / {month.target} 日
        </div>
      </section>

      <section className="card" aria-label="難易度ごとの記録">
        <h2 className="card-title">今日の一問</h2>
        <table className="rec-table">
          <thead>
            <tr>
              <th />
              <th>クリア</th>
              <th>最高点</th>
              <th>最速</th>
            </tr>
          </thead>
          <tbody>
            {DIFFICULTIES.map((d) => {
              const s = summary.perDifficulty[d];
              return (
                <tr key={d}>
                  <th>{DIFFICULTY_LABEL[d]}</th>
                  <td className="mono">{s.clears}</td>
                  <td className="mono">{s.bestPoints !== null ? formatPoints(s.bestPoints) : "—"}</td>
                  <td className="mono">{s.bestMs !== null ? formatTime(s.bestMs) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card" aria-label="フリープレイの最高点">
        <h2 className="card-title">フリープレイ</h2>
        <table className="rec-table">
          <tbody>
            {DIFFICULTIES.map((d) => (
              <tr key={d}>
                <th>{DIFFICULTY_LABEL[d]}</th>
                <td className="mono">{free[d] != null ? `${formatPoints(free[d]!)}点` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
