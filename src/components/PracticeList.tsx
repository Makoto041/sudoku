"use client";

import { useMemo } from "react";
import { loadPracticeProgress } from "@/lib/client/practiceProgress";
import type { PracticeItem, PracticeKey } from "@/lib/sudoku/practice";
import { Check, ChevronLeft, ChevronRight } from "./icons";

type Props = {
  /** 局面のデータ。読み込み中は null */
  items: PracticeItem[] | null;
  /** 読み込めなかった */
  failed: boolean;
  onRetry: () => void;
  onBack: () => void;
  onOpen: (key: PracticeKey) => void;
};

/** 手筋の練習の一覧。項目ごとに解いた局面の数を出し、すべて解いた項目には印を付ける */
export function PracticeList({ items, failed, onRetry, onBack, onOpen }: Props) {
  const progress = useMemo(() => (items ? loadPracticeProgress(items) : {}), [items]);
  return (
    <div className="screen practice-list">
      <header className="bar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="ホームに戻る">
          <ChevronLeft />
        </button>
        <div className="bar-title">
          <h1 className="bar-main">手筋の練習</h1>
        </div>
        <span />
      </header>

      {items ? (
        <ul className="card practice-items">
          {items.map((item) => {
            const solved = progress[item.key]?.length ?? 0;
            const total = item.positions.length;
            const done = solved >= total;
            return (
              <li key={item.key}>
                <button
                  type="button"
                  className={`practice-row${done ? " is-done" : ""}`}
                  onClick={() => onOpen(item.key)}
                >
                  <span className="practice-name">{item.name}</span>
                  <span className="practice-count mono">
                    {done && <Check size={16} />}
                    {solved}/{total}
                  </span>
                  <ChevronRight size={18} className="row-chevron" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : failed ? (
        <div className="card practice-failed">
          <p className="error-text">読み込めませんでした</p>
          <button type="button" className="btn small" onClick={onRetry}>
            もう一度
          </button>
        </div>
      ) : (
        <div className="practice-loading">
          <span className="spinner" aria-label="読み込み中" />
        </div>
      )}
    </div>
  );
}
