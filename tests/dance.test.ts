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
import { samplePose, sampleSkeleton } from "../src/dance/sampler";
import {
  HIP_HEIGHT,
  JOINT_NAMES,
  mirrorPose,
  REST_HEIGHT,
  solvePose,
  type JointName,
  type Pose,
} from "../src/dance/skeleton";

function settings(over: Partial<DanceSettings> = {}): DanceSettings {
  return { ...DEFAULT_DANCE, ...over };
}

/** 骨の長さ（親子の距離）を測る。FK が正しければポーズによらず一定になる。 */
function boneLengths(pose: Pose): Map<string, number> {
  const { pos } = solvePose(pose);
  const pairs: Array<[JointName, JointName]> = [
    ["hips", "spine"],
    ["spine", "chest"],
    ["chest", "neck"],
    ["neck", "head"],
    ["head", "headTop"],
    ["upperArmL", "forearmL"],
    ["forearmL", "handL"],
    ["thighL", "shinL"],
    ["shinL", "footL"],
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

  it("端数が短すぎるときは手前のブロックにまとめる", () => {
    // 17 拍 = 8 + 8 + 1。1カウントのブロックは振りとして成立しない
    const layout = blockLayout(17);
    expect(layout).toHaveLength(2);
    expect(layout[1].counts).toBe(9);
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
    for (let seed = 1; seed <= 20; seed++) {
      const blocks = generateChoreography(32, settings({ seed })).blocks;
      expect(getMove(blocks[blocks.length - 1].moveId)?.accent).toBe(true);
    }
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

  it("手で選んだブロックはシードを変えても残る", () => {
    const base = withOverride(settings({ seed: 1 }), 2, { moveId: "wave", mirrored: true });
    for (const seed of [1, 2, 99, 12345]) {
      const blocks = generateChoreography(32, { ...base, seed }).blocks;
      expect(blocks[2].moveId).toBe("wave");
      expect(blocks[2].mirrored).toBe(true);
      expect(blocks[2].manual).toBe(true);
    }
  });

  it("手動指定を外すと自動に戻る", () => {
    const withPick = withOverride(settings(), 1, { moveId: "clap", mirrored: false });
    const cleared = withOverride(withPick, 1, null);
    expect(cleared.overrides).toEqual([]);
    expect(generateChoreography(32, cleared).blocks[1].manual).toBe(false);
  });
});

describe("設定の正規化", () => {
  it("知らないパーツ ID を捨てる", () => {
    const dance = normalizeDance({
      overrides: [{ moveId: "存在しない技", mirrored: true }, { moveId: "wave", mirrored: true }],
    });
    expect(dance.overrides[0]).toBeNull();
    expect(dance.overrides[1]).toEqual({ moveId: "wave", mirrored: true });
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
    const step = 0.02;
    let worst = 0;
    let prev = sampleSkeleton(choreo, -step, { bounce: 0.6 }).pos;
    for (let count = 0; count <= choreo.totalCounts; count += step) {
      const cur = sampleSkeleton(choreo, count, { bounce: 0.6 }).pos;
      for (const name of JOINT_NAMES) {
        worst = Math.max(
          worst,
          Math.hypot(cur[name].x - prev[name].x, cur[name].y - prev[name].y, cur[name].z - prev[name].z),
        );
      }
      prev = cur;
    }
    // 0.02 カウントぶんの移動量。速い振りでも実測 0.08 程度に収まるのに対し、
    // ブロックの繋ぎを外すと 0.67 まで跳ね上がる。その間に線を引いている。
    expect(worst).toBeLessThan(REST_HEIGHT * 0.06);
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
      blocks: [{ startCount: 0, counts: 8, moveId: "無い技", mirrored: false, manual: true }],
    };
    expect(() => sampleSkeleton(broken, 3)).not.toThrow();
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
        const stage = createStage(width, height, choreo, 0.6);
        for (let count = 0; count < choreo.totalCounts; count += 0.25) {
          const bounds = frameBounds(sampleSkeleton(choreo, count, { bounce: 0.6 }), stage);
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
    const stage = createStage(720, 1280, choreo, 0.6);
    let tallest = 0;
    for (let count = 0; count < choreo.totalCounts; count += 0.25) {
      const bounds = frameBounds(sampleSkeleton(choreo, count, { bounce: 0.6 }), stage);
      tallest = Math.max(tallest, bounds.maxY - bounds.minY);
    }
    expect(tallest).toBeGreaterThan(1280 * 0.5);
  });
});
