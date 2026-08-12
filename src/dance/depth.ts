/**
 * モデルを深度マップとして描く。
 *
 * カメラからの距離を明るさにする。**手前が白、奥が黒**（MiDaS や ControlNet の
 * depth が使っている向きに合わせてある）。背景は黒＝無限遠。
 *
 * マネキンの絵柄を変換サービスに渡すと、変換側は「その絵をどう解釈するか」から
 * 始めることになる。深度マップなら形そのものを渡せるので、解釈の余地が減る。
 * 色も陰影も持たないぶん、変換後の絵柄に元の見た目が残らない。
 *
 * ## z バッファの代わり
 *
 * canvas 2D に深度テストは無いが、**深度を明るさで表しているので、
 * 合成を `lighten`（チャンネルごとの最大値）にすると、それがそのまま
 * 「手前が勝つ」テストになる**。描く順番を気にしなくてよくなるので、
 * マネキン側でやっている画家のアルゴリズム（奥から順に描く）が要らない。
 *
 * ## 体の作り方
 *
 * 骨は「両端の球を繋いだテーパー付きカプセル」なので、軸に沿って半径を
 * 補間しながら球を並べれば、その和集合が正確にカプセルになる。球ひとつの
 * 深度は解析的に出る（中心からの距離 t に対して d - r√(1-t²)）ので、
 * 半球の断面をなぞる多段のラジアルグラデーションで描ける。
 */

import {
  depthOf,
  project,
  type Stage,
  type Screen,
} from "./render";
import {
  DEFAULT_BODY,
  headRadiusOf,
  limbsOf,
  rotate,
  type Body,
  type PosedSkeleton,
  type Vec3,
} from "./skeleton";

/**
 * 一番奥の体の表面に残す明るさ。
 *
 * 0 にすると背景（＝無限遠）と同じ黒になり、シルエットが背景に溶ける。
 * 変換側に「ここに体がある」と伝わらなくなるので、下駄を履かせておく。
 */
const DEPTH_FLOOR = 0.12;

/**
 * 球ひとつを描くときのグラデーションの段数。
 * 半球の断面 √(1-t²) は端で急に落ちるので、外側を細かく取る。
 */
const SPHERE_STOPS = [0, 0.3, 0.55, 0.72, 0.85, 0.93, 0.97, 1];

/**
 * 骨に沿って並べる球の間隔（半径に対する比）。
 *
 * 球を s だけ離して並べると、表面の凹みは s²/(8r) になる。0.35r なら
 * 半径の 1.5% で、腕の太さに直すと 1mm 弱。これ以上詰めても見えない。
 */
const SWEEP_SPACING = 0.35;

/** 1本の骨に使う球の数の上限。細い骨で数が爆発しないように。 */
const MAX_SWEEP = 40;

/**
 * 鼻の出っ張り。頭の半径に対する比。
 *
 * 頭そのものの手前の面が 0.92r なので、鼻の手前は 0.82 + 0.34 = 1.16r。
 * 差は 0.24r で、実寸だと 3cm ほど。人の鼻より大きいが、深度マップは色を
 * 持たないぶん、これくらい出さないと正面を向いているのが読めない。
 */
const NOSE_OFFSET = 0.82;
const NOSE_RADIUS = 0.34;

export interface DepthOptions {
  /** 体型。省略時は標準。 */
  body?: Body;
  /**
   * 床も深度に含めるか。既定は含めない。
   *
   * 含めると変換側が地面を掴みやすくなる可能性がある一方、床まで描き込まれる。
   * どちらが良いかは実際に通してみないと分からないので選べるようにしてある。
   */
  floor?: boolean;
}

/** 距離 → 明るさ 0..1。手前が 1。 */
function brightnessOf(stage: Stage, distance: number): number {
  const span = stage.depthFar - stage.depthNear;
  const t = span <= 0 ? 1 : (stage.depthFar - distance) / span;
  return DEPTH_FLOOR + (1 - DEPTH_FLOOR) * Math.min(1, Math.max(0, t));
}

function grey(value: number): string {
  const v = Math.round(Math.min(1, Math.max(0, value)) * 255);
  return `rgb(${v},${v},${v})`;
}

/**
 * 球ひとつ。
 *
 * 中心からの正規化距離 t における表面までの距離は d - r√(1-t²)。
 * 中心が一番手前（明るい）で、輪郭で球の中心の距離まで落ちる。
 */
function paintSphere(
  ctx: CanvasRenderingContext2D,
  stage: Stage,
  center: Vec3,
  radius: number,
): void {
  const s: Screen = project(stage, center);
  const screenRadius = radius * s.k;
  if (screenRadius < 0.4) return;
  // 画面外は捨てる。走査は全身ぶん回るので、これが効く
  if (
    s.x + screenRadius < 0 ||
    s.x - screenRadius > stage.width ||
    s.y + screenRadius < 0 ||
    s.y - screenRadius > stage.height
  ) {
    return;
  }

  const distance = depthOf(center);
  const gradient = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, screenRadius);
  for (const t of SPHERE_STOPS) {
    gradient.addColorStop(t, grey(brightnessOf(stage, distance - radius * Math.sqrt(1 - t * t))));
  }
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(s.x, s.y, screenRadius, 0, Math.PI * 2);
  ctx.fill();
}

/** テーパー付きカプセル。軸に沿って半径を変えながら球を並べる。 */
function paintBone(
  ctx: CanvasRenderingContext2D,
  stage: Stage,
  from: Vec3,
  to: Vec3,
  r0: number,
  r1: number,
): void {
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const thin = Math.max(0.004, Math.min(r0, r1));
  const steps = Math.min(MAX_SWEEP, Math.max(2, Math.ceil(length / (SWEEP_SPACING * thin))));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    paintSphere(
      ctx,
      stage,
      {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        z: from.z + (to.z - from.z) * t,
      },
      r0 + (r1 - r0) * t,
    );
  }
}

/**
 * 床（y=0 の平面）の深度。
 *
 * この投影では、y=0 の平面上の点は v = -CAM.y * (CAM.z / d) に写る。
 * これを距離について解くと d = CAM.y * CAM.z / (-v) になり、画面の行ごとに
 * 距離が決まる。地平線（v=0）で無限遠、下へ行くほど手前。
 */
function paintFloor(ctx: CanvasRenderingContext2D, stage: Stage): void {
  const horizon = stage.height / 2 + stage.centerV * stage.unit;
  const top = Math.max(0, horizon);
  if (top >= stage.height) return;

  const gradient = ctx.createLinearGradient(0, top, 0, stage.height);
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const y = top + ((stage.height - top) * i) / steps;
    // 画面 y → v → 距離
    const v = (stage.height / 2 - y) / stage.unit + stage.centerV;
    const distance = v < -1e-4 ? (0.85 * 3.6) / -v : Infinity;
    gradient.addColorStop(i / steps, grey(Number.isFinite(distance) ? brightnessOf(stage, distance) : 0));
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, top, stage.width, stage.height - top);
}

/**
 * 1コマ分の深度マップを描く。
 *
 * 背景を黒で塗ってから `lighten` で重ねていく。順番は結果に影響しない。
 */
export function drawDepthFrame(
  ctx: CanvasRenderingContext2D,
  skeleton: PosedSkeleton,
  stage: Stage,
  opts: DepthOptions = {},
): void {
  const body = opts.body ?? DEFAULT_BODY;

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, stage.width, stage.height);

  if (opts.floor) paintFloor(ctx, stage);

  // ここから先は「手前が勝つ」。深度が明るさなので最大値合成が深度テストになる
  ctx.globalCompositeOperation = "lighten";

  for (const limb of limbsOf(body)) {
    paintBone(ctx, stage, skeleton.pos[limb.from], skeleton.pos[limb.to], limb.r0, limb.r1);
  }

  // 頭。骨と同じで、首から頭頂へ球を並べれば卵形になる
  const headRadius = headRadiusOf(body);
  paintBone(
    ctx,
    stage,
    skeleton.pos.head,
    skeleton.pos.headTop,
    headRadius * 0.92,
    headRadius * 0.82,
  );

  // 鼻。深度マップは色を持たないので、顔の面を塗って正面を示す手が使えない。
  // 代わりに出っ張りを置く。頭が後ろを向けば球の裏へ回るので、深度テストが
  // 勝手に隠してくれる（描く側で向きを判定しなくてよい）
  const headCenter: Vec3 = {
    x: (skeleton.pos.head.x + skeleton.pos.headTop.x) / 2,
    y: (skeleton.pos.head.y + skeleton.pos.headTop.y) / 2,
    z: (skeleton.pos.head.z + skeleton.pos.headTop.z) / 2,
  };
  const forward = rotate(skeleton.rot.head, { x: 0, y: 0, z: 1 });
  paintSphere(
    ctx,
    stage,
    {
      x: headCenter.x + forward.x * headRadius * NOSE_OFFSET,
      y: headCenter.y + forward.y * headRadius * NOSE_OFFSET,
      z: headCenter.z + forward.z * headRadius * NOSE_OFFSET,
    },
    headRadius * NOSE_RADIUS,
  );

  ctx.restore();
}
