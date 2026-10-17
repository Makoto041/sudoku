"use client";

import { useEffect, useRef } from "react";
import { sfx } from "@/lib/audio";
import { haptic } from "@/lib/haptics";

/** 盤面の誤り（行き詰まり・正解の数字を消したメモなど）が出たときに、音と振動で 1 回知らせる */
export function useStuckAlert(active: boolean) {
  const was = useRef(active);
  useEffect(() => {
    if (active && !was.current) {
      sfx.error();
      haptic("medium");
    }
    was.current = active;
  }, [active]);
}
