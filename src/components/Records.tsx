"use client";

import { useEffect, useMemo, useState } from "react";
import { sfx } from "@/lib/audio";
import { DIFFICULTIES, DIFFICULTY_LABEL, type Difficulty } from "@/lib/sudoku/core";
import { formatPoints } from "@/lib/game/score";
import { formatTime } from "@/lib/game/state";
import { loadRecords } from "@/lib/client/history";
import { monthView, summarize, type ClearRecord } from "@/lib/client/records";
import { formatPlayTime, freeSummary, loadStats, totalPlayMs } from "@/lib/client/stats";
import { ACHIEVEMENTS, loadUnlocked, updateAchievements, type Unlocked } from "@/lib/client/achievements";
import { loadWeakCounts, topWeakTechniques } from "@/lib/client/weakTechniques";
import { loadPractice, type PracticeItem, type PracticeKey } from "@/lib/sudoku/practice";
import { Check, ChevronLeft, ChevronRight } from "./icons";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const NONE = "-";
const time = (ms: number | null) => (ms !== null ? formatTime(ms) : NONE);
const points = (n: number | null) => (n !== null ? formatPoints(n) : NONE);
/** 「2026/10/17」 */
const slashDate = (date: string) => date.split("-").map(Number).join("/");

type Props = {
  today: string;
  playerId: string;
  onBack: () => void;
  /** ヒントを使った手筋の行から、その手筋の練習を開く */
  onPractice: (key: PracticeKey) => void;
};

export function Records({ today, playerId, onBack, onPractice }: Props) {
  // ヒントを使った手筋の上位 3 件（端末内だけの回数）。開いている間は増えないので、開いたときに 1 回読む
  const [weak] = useState(() => topWeakTechniques(loadWeakCounts()));
  const [records, setRecords] = useState<ClearRecord[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [ym, setYm] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) }));
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  // 実績。練習の実績を判定するため、局面のデータも読む（読めなければ練習の実績は保存済みの分だけ）
  const [practice, setPractice] = useState<PracticeItem[] | null>(null);
  const [unlocked, setUnlocked] = useState<Unlocked>(() => loadUnlocked() ?? {});

  useEffect(() => {
    let alive = true;
    void loadRecords(playerId).then((r) => {
      if (!alive) return;
      setRecords(r.records);
      setOffline(r.offline);
    });
    loadPractice().then(
      (items) => {
        if (alive) setPractice(items);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [playerId]);

  // 履歴を取り直したら（端末に保存される）判定する。ここで見つかった達成は通知しない
  useEffect(() => {
    if (records) setUnlocked(updateAchievements(today, practice, false).unlocked);
  }, [records, practice, today]);
  // 保存は知っている実績だけ（sanitizeUnlocked と unlock）なので、数はキーの数
  const unlockedCount = Object.keys(unlocked).length;

  const summary = useMemo(() => summarize(records ?? [], today), [records, today]);
  const month = useMemo(() => monthView(summary, ym.y, ym.m, today), [summary, ym, today]);
  const stats = loadStats();
  const daily = summary.perDifficulty[difficulty];
  const free = freeSummary(stats[difficulty]);
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
          {month.days.map((d) => {
            const status = d.count ? `${d.count}問クリア` : d.isRest ? "休み" : "";
            return (
              <span
                key={d.date}
                className={`cal-day${d.count ? " is-played" : ""}${d.isRest ? " is-rest" : ""}${d.isToday ? " is-today" : ""}${d.isFuture ? " is-future" : ""}`}
                style={d.count ? { ["--n" as string]: d.count } : undefined}
                aria-label={`${d.day}日 ${status}`}
              >
                {d.day}
                {/*
                  休みは色だけでなく、文字と点線の枠でも示す。読み上げは「休」ではなく「休み」にする。
                  role の無い要素の aria-label を読まない環境（ブラウズモードなど）でも伝わるよう、中身にも入れる
                  （aria-label を読む環境では、名前が中身に置き換わるので二重には読まない）
                */}
                {d.isRest && (
                  <>
                    <span className="cal-rest" aria-hidden="true">
                      休
                    </span>
                    <span className="sr-only">休み</span>
                  </>
                )}
              </span>
            );
          })}
        </div>
        <div className="cal-foot muted small">
          {month.played} / {month.target} 日
        </div>
      </section>

      <section className="card" aria-label="全体">
        <table className="rec-table">
          <tbody>
            <Row label="合計プレイ時間" value={formatPlayTime(totalPlayMs(stats, summary.perDifficulty))} />
          </tbody>
        </table>
      </section>

      {weak.length > 0 && (
        <section className="card" aria-label="ヒントを使った手筋">
          <h2 className="card-title">ヒントを使った手筋</h2>
          <ul className="weak-list">
            {weak.map((row) => (
              <li key={row.key}>
                <button
                  type="button"
                  className="weak-row"
                  aria-label={`${row.name} ${row.count}回 練習を開く`}
                  onClick={() => onPractice(row.key)}
                >
                  <span className="weak-name">{row.name}</span>
                  <span className="weak-count mono">{row.count}回</span>
                  <ChevronRight size={18} className="row-chevron" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="diff-tabs" role="tablist" aria-label="難易度">
        {DIFFICULTIES.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={difficulty === d}
            className={difficulty === d ? "is-active" : ""}
            onClick={(e) => {
              sfx.tap();
              setDifficulty(d);
              // 横にはみ出していたら見える位置まで寄せる（開いたときは動かさない）
              e.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
            }}
          >
            {DIFFICULTY_LABEL[d]}
          </button>
        ))}
      </div>

      <section className="card" aria-label="今日の一問">
        <h2 className="card-title">今日の一問</h2>
        <table className="rec-table">
          <tbody>
            <Row label="クリア数" value={String(daily.clears)} />
            <Row label="平均時間" value={time(daily.avgMs)} />
            <Row label="最速" value={time(daily.bestMs)} />
            <Row label="最高点" value={points(daily.bestPoints)} />
            <Row label="平均点" value={points(daily.avgPoints)} />
          </tbody>
        </table>
      </section>

      <section className="card" aria-label="フリープレイ">
        <h2 className="card-title">フリープレイ</h2>
        <table className="rec-table">
          <tbody>
            <Row label="始めた数" value={free.started !== null ? String(free.started) : NONE} />
            <Row label="クリア数" value={String(free.clears)} />
            <Row
              label="クリア率"
              value={free.clearRate !== null ? `${Math.round(free.clearRate * 100)}%` : NONE}
            />
            <Row label="平均時間" value={time(free.avgMs)} />
            <Row label="最速" value={time(free.bestMs)} />
            <Row label="ノーミス最速" value={time(free.cleanBestMs)} />
            <Row label="最高点" value={points(free.bestPoints)} />
          </tbody>
        </table>
      </section>

      <section className="card" aria-label="実績">
        <div className="ach-head">
          <h2 className="card-title">実績</h2>
          <span className="ach-count mono">
            {unlockedCount} / {ACHIEVEMENTS.length}
          </span>
        </div>
        <ul className="ach-list">
          {ACHIEVEMENTS.map((a) => {
            const date = unlocked[a.id];
            const done = date !== undefined;
            return (
              <li key={a.id} className={`ach${done ? " is-done" : ""}`}>
                <span
                  className="ach-mark"
                  role={done ? "img" : undefined}
                  aria-label={done ? "達成済み" : undefined}
                >
                  {done && <Check size={14} />}
                </span>
                <span className="ach-name">{a.name}</span>
                {date && <span className="ach-date mono">{slashDate(date)}</span>}
                <span className="ach-desc">{a.desc}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="mono">{value}</td>
    </tr>
  );
}
