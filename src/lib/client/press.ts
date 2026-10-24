"use client";

import { useEffect, useState } from "react";

/** 離してからこれより後（ms）に届いた click は、その押した操作のものとみなさない（click が来なかった押し方の後始末） */
export const CLICK_AFTER_UP_MS = 1000;

/** 覚えておく押した操作の数の上限（離したことが届かなかったものが溜まらないように） */
const MAX_PRESSES = 16;

type Press = { target: number; pointerId: number; upAt: number | null };

/**
 * 押した時点（pointerdown）で動かすボタンを、click だけが届く操作（読み上げソフトのダブルタップ・Enter・Space など）でも
 * 動かすための見張り。pointerdown で動かした操作に続く click は無視して、同じ入力を 2 回しない。
 * target はボタンの番号（マスの番号・数字）。指を 2 本使っても取り違えないよう、押した操作を 1 つずつ覚えておく
 */
export class PressGuard {
  private presses: Press[] = [];

  /** pointerdown で動かした */
  down(target: number, pointerId: number) {
    this.presses.push({ target, pointerId, upAt: null });
    if (this.presses.length > MAX_PRESSES) this.presses.shift();
  }

  /** ポインタを離した（どこで離したかによらない） */
  up(pointerId: number, now: number) {
    for (const p of this.presses) if (p.pointerId === pointerId && p.upAt === null) p.upAt = now;
  }

  /** 取り消された（スクロールなど）。その後に click は来ない */
  cancel(pointerId: number) {
    this.presses = this.presses.filter((p) => p.pointerId !== pointerId);
  }

  /**
   * target に click が届いた。動かすなら true、pointerdown で動かした操作の続きなら false。
   * 離してから CLICK_AFTER_UP_MS より経ったものは click が来なかったとみなして捨てる
   */
  click(target: number, now: number): boolean {
    this.presses = this.presses.filter((p) => p.upAt === null || now - p.upAt <= CLICK_AFTER_UP_MS);
    const i = this.presses.findIndex((p) => p.target === target);
    if (i === -1) return true;
    this.presses.splice(i, 1);
    return false;
  }
}

/** PressGuard を作り、どこで離しても・取り消されても知らせる */
export function usePressGuard(): PressGuard {
  const [guard] = useState(() => new PressGuard());
  useEffect(() => {
    const up = (e: PointerEvent) => guard.up(e.pointerId, performance.now());
    const cancel = (e: PointerEvent) => guard.cancel(e.pointerId);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [guard]);
  return guard;
}
