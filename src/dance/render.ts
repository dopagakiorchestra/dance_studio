/**
 * マネキンを canvas に描く。
 *
 * 見た目の方針は「Domo AI のような映像変換に渡す素材」に振ってある。
 *
 * - 背景は単色フラット。グラデーションも影も置かない（変換の邪魔になる）
 * - 体はベタ塗り＋輪郭線。手足が重なっても構造が読めるようにするため
 * - 頭には正面を示す面を描く。回転する振りがあるので、シルエットだけだと
 *   前を向いているのか背中なのかが変換側で判別できない
 * - 画角は振り付け全体を先に走査して決める。途中で手足が画面から切れると
 *   変換結果が崩れるので、切れないぎりぎりまで寄せる
 */

import type { Choreography } from "./choreo";
import { sampleSkeleton, type SampleOptions } from "./sampler";
import {
  DEFAULT_BODY,
  headRadiusOf,
  limbsOf,
  type Body,
  JOINT_NAMES,
  rotate,
  type JointName,
  type PosedSkeleton,
  type Vec3,
} from "./skeleton";

/** カメラ位置。真横から見る（あおりも俯瞰もしない）。 */
const CAM = { x: 0, y: 0.85, z: 3.6 };

/** 画面に対して被写体を収める割合。 */
const FILL = 0.94;

export interface StagePalette {
  id: string;
  name: string;
  background: string;
  body: string;
  outline: string;
  shadow: string;
}

export const PALETTES: StagePalette[] = [
  {
    id: "night",
    name: "ネイビー",
    background: "#16213e",
    body: "#eef2fb",
    outline: "#8090b8",
    shadow: "rgba(0,0,0,0.3)",
  },
  {
    id: "mono",
    name: "白黒（最大コントラスト）",
    background: "#000000",
    body: "#ffffff",
    outline: "#8a8a8a",
    shadow: "rgba(255,255,255,0.14)",
  },
  {
    id: "studio",
    name: "ライトグレー",
    background: "#eceae4",
    body: "#2b303c",
    outline: "#0a0d14",
    shadow: "rgba(0,0,0,0.16)",
  },
  {
    id: "chroma",
    name: "グリーンバック",
    background: "#00b140",
    body: "#f8fafc",
    outline: "#7d8ba0",
    shadow: "rgba(0,0,0,0.22)",
  },
];

export function getPalette(id: string): StagePalette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

/** 画角。ワールド座標を画面座標に移すのに必要な情報。 */
export interface Stage {
  width: number;
  height: number;
  /** z=0 平面での 1ワールド単位あたりのピクセル数。 */
  unit: number;
  centerU: number;
  centerV: number;
}

/** カメラから見た奥行き。0 以下にならないように下限を置く。 */
function depthOf(p: Vec3): number {
  return Math.max(0.6, CAM.z - p.z);
}

/**
 * 遠近を含めた正規化座標。
 * unit を掛ければ画面座標になるので、画角の計算をスケールと切り離せる。
 */
function normalize(p: Vec3): { u: number; v: number; d: number } {
  const d = depthOf(p);
  const k = CAM.z / d;
  return { u: (p.x - CAM.x) * k, v: (p.y - CAM.y) * k, d };
}

/**
 * 関節ごとの見た目の半径。画角を決めるときにこのぶんも余白として見る。
 * 体型で太さと頭の大きさが変わるので、そのつど作り直す。
 */
function jointRadiusOf(body: Body): Partial<Record<JointName, number>> {
  const r: Partial<Record<JointName, number>> = {};
  for (const limb of limbsOf(body)) {
    r[limb.from] = Math.max(r[limb.from] ?? 0, limb.r0);
    r[limb.to] = Math.max(r[limb.to] ?? 0, limb.r1);
  }
  const head = headRadiusOf(body);
  r.head = Math.max(r.head ?? 0, head);
  r.headTop = Math.max(r.headTop ?? 0, head);
  return r;
}

/**
 * 振り付け全体を走査して画角を決める。
 *
 * 実際に描かれるポーズだけを見て決めるので、手足が切れることは無く、
 * かつ必要以上に引かない。1本の動画の中では固定なので、途中でズームは動かない。
 */
export function createStage(
  width: number,
  height: number,
  choreo: Choreography,
  opts: SampleOptions,
): Stage {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;

  // 走査は細かく取る。ダイナミクスを上げると動きが速くなり、粗い刻みでは
  // 行き過ぎた一瞬の極値を跨いで見落とす。見落とすと本番でそのコマだけ
  // 手足が画面外へ出る（0.25 刻みで実際に 2px はみ出した）。
  const radius = jointRadiusOf(opts.body ?? DEFAULT_BODY);
  const step = 0.05;
  const samples = Math.max(1, Math.ceil(choreo.totalCounts / step));
  for (let i = 0; i < samples; i++) {
    const skeleton = sampleSkeleton(choreo, i * step, opts);
    for (const name of JOINT_NAMES) {
      const { u, v, d } = normalize(skeleton.pos[name]);
      const margin = ((radius[name] ?? 0) * CAM.z) / d;
      uMin = Math.min(uMin, u - margin);
      uMax = Math.max(uMax, u + margin);
      vMin = Math.min(vMin, v - margin);
      vMax = Math.max(vMax, v + margin);
    }
  }

  if (!Number.isFinite(uMin)) return { width, height, unit: height * 0.4, centerU: 0, centerV: 0 };

  const spanU = Math.max(0.1, uMax - uMin);
  const spanV = Math.max(0.1, vMax - vMin);
  return {
    width,
    height,
    unit: Math.min((width * FILL) / spanU, (height * FILL) / spanV),
    centerU: (uMin + uMax) / 2,
    centerV: (vMin + vMax) / 2,
  };
}

interface Screen {
  x: number;
  y: number;
  /** 奥行き。大きいほど遠い。 */
  d: number;
  /** このスケールを半径に掛けると画面上の半径になる。 */
  k: number;
}

function project(stage: Stage, p: Vec3): Screen {
  const { u, v, d } = normalize(p);
  return {
    x: stage.width / 2 + (u - stage.centerU) * stage.unit,
    y: stage.height / 2 - (v - stage.centerV) * stage.unit,
    d,
    k: (CAM.z / d) * stage.unit,
  };
}

/** 太さの違う2つの円を包む形（テーパー付きカプセル）のパスを作る。 */
function capsulePath(ctx: CanvasRenderingContext2D, a: Screen, b: Screen, ra: number, rb: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);

  ctx.beginPath();
  // 片方がもう片方を完全に含むときは、大きい円だけ描く
  if (dist <= Math.abs(ra - rb) + 0.01) {
    const big = ra >= rb ? a : b;
    ctx.arc(big.x, big.y, Math.max(ra, rb), 0, Math.PI * 2);
    return;
  }
  const angle = Math.atan2(dy, dx);
  const spread = Math.acos(Math.min(1, Math.max(-1, (ra - rb) / dist)));
  ctx.arc(a.x, a.y, ra, angle + spread, angle - spread);
  ctx.arc(b.x, b.y, rb, angle - spread, angle + spread);
  ctx.closePath();
}

interface Drawable {
  depth: number;
  paint: () => void;
}

export interface DrawOptions {
  palette: StagePalette;
  /** 体型。省略時は標準。 */
  body?: Body;
  /** 接地の影を描くか。 */
  shadow?: boolean;
  /** 輪郭線を描くか。 */
  outline?: boolean;
}

/** 1フレーム分を描く。canvas は毎回背景で塗り潰す。 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  skeleton: PosedSkeleton,
  stage: Stage,
  opts: DrawOptions,
): void {
  const { palette } = opts;
  const body = opts.body ?? DEFAULT_BODY;
  const headRadius = headRadiusOf(body);
  ctx.save();
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, stage.width, stage.height);

  if (opts.shadow !== false) drawShadow(ctx, skeleton, stage, palette);

  const lineWidth = Math.max(1.5, stage.unit * 0.006);
  const parts: Drawable[] = [];

  for (const limb of limbsOf(body)) {
    const a = project(stage, skeleton.pos[limb.from]);
    const b = project(stage, skeleton.pos[limb.to]);
    parts.push({
      depth: (a.d + b.d) / 2,
      paint: () => {
        capsulePath(ctx, a, b, limb.r0 * a.k, limb.r1 * b.k);
        ctx.fill();
        if (opts.outline !== false) ctx.stroke();
      },
    });
  }

  // 頭は head と headTop の中間を中心にした球として描く
  const headCenter: Vec3 = {
    x: (skeleton.pos.head.x + skeleton.pos.headTop.x) / 2,
    y: (skeleton.pos.head.y + skeleton.pos.headTop.y) / 2,
    z: (skeleton.pos.head.z + skeleton.pos.headTop.z) / 2,
  };
  const headScreen = project(stage, headCenter);
  const forward = rotate(skeleton.rot.head, { x: 0, y: 0, z: 1 });

  parts.push({
    depth: headScreen.d,
    paint: () => {
      ctx.beginPath();
      ctx.arc(headScreen.x, headScreen.y, headRadius * headScreen.k, 0, Math.PI * 2);
      ctx.fill();
      if (opts.outline !== false) ctx.stroke();

      // 正面を向いているときだけ「顔の面」を置く。
      // 横や後ろを向くと自然に小さくなって消える。
      //
      // ずらす量は画面座標で計算する。頭はカメラより高い位置にあるので、
      // 手前（+Z）へのずらしをワールド座標で入れると、遠近のせいで顔が
      // 上にせり上がって帽子のように見えてしまう。
      if (forward.z <= 0.05) return;
      const offset = headRadius * 0.7 * headScreen.k;
      ctx.beginPath();
      ctx.arc(
        headScreen.x + forward.x * offset,
        headScreen.y - forward.y * offset,
        headRadius * 0.5 * forward.z * headScreen.k,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = palette.outline;
      ctx.fill();
      ctx.fillStyle = palette.body;
    },
  });

  ctx.fillStyle = palette.body;
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";

  // 遠いものから描く（画家のアルゴリズム）
  parts.sort((a, b) => b.depth - a.depth);
  for (const part of parts) part.paint();

  ctx.restore();
}

/** 足元の影。接地感が出ると、変換後もキャラが浮いて見えにくくなる。 */
function drawShadow(
  ctx: CanvasRenderingContext2D,
  skeleton: PosedSkeleton,
  stage: Stage,
  palette: StagePalette,
): void {
  const hips = skeleton.pos.hips;
  const ground = project(stage, { x: hips.x, y: 0, z: hips.z });
  const rx = 0.3 * ground.k;
  if (rx <= 0.5) return;
  ctx.save();
  ctx.fillStyle = palette.shadow;
  ctx.beginPath();
  ctx.ellipse(ground.x, ground.y, rx, rx * 0.24, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 画面に収まっているかの判定。テストと、書き出し前の確認に使う。 */
export function frameBounds(
  skeleton: PosedSkeleton,
  stage: Stage,
  body: Body = DEFAULT_BODY,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const radius = jointRadiusOf(body);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const name of JOINT_NAMES) {
    const s = project(stage, skeleton.pos[name]);
    const r = (radius[name] ?? 0) * s.k;
    minX = Math.min(minX, s.x - r);
    maxX = Math.max(maxX, s.x + r);
    minY = Math.min(minY, s.y - r);
    maxY = Math.max(maxY, s.y + r);
  }
  return { minX, maxX, minY, maxY };
}
