/**
 * 効果音はすべて Web Audio でその場で合成する（音声ファイルなし）。
 * 数字を置くと、碁石を盤に打ったような「パチッ」という音が鳴る（数字ごとに響きの高さが少し違う）。
 * iOS は最初のタップで AudioContext を再開しないと鳴らないので unlock() を入力イベントで呼ぶ。
 */

type Ctx = {
  ctx: AudioContext;
  master: GainNode;
  dry: GainNode;
  reverb: GainNode;
};

let state: Ctx | null = null;
let enabled = true;

// C メジャーペンタトニック（C5 から 9 音）
const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51, 1567.98];

export function setSoundEnabled(value: boolean) {
  enabled = value;
}

function impulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

function setup(): Ctx | null {
  if (state) return state;
  if (typeof window === "undefined") return null;
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC({ latencyHint: "interactive" });
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.002;
  comp.release.value = 0.15;
  comp.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(comp);

  const dry = ctx.createGain();
  dry.connect(master);

  // 小さな部屋鳴り程度の残響で、音に柔らかい余韻を足す
  const convolver = ctx.createConvolver();
  convolver.buffer = impulse(ctx, 1.4, 3.2);
  const wet = ctx.createGain();
  wet.gain.value = 0.22;
  convolver.connect(wet);
  wet.connect(master);
  const reverb = ctx.createGain();
  reverb.connect(convolver);

  state = { ctx, master, dry, reverb };
  return state;
}

/** 入力イベントの中で呼ぶ。iOS の自動再生制限を解除する */
export function unlockAudio() {
  const s = setup();
  if (!s) return;
  if (s.ctx.state !== "running") {
    void s.ctx.resume();
    // 無音を 1 サンプル鳴らすと iOS の古い WebKit でも確実に再開する
    const src = s.ctx.createBufferSource();
    src.buffer = s.ctx.createBuffer(1, 1, 22050);
    src.connect(s.dry);
    src.start();
  }
}

/** 停止中でも予約した音は再開時に鳴るので、ここで再開を促してそのまま使う */
function ready(): Ctx | null {
  if (!enabled) return null;
  const s = setup();
  if (!s || s.ctx.state === "closed") return null;
  // iOS の着信などで止まっている間（interrupted）は予約しない。復帰時にまとめて鳴ってしまう
  if ((s.ctx.state as string) === "interrupted") return null;
  if (s.ctx.state !== "running") void s.ctx.resume();
  return s;
}

type ToneOptions = {
  freq: number;
  at?: number;
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  decay?: number;
  /** 終わりの周波数（ピッチを滑らせる） */
  toFreq?: number;
  reverb?: number;
  detune?: number;
};

function tone(s: Ctx, o: ToneOptions) {
  const t = s.ctx.currentTime + (o.at ?? 0);
  const attack = o.attack ?? 0.004;
  const decay = o.decay ?? 0.3;
  const osc = s.ctx.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.toFreq) osc.frequency.exponentialRampToValueAtTime(o.toFreq, t + decay * 0.6);
  if (o.detune) osc.detune.value = o.detune;
  const g = s.ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.gain ?? 0.2, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  osc.connect(g);
  g.connect(s.dry);
  if (o.reverb) {
    const send = s.ctx.createGain();
    send.gain.value = o.reverb;
    g.connect(send);
    send.connect(s.reverb);
  }
  osc.start(t);
  osc.stop(t + attack + decay + 0.05);
}

function noise(
  s: Ctx,
  o: {
    at?: number;
    duration: number;
    gain: number;
    from: number;
    to: number;
    q?: number;
    attack?: number;
    type?: BiquadFilterType;
  },
) {
  const t = s.ctx.currentTime + (o.at ?? 0);
  const length = Math.max(1, Math.floor(s.ctx.sampleRate * o.duration));
  const buffer = s.ctx.createBuffer(1, length, s.ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = s.ctx.createBufferSource();
  src.buffer = buffer;
  const filter = s.ctx.createBiquadFilter();
  filter.type = o.type ?? "bandpass";
  filter.Q.value = o.q ?? 1.2;
  filter.frequency.setValueAtTime(o.from, t);
  filter.frequency.exponentialRampToValueAtTime(o.to, t + o.duration);
  const g = s.ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.gain, t + (o.attack ?? 0.004));
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.duration);
  src.connect(filter);
  filter.connect(g);
  g.connect(s.dry);
  src.start(t);
  src.stop(t + o.duration + 0.02);
}

/** ベル風：非整数倍音で金属的な余韻 */
function bell(s: Ctx, freq: number, at = 0, gain = 0.14, decay = 0.9) {
  tone(s, { freq, at, gain, decay, reverb: 0.6 });
  tone(s, { freq: freq * 2.76, at, gain: gain * 0.35, decay: decay * 0.45, reverb: 0.5 });
  tone(s, { freq: freq * 5.4, at, gain: gain * 0.12, decay: decay * 0.2 });
}

const pitch = (digit: number) => PENTATONIC[Math.min(8, Math.max(0, digit - 1))];

/**
 * 碁石を盤に打つ音。
 *  - 当たった瞬間の「パチッ」：ごく短い高域のノイズ
 *  - 石の硬い響き：2〜4kHz の短い音
 *  - 盤（木）の胴鳴り：200〜500Hz の「コッ」と、少しの残響
 * size で石の大きさ（重さ）、tone で響きの高さを変える。毎回ほんの少し揺らして機械的にしない
 */
function stone(s: Ctx, o: { at?: number; gain?: number; size?: number; tone?: number } = {}) {
  const at = o.at ?? 0;
  const g = o.gain ?? 0.42;
  const size = o.size ?? 1;
  const p = (o.tone ?? 1) * (0.985 + Math.random() * 0.03);
  // パチッ
  noise(s, {
    at,
    duration: 0.01,
    gain: g * 1.6,
    from: 7000 * p,
    to: 3200 * p,
    q: 0.7,
    attack: 0.0005,
    type: "highpass",
  });
  noise(s, { at, duration: 0.035, gain: g * 0.6, from: 2600 * p, to: 1500 * p, q: 1.6, attack: 0.0008 });
  // 石の硬い響き
  tone(s, { freq: 2380 * p, at, gain: g * 0.35, attack: 0.0008, decay: 0.035 });
  tone(s, { freq: 3790 * p, at, gain: g * 0.2, attack: 0.0008, decay: 0.02 });
  // 盤の胴鳴り
  tone(s, {
    freq: 520 * p,
    toFreq: 470 * p,
    at,
    gain: g * 0.6 * size,
    attack: 0.001,
    decay: 0.09 * size,
    reverb: 0.25,
  });
  tone(s, {
    freq: 235 * p,
    toFreq: 205 * p,
    at,
    gain: g * 0.55 * size,
    attack: 0.0015,
    decay: 0.16 * size,
    reverb: 0.3,
  });
}

/** 数字ごとの響きの高さ（1 で低め、9 で高め。差はわずか） */
const stoneTone = (digit: number) => 0.93 + Math.min(8, Math.max(0, digit - 1)) * 0.018;

export const sfx = {
  /** マスを選ぶ：木を軽く叩いたような短いクリック */
  select() {
    const s = ready();
    if (!s) return;
    tone(s, { freq: 1250, toFreq: 820, gain: 0.07, attack: 0.002, decay: 0.045, type: "triangle" });
    noise(s, { duration: 0.012, gain: 0.03, from: 5200, to: 3600, q: 3 });
  },
  /** 画面のボタン */
  tap() {
    const s = ready();
    if (!s) return;
    tone(s, { freq: 900, toFreq: 700, gain: 0.06, attack: 0.002, decay: 0.05, type: "triangle" });
  },
  /** 数字を置く：碁石を打つ「パチッ」 */
  place(digit: number) {
    const s = ready();
    if (!s) return;
    stone(s, { tone: stoneTone(digit) });
  },
  /** メモ：小さく軽い石。消すときはさらに控えめ */
  note(digit: number, on: boolean) {
    const s = ready();
    if (!s) return;
    stone(s, { gain: on ? 0.16 : 0.1, size: 0.35, tone: stoneTone(digit) * 1.35 });
  },
  erase() {
    const s = ready();
    if (!s) return;
    noise(s, { duration: 0.13, gain: 0.07, from: 3400, to: 700, q: 0.9 });
    tone(s, { freq: 520, toFreq: 340, gain: 0.05, decay: 0.1, type: "triangle" });
  },
  undo() {
    const s = ready();
    if (!s) return;
    tone(s, { freq: 1318.5, gain: 0.07, decay: 0.07 });
    tone(s, { freq: 1046.5, at: 0.055, gain: 0.07, decay: 0.12, reverb: 0.2 });
  },
  /** 間違える前まで戻す：下がっていく 3 音 */
  rewind() {
    const s = ready();
    if (!s) return;
    [1568, 1318.5, 1046.5].forEach((f, k) =>
      tone(s, { freq: f, at: k * 0.06, gain: 0.07, decay: 0.12, reverb: 0.25 }),
    );
  },
  /** 間違い：耳障りにならない、低くこもった 2 音 */
  error() {
    const s = ready();
    if (!s) return;
    tone(s, { freq: 233, toFreq: 196, gain: 0.16, decay: 0.22, type: "triangle" });
    tone(s, { freq: 247, toFreq: 207, gain: 0.08, decay: 0.2, type: "sine", at: 0.01 });
    noise(s, { duration: 0.05, gain: 0.04, from: 900, to: 300, q: 1 });
  },
  /** 置けない操作 */
  blocked() {
    const s = ready();
    if (!s) return;
    tone(s, { freq: 300, toFreq: 260, gain: 0.05, decay: 0.06, type: "triangle" });
  },
  /** 行・列・ブロックが揃った：揃った数だけ上に重なるきらめき */
  unit(count: number, digit: number) {
    const s = ready();
    if (!s) return;
    const base = pitch(digit);
    stone(s, { tone: stoneTone(digit) });
    const steps = [1.25, 1.5, 2, 2.5, 3];
    for (let k = 0; k < Math.min(2 + count, steps.length); k++) {
      bell(s, base * steps[k], 0.07 + k * 0.065, 0.075, 0.7);
    }
  },
  hint(digit: number) {
    const s = ready();
    if (!s) return;
    bell(s, pitch(digit) * 2, 0, 0.08, 0.6);
    bell(s, pitch(digit) * 3, 0.08, 0.06, 0.6);
  },
  /** クリア：上昇するアルペジオと和音 */
  solved() {
    const s = ready();
    if (!s) return;
    // 石を続けて打ち、最後に和音
    const taps = 6;
    for (let k = 0; k < taps; k++) stone(s, { at: k * 0.07, gain: 0.3 + k * 0.03, tone: 0.92 + k * 0.035 });
    const chordAt = taps * 0.07 + 0.06;
    for (const f of [523.25, 659.25, 783.99, 987.77]) {
      tone(s, { freq: f, at: chordAt, gain: 0.05, attack: 0.05, decay: 1.6, reverb: 0.8 });
      tone(s, { freq: f * 2, at: chordAt, gain: 0.02, attack: 0.05, decay: 1.2, reverb: 0.8, detune: 6 });
    }
    bell(s, 2093.0, chordAt + 0.02, 0.07, 1.4);
  },
  /** ランキング登録 */
  ranked() {
    const s = ready();
    if (!s) return;
    bell(s, 1046.5, 0, 0.08, 0.8);
    bell(s, 1567.98, 0.1, 0.08, 1.0);
  },
};
