// アプリアイコンを 1 つの SVG から書き出す（npm run gen:icons）
import { writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const INK = "#1c1c1e";
const ACCENT = "#3554e0";
const PAPER = "#f5f4f0";

/** pad はマスク用の余白（0〜1） */
function svg({ pad = 0, rounded = true } = {}) {
  const size = 512;
  const inner = size * (1 - pad * 2);
  const o = size * pad;
  const g = inner * 0.62; // 格子の大きさ
  const gx = o + (inner - g) / 2;
  const cell = g / 3;
  const stroke = g * 0.045;
  const r = rounded ? 112 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${r}" fill="${PAPER}"/>
  <rect x="${gx}" y="${gx}" width="${g}" height="${g}" rx="${cell * 0.42}" fill="#fff" stroke="${INK}" stroke-width="${stroke}"/>
  <g stroke="${INK}" stroke-width="${stroke * 0.55}" opacity="0.28">
    <path d="M${gx + cell} ${gx + stroke}V${gx + g - stroke}M${gx + cell * 2} ${gx + stroke}V${gx + g - stroke}"/>
    <path d="M${gx + stroke} ${gx + cell}H${gx + g - stroke}M${gx + stroke} ${gx + cell * 2}H${gx + g - stroke}"/>
  </g>
  <rect x="${gx + cell + cell * 0.14}" y="${gx + cell + cell * 0.14}" width="${cell * 0.72}" height="${cell * 0.72}" rx="${cell * 0.18}" fill="${ACCENT}"/>
</svg>`;
}

function png(source, width, out) {
  const data = new Resvg(source, { fitTo: { mode: "width", value: width } }).render().asPng();
  writeFileSync(out, data);
}

writeFileSync("public/icon.svg", svg());
png(svg(), 192, "public/icon-192.png");
png(svg(), 512, "public/icon-512.png");
// iOS は角丸を自前で付けるので、角丸なしの正方形を渡す
png(svg({ rounded: false }), 180, "public/apple-touch-icon.png");
png(svg({ pad: 0.1, rounded: false }), 512, "public/icon-maskable-512.png");
png(svg(), 48, "public/favicon-48.png");
console.log("icons written");
