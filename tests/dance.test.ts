import { describe, expect, it } from "vitest";

import {
  blockLayout,
  DEFAULT_DANCE,
  generateChoreography,
  normalizeDance,
  withOverride,
  type DanceSettings,
} from "../src/dance/choreo";
import { getMove, MOVES } from "../src/dance/moves";
import { createStage, frameBounds } from "../src/dance/render";
import { plantFeet } from "../src/dance/ground";
import { samplePose, sampleSkeleton, type SampleOptions } from "../src/dance/sampler";
import {
  DEFAULT_BODY,
  headToBody,
  hipHeightOf,
  jointRadiusOf,
  restHeightOf,
  type Body,
  HIP_HEIGHT,
  JOINT_NAMES,
  mirrorPose,
  LIMBS,
  REST_HEIGHT,
  solvePose,
  type JointName,
  type Pose,
} from "../src/dance/skeleton";

function settings(over: Partial<DanceSettings> = {}): DanceSettings {
  return { ...DEFAULT_DANCE, ...over };
}

/** 骨の長さ（親子の距離）を測る。FK が正しければポーズによらず一定になる。 */
function boneLengths(pose: Pose, body?: Body): Map<string, number> {
  const { pos } = solvePose(pose, body);
  const pairs: Array<[JointName, JointName]> = [
    ["hips", "spine"],
    ["spine", "chest"],
    ["chest", "neck"],
    ["neck", "head"],
    ["head", "headTop"],
    ["upperArmL", "forearmL"],
    ["forearmL", "handL"],
    ["thighL", "shinL"],
    ["shinL", "calfL"],
    ["calfL", "footL"],
    ["thighR", "shinR"],
  ];
  const out = new Map<string, number>();
  for (const [a, b] of pairs) {
    out.set(
      `${a}-${b}`,
      Math.hypot(pos[b].x - pos[a].x, pos[b].y - pos[a].y, pos[b].z - pos[a].z),
    );
  }
  return out;
}

describe("スケルトンと順運動学", () => {
  it("直立時に足の裏が地面に着き、身長がおよそ 1.6 になる", () => {
    const { pos } = solvePose({});
    expect(pos.hips.y).toBeCloseTo(HIP_HEIGHT, 6);
    // toe は前に出ているぶんだけ下がるが、足首は腰の高さぶん下にある
    expect(pos.footL.y).toBeCloseTo(HIP_HEIGHT - 0.04 - 0.45 - 0.43, 6);
    expect(pos.headTop.y).toBeCloseTo(REST_HEIGHT, 6);
    expect(REST_HEIGHT).toBeGreaterThan(1.5);
    expect(REST_HEIGHT).toBeLessThan(1.8);
  });

  it("どんな回転をかけても骨の長さが変わらない", () => {
    const rest = boneLengths({});
    const twisted = boneLengths({
      root: { x: 0.3, y: 1.1, z: -0.2 },
      j: {
        hips: [10, 47, -22],
        chest: [-31, 12, 18],
        upperArmL: [-73, 25, 140],
        forearmL: [0, -95, 12],
        thighR: [-52, 8, -17],
        shinR: [61, 0, 0],
      },
    });
    for (const [name, length] of rest) {
      expect(twisted.get(name)).toBeCloseTo(length, 9);
    }
  });

  it("左右反転すると鏡像になり、2回かけると元に戻る", () => {
    const pose: Pose = {
      root: { x: 0.08 },
      j: { upperArmL: [-20, 0, 130], thighR: [-40, 0, -6], chest: [0, 15, 9] },
    };
    const a = solvePose(pose).pos;
    const b = solvePose(mirrorPose(pose)).pos;

    // 左腕の先が、反転後は右腕の先の鏡像になっている
    expect(b.handR.x).toBeCloseTo(-a.handL.x, 9);
    expect(b.handR.y).toBeCloseTo(a.handL.y, 9);
    expect(b.handR.z).toBeCloseTo(a.handL.z, 9);

    const back = solvePose(mirrorPose(mirrorPose(pose))).pos;
    for (const name of JOINT_NAMES) {
      expect(back[name].x).toBeCloseTo(a[name].x, 9);
      expect(back[name].y).toBeCloseTo(a[name].y, 9);
      expect(back[name].z).toBeCloseTo(a[name].z, 9);
    }
  });
});

describe("振り付けパーツ", () => {
  it("キーフレームがカウント順に並んでいて、長さの範囲に収まっている", () => {
    for (const move of MOVES) {
      expect(move.keyframes.length).toBeGreaterThan(1);
      for (let i = 1; i < move.keyframes.length; i++) {
        expect(move.keyframes[i].count).toBeGreaterThan(move.keyframes[i - 1].count);
      }
      expect(move.keyframes[0].count).toBe(0);
      expect(move.keyframes.at(-1)?.count).toBeLessThanOrEqual(move.counts);
    }
  });

  it("ID が重複していない", () => {
    expect(new Set(MOVES.map((m) => m.id)).size).toBe(MOVES.length);
  });

  it("キメに使えるパーツが用意されている", () => {
    expect(MOVES.filter((m) => m.accent).length).toBeGreaterThan(0);
  });

  it("回転は始点と同じ向きで終わる（巻き戻りが起きない）", () => {
    // オイラー角の補間は最短経路を選ばないので、360度まで回して終わると
    // 次のブロックへ繋ぐときに逆回転で巻き戻る。実際に「半回転」がそうなっていた
    for (const move of MOVES) {
      const first = move.keyframes[0].pose.j?.hips?.[1] ?? 0;
      const last = move.keyframes[move.keyframes.length - 1].pose.j?.hips?.[1] ?? 0;
      expect(Math.abs(last - first)).toBeLessThan(1);
    }
  });

  it("パーツの中で向きが飛ばない", () => {
    // キーフレーム間で 180度を超えて回すと、どちら回りか決められない
    for (const move of MOVES) {
      for (let i = 1; i < move.keyframes.length; i++) {
        const a = move.keyframes[i - 1].pose.j?.hips?.[1] ?? 0;
        const b = move.keyframes[i].pose.j?.hips?.[1] ?? 0;
        expect(Math.abs(b - a)).toBeLessThanOrEqual(180);
      }
    }
  });

  it("hold は同じポーズの間だけに使う（違うポーズだと動きが飛ぶ）", () => {
    for (const move of MOVES) {
      for (let i = 1; i < move.keyframes.length; i++) {
        if (move.keyframes[i].ease !== "hold") continue;
        expect(JSON.stringify(move.keyframes[i].pose)).toBe(
          JSON.stringify(move.keyframes[i - 1].pose),
        );
      }
    }
  });
});

describe("振り付けの生成", () => {
  it("ループ全体を隙間なく埋める", () => {
    for (const beats of [8, 16, 24, 32, 12, 7, 17]) {
      const choreo = generateChoreography(beats, settings());
      expect(choreo.totalCounts).toBe(beats);
      let cursor = 0;
      for (const block of choreo.blocks) {
        expect(block.startCount).toBe(cursor);
        cursor += block.counts;
      }
      expect(cursor).toBe(beats);
    }
  });

  it("スロットは1小節（4カウント）刻み", () => {
    const layout = blockLayout(16);
    expect(layout.map((s) => s.counts)).toEqual([4, 4, 4, 4]);
  });

  it("端数が短すぎるときは手前のスロットにまとめる", () => {
    // 17 拍 = 4+4+4+4+1。1カウントのスロットは振りとして成立しない
    const layout = blockLayout(17);
    expect(layout).toHaveLength(4);
    expect(layout[3].counts).toBe(5);
  });

  it("同じシードなら必ず同じ振り付けになる", () => {
    const a = generateChoreography(32, settings({ seed: 4242 }));
    const b = generateChoreography(32, settings({ seed: 4242 }));
    expect(b.blocks).toEqual(a.blocks);
  });

  it("シードを変えると振り付けが変わる", () => {
    const variants = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      variants.add(
        generateChoreography(32, settings({ seed }))
          .blocks.map((b) => `${b.moveId}:${b.mirrored}`)
          .join("|"),
      );
    }
    expect(variants.size).toBeGreaterThan(4);
  });

  it("同じ振りが続くのは左右反転の繰り返しのときだけ", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const blocks = generateChoreography(64, settings({ seed })).blocks;
      for (let i = 1; i < blocks.length; i++) {
        if (blocks[i].moveId !== blocks[i - 1].moveId) continue;
        expect(blocks[i].mirrored).not.toBe(blocks[i - 1].mirrored);
      }
    }
  });

  it("ループの最後はキメで締める", () => {
    // 長さも変えて確かめる。2スロット使う振りが最後のスロットまで食い込むと
    // 締めが消えるので、スロット数が奇数・偶数の両方を通す
    for (const beats of [12, 16, 20, 24, 32, 48]) {
      for (let seed = 1; seed <= 60; seed++) {
        const blocks = generateChoreography(beats, settings({ seed })).blocks;
        if (blocks.length < 2) continue;
        expect(getMove(blocks[blocks.length - 1].moveId)?.accent).toBe(true);
      }
    }
  });

  it("キメが1種類に偏らない", () => {
    // 動きの大きさで絞ると、一番大きいキメだけが毎回出てくる
    const used = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const blocks = generateChoreography(32, settings({ seed })).blocks;
      used.add(blocks[blocks.length - 1].moveId);
    }
    expect(used.size).toBeGreaterThan(2);
  });

  it("1ループの中で振りが十分に入れ替わる", () => {
    // 8カウント単位だった頃は 8小節で 4ブロックしかなく、しかもその半分が
    // 直前の左右反転だったので、実質2〜3種類しか出てこなかった
    let distinct = 0;
    const seeds = 40;
    for (let seed = 1; seed <= seeds; seed++) {
      const blocks = generateChoreography(32, settings({ seed })).blocks;
      distinct += new Set(blocks.map((b) => b.moveId)).size;
    }
    expect(distinct / seeds).toBeGreaterThan(5);
  });

  it("盛り上がりを上げると動きの大きいパーツが増える", () => {
    const total = (intensity: number) => {
      let sum = 0;
      for (let seed = 1; seed <= 30; seed++) {
        for (const block of generateChoreography(48, settings({ seed, intensity })).blocks) {
          sum += getMove(block.moveId)?.energy ?? 0;
        }
      }
      return sum;
    };
    expect(total(1)).toBeGreaterThan(total(0));
  });

  it("手で選んだ小節はシードを変えても残る", () => {
    // 指定はスロット番号で覚える。ブロックの長さは振りによって変わるので、
    // 並び順で覚えると引き直したときに別の小節へずれてしまう
    const base = withOverride(settings({ seed: 1 }), 2, { moveId: "armSlice", mirrored: true });
    for (const seed of [1, 2, 99, 12345]) {
      const blocks = generateChoreography(32, { ...base, seed }).blocks;
      const picked = blocks.find((b) => b.slot === 2);
      expect(picked?.moveId).toBe("armSlice");
      expect(picked?.mirrored).toBe(true);
      expect(picked?.manual).toBe(true);
    }
  });

  it("手動指定を外すと自動に戻る", () => {
    const withPick = withOverride(settings(), 1, { moveId: "twinkle", mirrored: false });
    const cleared = withOverride(withPick, 1, null);
    expect(cleared.overrides).toEqual([]);
    const blocks = generateChoreography(32, cleared).blocks;
    expect(blocks.find((b) => b.slot === 1)?.manual).toBe(false);
  });
});

describe("設定の正規化", () => {
  it("知らないパーツ ID を捨てる", () => {
    const dance = normalizeDance({
      overrides: [{ moveId: "存在しない技", mirrored: true }, { moveId: "armSlice", mirrored: true }],
    });
    expect(dance.overrides[0]).toBeNull();
    expect(dance.overrides[1]).toEqual({ moveId: "armSlice", mirrored: true });
  });

  it("範囲外の数値を丸める", () => {
    const dance = normalizeDance({ seed: -5, intensity: 9, bounce: -1 });
    expect(dance.seed).toBe(1);
    expect(dance.intensity).toBe(1);
    expect(dance.bounce).toBe(0);
  });

  it("壊れた入力でも既定値で立ち上がる", () => {
    expect(normalizeDance(null)).toEqual(DEFAULT_DANCE);
    expect(normalizeDance({ overrides: "だめ" }).overrides).toEqual([]);
  });
});

describe("ポーズの取り出し", () => {
  const choreo = generateChoreography(32, settings({ seed: 7 }));

  it("ループの外側を渡しても巻き戻して同じポーズになる", () => {
    for (const count of [0, 3.5, 17.25]) {
      const a = samplePose(choreo, count, { bounce: 0.6 });
      const b = samplePose(choreo, count + 32, { bounce: 0.6 });
      expect(b).toEqual(a);
    }
  });

  it("動きが飛ばない（ブロックの継ぎ目とループの継ぎ目を含む）", () => {
    // 速さそのものは制限しない（ダイナミクスを上げれば当然速くなる）。
    // ここで見たいのは「一瞬だけ突出したコマ」＝ポーズが飛んだ跡があるか。
    // 普段の速さ（99パーセンタイル）に対する最大コマの比で判定すると、
    // 全体の速さが変わっても同じ基準で継ぎ目の破綻を捕まえられる。
    const jumpRatio = (opts: { bounce: number; chain?: number; snap?: number }): number => {
      const step = 0.02;
      const steps: number[] = [];
      let prev = sampleSkeleton(choreo, -step, opts).pos;
      for (let count = 0; count <= choreo.totalCounts; count += step) {
        const cur = sampleSkeleton(choreo, count, opts).pos;
        let worst = 0;
        for (const name of JOINT_NAMES) {
          worst = Math.max(
            worst,
            Math.hypot(
              cur[name].x - prev[name].x,
              cur[name].y - prev[name].y,
              cur[name].z - prev[name].z,
            ),
          );
        }
        steps.push(worst);
        prev = cur;
      }
      steps.sort((a, b) => a - b);
      const p99 = steps[Math.floor(steps.length * 0.99)];
      return steps[steps.length - 1] / p99;
    };

    // 実測はどのダイナミクスでも 1.7 前後。繋ぎを外すと一気に跳ね上がる
    for (const snap of [0, 0.75, 1]) {
      expect(jumpRatio({ bounce: 0.6, chain: 0.6, snap })).toBeLessThan(3);
    }
  });

  it("ダイナミクスを上げると実際に速くなる", () => {
    const peak = (snap: number): number => {
      const step = 0.02;
      let worst = 0;
      let prev = sampleSkeleton(choreo, -step, { bounce: 0.6, snap }).pos;
      for (let count = 0; count <= choreo.totalCounts; count += step) {
        const cur = sampleSkeleton(choreo, count, { bounce: 0.6, snap }).pos;
        for (const name of JOINT_NAMES) {
          worst = Math.max(
            worst,
            Math.hypot(
              cur[name].x - prev[name].x,
              cur[name].y - prev[name].y,
              cur[name].z - prev[name].z,
            ),
          );
        }
        prev = cur;
      }
      return worst;
    };
    // 実測で 2.5 倍以上。ここが効かないとスライダーが飾りになる
    expect(peak(1)).toBeGreaterThan(peak(0) * 2);
  });

  it("ダイナミクスを上げても骨の長さは変わらない", () => {
    // 行き過ぎ（オーバーシュート）は補間を 1 の外へ出すので、
    // 角度の外挿になっていることを確かめる。位置で外挿すると手足が伸びる
    const rest = boneLengths({});
    for (const count of [1.1, 4.3, 9.7, 16.2, 24.4]) {
      const lengths = boneLengths(samplePose(choreo, count, { bounce: 0.6, chain: 0.6, snap: 1 }));
      for (const [name, value] of lengths) {
        expect(value).toBeCloseTo(rest.get(name)!, 6);
      }
    }
  });

  it("バウンスを強くすると腰が沈む", () => {
    // ビートの頭（位相 0）が一番沈む
    const flat = samplePose(choreo, 4, { bounce: 0 });
    const bouncy = samplePose(choreo, 4, { bounce: 1 });
    expect(bouncy.root?.y ?? 0).toBeLessThan(flat.root?.y ?? 0);
  });

  it("パーツが見つからないブロックでも落ちない", () => {
    const broken = {
      seed: 1,
      totalCounts: 8,
      blocks: [{ startCount: 0, counts: 8, moveId: "無い技", mirrored: false, manual: true, slot: 0 }],
    };
    expect(() => sampleSkeleton(broken, 3)).not.toThrow();
  });
});

describe("キレ（止めと連鎖）", () => {
  const choreo = generateChoreography(32, settings({ seed: 7 }));

  /** step 区間あたりの最大移動量。「動きが飛ばない」テストと同じ尺度。 */
  function peakSpeed(opts: { bounce: number; chain?: number }, from = 0, to = 32): number {
    const step = 0.02;
    let worst = 0;
    let prev = sampleSkeleton(choreo, from - step, opts).pos;
    for (let count = from; count <= to; count += step) {
      const cur = sampleSkeleton(choreo, count, opts).pos;
      for (const name of JOINT_NAMES) {
        worst = Math.max(
          worst,
          Math.hypot(
            cur[name].x - prev[name].x,
            cur[name].y - prev[name].y,
            cur[name].z - prev[name].z,
          ),
        );
      }
      prev = cur;
    }
    return worst;
  }

  it("体の連鎖を入れても手先の速度が上がらない", () => {
    // ここが上がると映像変換がフレーム間で破綻する。連鎖は到達の順番を
    // ずらすだけで、通る距離も時間も変えないので速度は増えない。
    // これが「速く動かす」より先に連鎖を入れている理由。
    const flat = peakSpeed({ bounce: 0.6, chain: 0 });
    const chained = peakSpeed({ bounce: 0.6, chain: 1 });
    expect(chained).toBeLessThanOrEqual(flat * 1.05);
  });

  it("体の連鎖で腰より手先が遅れて到達する", () => {
    // 動きの速いところを探して、そこで手先が過去の位置に居ることを見る
    const opts = { bounce: 0, chain: 1 };
    let found = false;
    for (let count = 0; count < 32; count += 0.25) {
      const chained = sampleSkeleton(choreo, count, opts).pos;
      const flat = sampleSkeleton(choreo, count, { bounce: 0, chain: 0 }).pos;
      const past = sampleSkeleton(choreo, count - 0.2, { bounce: 0, chain: 0 }).pos;
      const toFlat = Math.hypot(
        chained.handTipL.x - flat.handTipL.x,
        chained.handTipL.y - flat.handTipL.y,
        chained.handTipL.z - flat.handTipL.z,
      );
      const toPast = Math.hypot(
        chained.handTipL.x - past.handTipL.x,
        chained.handTipL.y - past.handTipL.y,
        chained.handTipL.z - past.handTipL.z,
      );
      // 今の位置より過去の位置に近いフレームが存在すれば、遅れている
      if (toFlat > 0.01 && toPast < toFlat) found = true;
    }
    expect(found).toBe(true);
  });

  it("連鎖を入れても骨の長さは変わらない", () => {
    // 回転を差し替えているだけなので、手足が伸びてはいけない
    const rest = boneLengths({});
    for (const count of [3.3, 12.7, 24.1]) {
      const lengths = boneLengths(samplePose(choreo, count, { bounce: 0.6, chain: 1 }));
      for (const [name, value] of lengths) {
        expect(value).toBeCloseTo(rest.get(name)!, 6);
      }
    }
  });

  it("キメのブロックは長く静止する", () => {
    const still = (from: number, to: number): number => {
      const step = 0.02;
      const limit = REST_HEIGHT * 0.06 * 0.05;
      let total = 0;
      let prev = sampleSkeleton(choreo, from - step, { bounce: 0.6, chain: 0.6 }).pos;
      for (let count = from; count <= to; count += step) {
        const cur = sampleSkeleton(choreo, count, { bounce: 0.6, chain: 0.6 }).pos;
        let move = 0;
        for (const name of JOINT_NAMES) {
          move = Math.max(
            move,
            Math.hypot(
              cur[name].x - prev[name].x,
              cur[name].y - prev[name].y,
              cur[name].z - prev[name].z,
            ),
          );
        }
        if (move < limit) total += step;
        prev = cur;
      }
      return total;
    };

    const accent = choreo.blocks.find((b) => getMove(b.moveId)?.accent);
    expect(accent).toBeDefined();
    // キメは1小節（4カウント）。締めが丸まっていると、ここが 1拍を割る
    expect(still(accent!.startCount, accent!.startCount + accent!.counts)).toBeGreaterThan(1);
  });

  it("バウンスは沈むほうが速い（浮いて見えないため）", () => {
    // 拍の頭が一番沈んだ瞬間。その直前（沈み込み）のほうが、
    // 拍の直後（伸び上がり）より腰の移動が速い
    const hipY = (count: number): number =>
      sampleSkeleton(choreo, count, { bounce: 1, chain: 0 }).pos.hips.y;
    const d = 0.04;
    const dropping = Math.abs(hipY(8 - d) - hipY(8 - 2 * d));
    const rising = Math.abs(hipY(8 + d) - hipY(8 + 2 * d));
    expect(dropping).toBeGreaterThan(rising);
  });

  it("バウンスの上下動が滑らかに繋がる（拍をまたいでも段差が出ない）", () => {
    const hipY = (count: number): number =>
      sampleSkeleton(choreo, count, { bounce: 1, chain: 0 }).pos.hips.y;
    const step = 0.005;
    let worst = 0;
    // 拍の境目をまたぐ範囲だけを細かく見る
    for (let count = 7.8; count <= 8.2; count += step) {
      worst = Math.max(worst, Math.abs(hipY(count) - hipY(count - step)));
    }
    expect(worst).toBeLessThan(0.004);
  });
});

describe("肘", () => {
  /** 肩→肘 と 肘→手 のなす角。実際に曲がっている量。 */
  function elbowAngle(pose: Pose, side: "L" | "R"): number {
    const { pos } = solvePose(pose);
    const a = pos[`upperArm${side}`];
    const b = pos[`forearm${side}`];
    const c = pos[`hand${side}`];
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
    const dot = u.x * v.x + u.y * v.y + u.z * v.z;
    const cos = dot / (Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z));
    return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
  }

  it("Y 回転では肘が曲がらない（ひねりにしかならない）", () => {
    // この取り違えで、振り付け側の肘指定が長らく無効になっていた。
    // 前腕は -Y 方向に伸びているので、Y 軸まわりに回しても手の位置が動かない
    expect(elbowAngle({ j: { forearmL: [0, -110, 0] } }, "L")).toBeCloseTo(0, 6);
    // 曲がるのは X（前後）と Z（横）
    expect(elbowAngle({ j: { forearmL: [-70, 0, 0] } }, "L")).toBeCloseTo(70, 6);
    expect(elbowAngle({ j: { forearmL: [0, 0, -26] } }, "L")).toBeCloseTo(26, 6);
  });

  it("振り付けデータに効かない肘指定が残っていない", () => {
    for (const move of MOVES) {
      for (const frame of move.keyframes) {
        for (const name of ["forearmL", "forearmR"] as const) {
          const rot = frame.pose.j?.[name];
          if (!rot) continue;
          // Y だけに値が入っていたら、それは曲がらない指定
          const bends = Math.hypot(rot[0], rot[2]);
          if (rot[1] !== 0) expect(bends).toBeGreaterThan(0);
        }
      }
    }
  });

  it("肘が逆向きに曲がらない（人体は過伸展しない）", () => {
    for (const move of MOVES) {
      for (const frame of move.keyframes) {
        for (const name of ["forearmL", "forearmR"] as const) {
          const rot = frame.pose.j?.[name];
          if (!rot) continue;
          // X の + は後ろ向き＝過伸展
          expect(rot[0]).toBeLessThanOrEqual(0);
        }
      }
    }
  });

  it("振り付け全体を通して肘が伸び切らない", () => {
    // 伸び切った腕は棒に見える。脱力していても人の肘は少し曲がっている
    for (const seed of [1, 7, 42]) {
      const choreo = generateChoreography(32, settings({ seed }));
      for (let count = 0; count < 32; count += 0.25) {
        const pose = samplePose(choreo, count, { bounce: 0.6, chain: 0.6 });
        for (const side of ["L", "R"] as const) {
          expect(elbowAngle(pose, side)).toBeGreaterThan(3);
        }
      }
    }
  });

  it("大きく曲げたパーツはそのまま残る（自動の緩みに潰されない）", () => {
    // handTrace は肘を 124 度たたんで体をなぞる。ここが緩められると形が崩れる。
    // 実測のピークが 124 に届かないのは、ブロックの繋ぎが端を丸めるため。
    // 見たいのは「自動の緩み（ELBOW_AUTHORED は 20 度）に潰されていないこと」
    const choreo = generateChoreography(8, settings({ overrides: [{ moveId: "handTrace", mirrored: false }] }));
    let peak = 0;
    for (let count = 0; count < 8; count += 0.1) {
      const pose = samplePose(choreo, count, { bounce: 0, chain: 0 });
      peak = Math.max(peak, elbowAngle(pose, "L"), elbowAngle(pose, "R"));
    }
    expect(peak).toBeGreaterThan(90);
  });
});

describe("体のシルエット", () => {
  const limb = (from: JointName, to: JointName): { r0: number; r1: number } => {
    const found = LIMBS.find((l) => l.from === from && l.to === to);
    expect(found).toBeDefined();
    return found!;
  };

  it("胸と骨盤より腰が細い（筒に見えないため）", () => {
    // 同じ太さで積むと筒になり、人の体として読めなくなる。
    // くびれがあるかどうかがシルエットの決め手
    const pelvis = limb("hips", "spine").r0;
    const waist = limb("hips", "spine").r1;
    const chest = limb("spine", "chest").r1;
    expect(waist).toBeLessThan(pelvis * 0.85);
    expect(waist).toBeLessThan(chest * 0.75);
    // 腰の上下で太さが繋がっていること（段差があると分割線が見える）
    expect(limb("spine", "chest").r0).toBeCloseTo(waist, 6);
  });

  it("肩が腰より広い", () => {
    expect(limb("chest", "upperArmL").r0).toBeGreaterThan(limb("hips", "spine").r1);
  });

  it("ふくらはぎが膝下でいったん太くなる", () => {
    // 膝から足首まで一直線に細くすると脚が棒に見える
    const knee = limb("shinL", "calfL").r0;
    const calf = limb("shinL", "calfL").r1;
    const ankle = limb("calfL", "footL").r1;
    expect(calf).toBeGreaterThan(knee);
    expect(ankle).toBeLessThan(calf * 0.6);
  });

  it("足先を尖らせない（つま先立ちに見えるため）", () => {
    const toe = limb("footL", "toeL");
    expect(toe.r1).toBeGreaterThan(toe.r0 * 0.65);
  });
});

describe("手", () => {
  const choreo = generateChoreography(16, settings({ seed: 9 }));

  /** 手のひらと指のなす角。0 だと一直線＝手刀に見える。 */
  function knuckleAngle(pose: Pose, side: "L" | "R"): number {
    const { pos } = solvePose(pose);
    const a = pos[`hand${side}`];
    const b = pos[`knuckle${side}`];
    const c = pos[`handTip${side}`];
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
    const dot = u.x * v.x + u.y * v.y + u.z * v.z;
    const cos = dot / (Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z));
    return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
  }

  it("指はいつも少し丸まっている（手刀にならない）", () => {
    // 伸ばし切った手は刃物に見える。折れは指の付け根に置く。
    // 手首で折ると「手を反らせている」になってしまう
    for (let count = 0; count < 16; count += 0.5) {
      const pose = samplePose(choreo, count, { bounce: 0.6, groove: 0.7, snap: 0.75 });
      for (const side of ["L", "R"] as const) {
        expect(knuckleAngle(pose, side)).toBeGreaterThan(10);
      }
    }
  });

  it("指先を尖らせない（尖ると刃物に見える）", () => {
    const fingers = LIMBS.filter((l) => l.to === "handTipL" || l.to === "handTipR");
    expect(fingers.length).toBe(2);
    for (const limb of fingers) {
      // 先端が根元の半分を切ると針のように見える
      expect(limb.r1).toBeGreaterThan(limb.r0 * 0.5);
    }
  });

  it("手が握り拳に見えない縦横比になっている", () => {
    // 長さと幅が同じだとグーに見える。手のひら＋指で幅の 1.4 倍以上は要る
    const { pos } = solvePose({});
    const length = Math.abs(pos.handTipL.y - pos.handL.y);
    const width = 2 * 0.048;
    expect(length / width).toBeGreaterThan(1.4);
  });
});

describe("ノリ", () => {
  const choreo = generateChoreography(16, settings({ seed: 4 }));

  it("横ノリは拍ごとに重心が入れ替わる", () => {
    const hipX = (count: number): number =>
      sampleSkeleton(choreo, count, { bounce: 1, groove: 1, snap: 0 }).pos.hips.x;
    // 拍の頭で乗り切っている。周期は2拍なので、隣の拍とは逆側にいる
    const a = hipX(4);
    const b = hipX(5);
    const c = hipX(6);
    expect(Math.sign(a)).toBe(-Math.sign(b));
    expect(Math.sign(a)).toBe(Math.sign(c));
    expect(Math.abs(a)).toBeGreaterThan(0.01);
  });

  it("横ノリでも足が地面から離れない", () => {
    // 腰を横へ運ぶだけだと足がついてきてしまうので、太ももで打ち消している。
    // ノリを切った状態と比べて、足の高さがほとんど変わらないことを見る。
    //
    // 参考: 縦ノリは膝の補正が近似なので 0.076 ずれる（横ノリは 0.016）。
    // 横のほうが接地は素直で、これは元からの差
    const feetY = (count: number, opts: { bounce: number; groove?: number }): number => {
      const { pos } = sampleSkeleton(choreo, count, { ...opts, snap: 0 });
      return Math.min(pos.footL.y, pos.footR.y);
    };
    for (let count = 0; count < 16; count += 0.25) {
      const still = feetY(count, { bounce: 0 });
      expect(Math.abs(feetY(count, { bounce: 1, groove: 1 }) - still)).toBeLessThan(0.03);
    }
  });

  it("縦ノリと横ノリで動きの向きが入れ替わる", () => {
    const span = (groove: number): { x: number; y: number } => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let count = 0; count < 8; count += 0.05) {
        const { pos } = sampleSkeleton(choreo, count, { bounce: 1, groove, snap: 0 });
        minX = Math.min(minX, pos.hips.x);
        maxX = Math.max(maxX, pos.hips.x);
        minY = Math.min(minY, pos.hips.y);
        maxY = Math.max(maxY, pos.hips.y);
      }
      return { x: maxX - minX, y: maxY - minY };
    };
    const vertical = span(0);
    const horizontal = span(1);
    expect(horizontal.x).toBeGreaterThan(vertical.x);
    expect(vertical.y).toBeGreaterThan(horizontal.y);
  });

  it("横ノリが拍をまたいでも段差なく繋がる", () => {
    const hipX = (count: number): number =>
      sampleSkeleton(choreo, count, { bounce: 1, groove: 1, snap: 0 }).pos.hips.x;
    const step = 0.005;
    let worst = 0;
    for (let count = 3.8; count <= 4.2; count += step) {
      worst = Math.max(worst, Math.abs(hipX(count) - hipX(count - step)));
    }
    expect(worst).toBeLessThan(0.004);
  });
});

describe("体型", () => {
  const EXTREMES: Body[] = [
    DEFAULT_BODY,
    { head: 1.4, legs: 0.7, arms: 0.7, build: 1.4, shoulders: 0.7 },
    { head: 0.7, legs: 1.4, arms: 1.4, build: 0.7, shoulders: 1.4 },
  ];

  it("脚を伸ばすと腰も身長も上がる", () => {
    expect(hipHeightOf({ ...DEFAULT_BODY, legs: 1.2 })).toBeCloseTo(HIP_HEIGHT * 1.2, 9);
    expect(restHeightOf({ ...DEFAULT_BODY, legs: 1.2 })).toBeGreaterThan(restHeightOf(DEFAULT_BODY));
  });

  it("頭を大きくすると頭身が下がる", () => {
    expect(headToBody({ ...DEFAULT_BODY, head: 1.4 })).toBeLessThan(headToBody(DEFAULT_BODY));
    expect(headToBody(DEFAULT_BODY)).toBeGreaterThan(5);
    expect(headToBody(DEFAULT_BODY)).toBeLessThan(9);
  });

  it("体型を変えても足の高さの比率が変わらない", () => {
    // 振り付けは脚の長さが標準のつもりで書かれている。腰の位置を脚の倍率で
    // 伸ばさないと、脚だけ伸びて足が地面から浮く（あるいはめり込む）。
    // 腰の高さに対する比で見れば、どの体型でも同じ値になるはず。
    const ratio = (body: Body): number => {
      const choreo = generateChoreography(16, settings({ seed: 3 }));
      let lowest = Infinity;
      let highest = -Infinity;
      for (let count = 0; count < 16; count += 0.25) {
        const { pos } = solvePose(samplePose(choreo, count, { bounce: 0.6, snap: 0.75 }), body);
        for (const name of ["footL", "footR", "toeL", "toeR"] as const) {
          lowest = Math.min(lowest, pos[name].y);
          highest = Math.max(highest, pos[name].y);
        }
      }
      return (lowest + highest) / hipHeightOf(body);
    };
    const base = ratio(DEFAULT_BODY);
    for (const body of EXTREMES) {
      expect(ratio(body)).toBeCloseTo(base, 9);
    }
  });

  it("どの体型でも足が地面の近くにある", () => {
    // つま先を伸ばす振りがあるので厳密に 0 以上にはならないが、
    // 腰の高さの1割も潜っていたら接地が壊れている
    for (const body of EXTREMES) {
      const choreo = generateChoreography(16, settings({ seed: 3 }));
      let lowest = Infinity;
      for (let count = 0; count < 16; count += 0.25) {
        const { pos } = solvePose(samplePose(choreo, count, { bounce: 0.6, snap: 0.75 }), body);
        lowest = Math.min(lowest, pos.footL.y, pos.footR.y, pos.toeL.y, pos.toeR.y);
      }
      expect(lowest).toBeGreaterThan(-0.1 * hipHeightOf(body));
      expect(lowest).toBeLessThan(0.25 * restHeightOf(body));
    }
  });

  it("どの体型でも骨の長さがポーズによらず一定", () => {
    for (const body of EXTREMES) {
      const rest = boneLengths({}, body);
      const posed = boneLengths(
        { root: { x: 0.2, y: 0.8 }, j: { chest: [20, 15, -10], upperArmL: [-60, 0, 120], shinR: [50, 0, 0] } },
        body,
      );
      for (const [name, length] of rest) {
        expect(posed.get(name)).toBeCloseTo(length, 9);
      }
    }
  });

  it("どの体型でも手足が画面から切れない", () => {
    // 画角は体型込みで走査する。頭を大きくしたのに標準の半径で測っていると、
    // 頭のてっぺんだけ画面外に出る
    for (const body of EXTREMES) {
      const choreo = generateChoreography(16, settings({ seed: 5 }));
      const opts = { bounce: 0.6, chain: 0.6, snap: 1, body };
      const stage = createStage(720, 1280, choreo, opts);
      for (let count = 0; count < 16; count += 0.05) {
        const bounds = frameBounds(sampleSkeleton(choreo, count, opts), stage, body);
        expect(bounds.minX).toBeGreaterThanOrEqual(-0.5);
        expect(bounds.minY).toBeGreaterThanOrEqual(-0.5);
        expect(bounds.maxX).toBeLessThanOrEqual(720.5);
        expect(bounds.maxY).toBeLessThanOrEqual(1280.5);
      }
    }
  });
});

describe("深度マップ", () => {
  const choreo = generateChoreography(32, DEFAULT_DANCE);
  const opts = { bounce: 0.6, chain: 0.6, snap: 0.75, groove: 0.7, follow: 0.35 };
  const stage = createStage(720, 1280, choreo, opts);

  /** カメラからの距離。render.ts の CAM.z と揃えてある。 */
  const distanceOf = (z: number): number => Math.max(0.6, 3.6 - z);

  it("明るさの基準が振り付け全体をはみ出さない", () => {
    // 1コマごとに正規化すると、手が前に出た瞬間だけ基準が変わって動画全体が
    // 脈打つ。画角と同じで、範囲は先に走査して固定しておく必要がある。
    // どこか1コマでも範囲の外へ出ると、そこだけ真っ白／真っ黒に張り付く
    const radius = jointRadiusOf(DEFAULT_BODY);
    let nearest = Infinity;
    let farthest = -Infinity;
    for (let count = 0; count < choreo.totalCounts; count += 0.05) {
      const { pos } = sampleSkeleton(choreo, count, opts);
      for (const name of JOINT_NAMES) {
        const d = distanceOf(pos[name].z);
        const r = radius[name] ?? 0;
        nearest = Math.min(nearest, d - r);
        farthest = Math.max(farthest, d + r);
      }
    }
    expect(stage.depthNear).toBeLessThanOrEqual(nearest + 1e-9);
    expect(stage.depthFar).toBeGreaterThanOrEqual(farthest - 1e-9);
  });

  it("奥行きに幅がある（全部が同じ明るさに潰れない）", () => {
    // 体の厚みと腕の前後で、少なくとも 30cm ぶんは階調が付く
    expect(stage.depthFar - stage.depthNear).toBeGreaterThan(0.3);
  });

  it("同じ振り付けなら毎回同じ範囲になる", () => {
    const again = createStage(720, 1280, choreo, opts);
    expect(again.depthNear).toBe(stage.depthNear);
    expect(again.depthFar).toBe(stage.depthFar);
  });

  it("体型を変えても範囲が張り付かない", () => {
    for (const body of [
      { head: 1.4, legs: 0.7, arms: 0.7, build: 1.4, shoulders: 0.7 },
      { head: 0.7, legs: 1.4, arms: 1.4, build: 0.7, shoulders: 1.4 },
    ] as Body[]) {
      const s = createStage(720, 1280, choreo, { ...opts, body });
      expect(s.depthFar).toBeGreaterThan(s.depthNear);
      expect(Number.isFinite(s.depthNear)).toBe(true);
      expect(Number.isFinite(s.depthFar)).toBe(true);
    }
  });
});

describe("追従（二次運動）", () => {
  const choreo = generateChoreography(32, DEFAULT_DANCE);
  const at = (count: number, follow: number): number =>
    samplePose(choreo, count, { bounce: 0, chain: 0, snap: 0.75, follow }).j?.upperArmL?.[2] ?? 0;

  it("振り終わりに行き過ぎてから、元の値へ戻る", () => {
    // 28.0 付近で腕が振られて 28.4 あたりで止まる振り。追従を入れると、
    // 到達したところを少し越えてから同じ値に落ち着く
    const peakOff = Math.max(at(28.36, 0), at(28.42, 0));
    const peakOn = Math.max(at(28.36, 1), at(28.42, 1));
    const overshoot = peakOn - peakOff;
    expect(overshoot).toBeGreaterThan(0.1);
    // そのあと収まる。行き過ぎたままだと、ただ振り幅が増えただけになる
    const settled = Math.abs(at(28.6, 1) - at(28.6, 0));
    expect(settled).toBeLessThan(overshoot);
  });

  it("振り始めの前にわずかに引く（アンティシペーション）", () => {
    // 動き出す直前は、進む向きと逆へ少し戻る
    expect(at(28.0, 1)).toBeLessThan(at(28.0, 0));
  });

  it("止まっている間は何も足さない", () => {
    // 加速度が 0 のところで値が動くと、静止しているはずのポーズが揺れる
    for (const count of [27.5, 27.7, 27.8]) {
      expect(Math.abs(at(count, 1) - at(count, 0))).toBeLessThan(0.01);
    }
  });

  it("骨の長さは変わらない", () => {
    const rest = boneLengths({});
    for (const count of [1.1, 9.7, 24.4, 28.1]) {
      const lengths = boneLengths(
        samplePose(choreo, count, { bounce: 0.6, chain: 0.6, snap: 1, follow: 1 }),
      );
      for (const [name, value] of lengths) {
        expect(value).toBeCloseTo(rest.get(name)!, 6);
      }
    }
  });

  it("脚と腰には掛けない", () => {
    // 接地の解決が足の位置を決めたあとに角度を足すと、足がまた床から浮く
    for (const count of [3.3, 12.7, 24.1, 28.1]) {
      const off = samplePose(choreo, count, { bounce: 0.6, chain: 0.6, snap: 0.75, follow: 0 });
      const on = samplePose(choreo, count, { bounce: 0.6, chain: 0.6, snap: 0.75, follow: 1 });
      for (const name of [
        "hips",
        "thighL",
        "shinL",
        "footL",
        "thighR",
        "shinR",
        "footR",
      ] as JointName[]) {
        expect(on.j?.[name] ?? [0, 0, 0]).toEqual(off.j?.[name] ?? [0, 0, 0]);
      }
    }
  });

  it("上げるほど手先が速くなる（変換のリスクとして把握しておく）", () => {
    const peak = (follow: number): number => {
      const step = 0.01;
      let worst = 0;
      let prev = sampleSkeleton(choreo, -step, { bounce: 0.6, chain: 0.6, snap: 0.75, follow }).pos;
      for (let count = 0; count <= choreo.totalCounts; count += step) {
        const cur = sampleSkeleton(choreo, count, { bounce: 0.6, chain: 0.6, snap: 0.75, follow })
          .pos;
        for (const name of ["handTipL", "handTipR"] as JointName[]) {
          worst = Math.max(
            worst,
            Math.hypot(
              cur[name].x - prev[name].x,
              cur[name].y - prev[name].y,
              cur[name].z - prev[name].z,
            ),
          );
        }
        prev = cur;
      }
      return worst;
    };
    // 既定（0.35）で 2 割ほど。1 まで上げると 5 割増える
    expect(peak(1)).toBeGreaterThan(peak(0) * 1.3);
    expect(peak(DEFAULT_DANCE.follow)).toBeLessThan(peak(0) * 1.3);
  });
});

describe("接地", () => {
  const choreo = generateChoreography(32, DEFAULT_DANCE);
  const opts = (over: Partial<SampleOptions> = {}): SampleOptions => ({
    bounce: 0.6,
    chain: 0.6,
    snap: 0.75,
    groove: 0.7,
    body: DEFAULT_BODY,
    ...over,
  });

  /** 足の裏の最下点。カプセルの端は球なので、関節の真下・半径ぶん下が最低点。 */
  const lowestOf = (
    pos: Record<JointName, { x: number; y: number; z: number }>,
    body: Body = DEFAULT_BODY,
  ): number => {
    const r = jointRadiusOf(body);
    return Math.min(
      pos.footL.y - (r.footL ?? 0),
      pos.toeL.y - (r.toeL ?? 0),
      pos.footR.y - (r.footR ?? 0),
      pos.toeR.y - (r.toeR ?? 0),
    );
  };

  const lowestOverLoop = (o: SampleOptions, body?: Body): number => {
    let lowest = Infinity;
    for (let count = 0; count < choreo.totalCounts; count += 0.05) {
      lowest = Math.min(lowest, lowestOf(sampleSkeleton(choreo, count, o).pos, body));
    }
    return lowest;
  };

  it("床にめり込まない", () => {
    // 接地を入れる前は腰高の 10% 以上めり込んでいた。脚は骨盤からぶら下がって
    // いるだけで、床という概念が無かった
    expect(lowestOverLoop(opts({ ground: false }))).toBeLessThan(-0.05);
    // 残るのは、脚を伸ばし切っても届かない一瞬だけ
    expect(lowestOverLoop(opts())).toBeGreaterThan(-0.01 * HIP_HEIGHT);
  });

  it("ノリを入れても足の高さがほとんど変わらない", () => {
    // 沈み込みも横の体重移動も、それまでは「腰を動かした分を太ももの角度で
    // 打ち消す」近似だった。縦で 0.069、横で 0.033 のずれが残っていて、
    // これが接地の甘さの正体だった。IK で解くと 0.003 / 0.001 まで落ちる。
    // 0 にならないのは、脚を伸ばし切っても床へ届かない一瞬があるため
    for (const groove of [0, 1]) {
      let worst = 0;
      for (let count = 0; count < 8; count += 0.05) {
        const still = lowestOf(sampleSkeleton(choreo, count, opts({ bounce: 0, groove })).pos);
        const moving = lowestOf(sampleSkeleton(choreo, count, opts({ bounce: 1, groove })).pos);
        worst = Math.max(worst, Math.abs(still - moving));
      }
      expect(worst).toBeLessThan(0.005);
    }
  });

  it("接地している足の裏が床と平行になる", () => {
    // 骨格の足はつま先のほうが低い（描かれる太さまで含めると 7 度前下がり）。
    // そのまま置くとつま先立ちに見える
    const tilts = (ground: boolean): number[] => {
      const out: number[] = [];
      const r = jointRadiusOf(DEFAULT_BODY);
      for (let count = 0; count < choreo.totalCounts; count += 0.05) {
        const { pos } = sampleSkeleton(choreo, count, opts({ ground }));
        for (const [ankle, toe] of [
          ["footL", "toeL"],
          ["footR", "toeR"],
        ] as Array<[JointName, JointName]>) {
          const heelY = pos[ankle].y - (r[ankle] ?? 0);
          const toeY = pos[toe].y - (r[toe] ?? 0);
          if (Math.min(heelY, toeY) > 0.01) continue;
          const run = Math.hypot(pos[toe].x - pos[ankle].x, pos[toe].z - pos[ankle].z);
          out.push(Math.abs((Math.atan2(toeY - heelY, run) * 180) / Math.PI));
        }
      }
      out.sort((a, b) => a - b);
      return out;
    };
    const before = tilts(false);
    const after = tilts(true);
    // 中央値で見る。振り付けが意図してつま先を伸ばしているところは残す
    expect(before[before.length >> 1]).toBeGreaterThan(10);
    expect(after[after.length >> 1]).toBeLessThan(2);
  });

  it("上げた足には触らない", () => {
    // 接地とみなす帯を広げすぎると、ステップで上げた足まで床へ引かれて
    // 振りが潰れる。一番高く上げた足の高さが変わらないことで見る
    const highest = (ground: boolean): number => {
      let top = -Infinity;
      for (let count = 0; count < choreo.totalCounts; count += 0.05) {
        const { pos } = sampleSkeleton(choreo, count, opts({ ground }));
        top = Math.max(top, pos.footL.y, pos.footR.y);
      }
      return top;
    };
    expect(highest(true)).toBeGreaterThan(highest(false) * 0.95);
  });

  it("IK で骨の長さが変わらない", () => {
    // 位置合わせを回転ではなく座標で当てにいくと、脚が伸び縮みする
    const rest = boneLengths({});
    for (const count of [0, 1.1, 4.3, 9.7, 16.2, 24.4]) {
      const { pos } = sampleSkeleton(choreo, count, opts());
      for (const [a, b] of [
        ["thighL", "shinL"],
        ["shinL", "calfL"],
        ["calfL", "footL"],
        ["thighR", "shinR"],
        ["footR", "toeR"],
      ] as Array<[JointName, JointName]>) {
        const length = Math.hypot(pos[b].x - pos[a].x, pos[b].y - pos[a].y, pos[b].z - pos[a].z);
        const want = rest.get(`${a}-${b}`);
        if (want !== undefined) expect(length).toBeCloseTo(want, 6);
      }
    }
  });

  it("膝が逆に折れない", () => {
    for (let count = 0; count < choreo.totalCounts; count += 0.05) {
      const pose = plantFeet(samplePose(choreo, count, opts()), DEFAULT_BODY);
      // すねの X 回転は「＋で膝が後ろへ折れる」。負になると膝が前へ折れる
      expect(pose.j?.shinL?.[0] ?? 0).toBeGreaterThan(-1);
      expect(pose.j?.shinR?.[0] ?? 0).toBeGreaterThan(-1);
    }
  });

  it("どの体型でも床に立つ", () => {
    for (const body of [
      DEFAULT_BODY,
      { head: 1.4, legs: 0.7, arms: 0.7, build: 1.4, shoulders: 0.7 },
      { head: 0.7, legs: 1.4, arms: 1.4, build: 0.7, shoulders: 1.4 },
    ] as Body[]) {
      expect(lowestOverLoop(opts({ body }), body)).toBeGreaterThan(-0.01 * HIP_HEIGHT);
    }
  });

  it("接地を入れても動きが飛ばない", () => {
    // IK は角度を組み直すので、境目で解が飛ぶと1コマだけ脚が跳ねる。
    // 接地なしと同じ滑らかさに収まっていることを見る
    const peak = (ground: boolean): number => {
      const step = 0.02;
      let worst = 0;
      let prev = sampleSkeleton(choreo, -step, opts({ ground })).pos;
      for (let count = 0; count <= choreo.totalCounts; count += step) {
        const cur = sampleSkeleton(choreo, count, opts({ ground })).pos;
        for (const name of JOINT_NAMES) {
          worst = Math.max(
            worst,
            Math.hypot(
              cur[name].x - prev[name].x,
              cur[name].y - prev[name].y,
              cur[name].z - prev[name].z,
            ),
          );
        }
        prev = cur;
      }
      return worst;
    };
    expect(peak(true)).toBeLessThan(peak(false) * 1.1);
  });
});

describe("画角", () => {
  it("振り付け全体を通して、手足が画面から切れない", () => {
    for (const [width, height] of [
      [720, 1280],
      [900, 900],
      [1280, 720],
    ]) {
      for (const seed of [1, 2, 3, 17]) {
        const choreo = generateChoreography(32, settings({ seed }));
        // 出荷時の設定で確かめる。オーバーシュートは補間を 1 の外へ出すので、
        // 画角の走査と描画が同じ設定でないと、行き過ぎた瞬間に手足が切れる
        const opts = { bounce: 0.6, chain: 0.6, snap: 1 };
        const stage = createStage(width, height, choreo, opts);
        for (let count = 0; count < choreo.totalCounts; count += 0.05) {
          const bounds = frameBounds(sampleSkeleton(choreo, count, opts), stage);
          expect(bounds.minX).toBeGreaterThanOrEqual(-0.5);
          expect(bounds.minY).toBeGreaterThanOrEqual(-0.5);
          expect(bounds.maxX).toBeLessThanOrEqual(width + 0.5);
          expect(bounds.maxY).toBeLessThanOrEqual(height + 0.5);
        }
      }
    }
  });

  it("必要以上に引かない（被写体が画面の半分以上を占める）", () => {
    const choreo = generateChoreography(32, settings({ seed: 5 }));
    const opts = { bounce: 0.6, chain: 0.6, snap: 1 };
    const stage = createStage(720, 1280, choreo, opts);
    let tallest = 0;
    for (let count = 0; count < choreo.totalCounts; count += 0.25) {
      const bounds = frameBounds(sampleSkeleton(choreo, count, opts), stage);
      tallest = Math.max(tallest, bounds.maxY - bounds.minY);
    }
    expect(tallest).toBeGreaterThan(1280 * 0.5);
  });
});
