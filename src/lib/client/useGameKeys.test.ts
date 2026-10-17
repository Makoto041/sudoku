import { describe, expect, it } from "vitest";
import { keyCommand, type KeyInput } from "./useGameKeys";

/** key と、数字なら code を渡す。修飾キーは init で付ける */
const press = (key: string, init: Partial<KeyInput> = {}, paused = false) =>
  keyCommand(
    { key, code: "", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...init },
    paused,
  );

describe("キー操作", () => {
  it("数字は code で見て置き、Shift+数字はメモ。テンキーも同じ", () => {
    expect(press("5", { code: "Digit5" })).toEqual({
      run: { type: "input", digit: 5, asNote: undefined },
      prevent: true,
    });
    expect(press("%", { code: "Digit5", shiftKey: true })).toEqual({
      run: { type: "input", digit: 5, asNote: true },
      prevent: true,
    });
    expect(press("3", { code: "Numpad3" })?.run).toEqual({ type: "input", digit: 3, asNote: undefined });
    // 0 は消す
    expect(press("0", { code: "Digit0" })).toEqual({ run: { type: "erase" }, prevent: true });
  });

  it("戻す・進む。Shift を先に見るので Ctrl+Shift+Z は進む", () => {
    const redo = { run: { type: "redo" }, prevent: true };
    expect(press("Z", { shiftKey: true })).toEqual(redo);
    expect(press("Z", { shiftKey: true, ctrlKey: true })).toEqual(redo);
    expect(press("y", { ctrlKey: true })).toEqual(redo);
    expect(press("z", { ctrlKey: true })).toEqual({ run: { type: "undo" }, prevent: true });
    // 修飾キーなしの Z・U は既定の動作を止めない
    expect(press("z")).toEqual({ run: { type: "undo" }, prevent: false });
    expect(press("u")).toEqual({ run: { type: "undo" }, prevent: false });
  });

  it("Cmd・Alt 付きと、戻す・進む以外の Ctrl 付きは盤面の操作にしない", () => {
    expect(press("z", { metaKey: true })).toBe(null);
    expect(press("5", { code: "Digit5", altKey: true })).toBe(null);
    expect(press("c", { ctrlKey: true })).toBe(null);
    expect(press("5", { code: "Digit5", ctrlKey: true })).toBe(null);
  });

  it("矢印と WASD で動かして選ぶ音を鳴らす", () => {
    expect(press("ArrowUp")).toEqual({
      run: { type: "move", dr: -1, dc: 0 },
      prevent: true,
      sound: "select",
    });
    expect(press("d")?.run).toEqual({ type: "move", dr: 0, dc: 1 });
    expect(press("W", { shiftKey: true })).toBe(null);
  });

  it("消す・メモ・色・ヒント・選択の解除", () => {
    for (const key of ["Backspace", "Delete"])
      expect(press(key)).toEqual({ run: { type: "erase" }, prevent: true });
    for (const key of ["n", "N"]) {
      expect(press(key)).toEqual({ run: { type: "toggleNotes" }, prevent: false, sound: "tap" });
    }
    for (const key of ["c", "C"]) {
      expect(press(key)).toEqual({ run: { type: "toggleColors" }, prevent: false, sound: "tap" });
    }
    expect(press("h")).toEqual({ run: "hint", prevent: false });
    expect(press("H", { shiftKey: true })).toBe(null);
    expect(press("Escape")).toEqual({ run: { type: "select", cell: null }, prevent: false });
    expect(press("x")).toBe(null);
    expect(press("Enter")).toBe(null);
  });

  it("Space は一時停止中なら再開、そうでなければ一時停止", () => {
    expect(press(" ")).toEqual({ run: { type: "pause" }, prevent: true });
    expect(press(" ", {}, true)).toEqual({ run: { type: "resume" }, prevent: true });
  });
});
