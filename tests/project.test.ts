import { afterEach, describe, expect, it } from "vitest";

import { beatPosition } from "../src/audio";
import { isIosLike, needsManualSaveTap, pickSaveStrategy } from "../src/compat";
import { DEFAULT_DANCE } from "../src/dance/choreo";
import { MOVES } from "../src/dance/moves";
import { readMp4SampleEntry } from "../src/mp4";
import {
  BARS_RANGE,
  BPM_RANGE,
  DEFAULT_PROJECT,
  REPEATS_RANGE,
  STORAGE_KEY,
  beatsPerLoop,
  decodeProject,
  encodeProject,
  loadStoredProject,
  loopSeconds,
  normalizeProject,
  projectFromHash,
  saveProject,
  shareUrl,
  totalSeconds,
  type DanceProject,
} from "../src/project";
import { safeFilename } from "../src/save";

/** テスト中だけ localStorage を差し込む。 */
function useFakeStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  return store;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("設定の正規化", () => {
  it("空の入力から既定値が立ち上がる", () => {
    expect(normalizeProject({})).toEqual(DEFAULT_PROJECT);
    expect(normalizeProject(null)).toEqual(DEFAULT_PROJECT);
    expect(normalizeProject("こわれた入力")).toEqual(DEFAULT_PROJECT);
  });

  it("範囲外の数値を丸める", () => {
    const low = normalizeProject({ bpm: 1, bars: 0, repeats: 0 });
    expect(low.bpm).toBe(BPM_RANGE.min);
    expect(low.bars).toBe(BARS_RANGE.min);
    expect(low.repeats).toBe(REPEATS_RANGE.min);

    const high = normalizeProject({ bpm: 9999, bars: 9999, repeats: 9999 });
    expect(high.bpm).toBe(BPM_RANGE.max);
    expect(high.bars).toBe(BARS_RANGE.max);
    expect(high.repeats).toBe(REPEATS_RANGE.max);
  });

  it("小数は整数に丸める", () => {
    expect(normalizeProject({ bpm: 128.6, bars: 7.4 })).toMatchObject({ bpm: 129, bars: 7 });
  });

  it("一覧に無い拍子は既定に落とす", () => {
    // 5拍子は 8カウントを割り切れないので受け付けない
    expect(normalizeProject({ beatsPerBar: 5 }).beatsPerBar).toBe(DEFAULT_PROJECT.beatsPerBar);
    expect(normalizeProject({ beatsPerBar: 3 }).beatsPerBar).toBe(3);
  });

  it("NaN や文字列を既定値で受け止める", () => {
    expect(normalizeProject({ bpm: NaN, bars: "8" }).bpm).toBe(DEFAULT_PROJECT.bpm);
    expect(normalizeProject({ bars: "8" }).bars).toBe(DEFAULT_PROJECT.bars);
  });

  it("振り付けの設定も併せて正規化する", () => {
    const project = normalizeProject({ dance: { seed: 5, intensity: 99, overrides: "だめ" } });
    expect(project.dance.seed).toBe(5);
    expect(project.dance.intensity).toBe(1);
    expect(project.dance.overrides).toEqual([]);
  });

  it("知らないパーツ ID を捨てる", () => {
    const project = normalizeProject({
      dance: { overrides: [{ moveId: "存在しない" }, { moveId: MOVES[0].id, mirrored: true }] },
    });
    expect(project.dance.overrides[0]).toBeNull();
    expect(project.dance.overrides[1]).toEqual({ moveId: MOVES[0].id, mirrored: true });
  });
});

describe("長さの計算", () => {
  const project: DanceProject = { ...DEFAULT_PROJECT, bpm: 120, beatsPerBar: 4, bars: 8, repeats: 2 };

  it("1ループの拍数は 拍子 × 小節数", () => {
    expect(beatsPerLoop(project)).toBe(32);
  });

  it("120 BPM の 32 拍は 16 秒", () => {
    expect(loopSeconds(project)).toBeCloseTo(16, 6);
  });

  it("書き出しの長さはループ × くり返し", () => {
    expect(totalSeconds(project)).toBeCloseTo(32, 6);
  });

  it("拍子を変えるとループの長さも変わる", () => {
    expect(beatsPerLoop({ ...project, beatsPerBar: 3 })).toBe(24);
  });
});

describe("共有リンク", () => {
  const project: DanceProject = {
    ...DEFAULT_PROJECT,
    bpm: 96,
    bars: 12,
    dance: { ...DEFAULT_DANCE, seed: 4242, overrides: [{ moveId: MOVES[0].id, mirrored: true }] },
  };

  it("符号化して戻すと元に戻る", () => {
    expect(decodeProject(encodeProject(project))).toEqual(project);
  });

  it("URL に置けない文字を含まない", () => {
    // base64url なので +, /, = は出てこない
    expect(encodeProject(project)).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("壊れた文字列では null を返す", () => {
    expect(decodeProject("これは base64 ではない")).toBeNull();
    expect(decodeProject("")).toBeNull();
  });

  it("ハッシュから読み出せる", () => {
    const url = shareUrl(project, "https://example.com/dance/");
    expect(url.startsWith("https://example.com/dance/#p=")).toBe(true);
    expect(projectFromHash(new URL(url).hash)).toEqual(project);
  });

  it("既にハッシュが付いた URL でも二重にならない", () => {
    const url = shareUrl(project, "https://example.com/dance/#p=ふるい");
    expect(url.split("#").length).toBe(2);
  });

  it("ハッシュに設定が無ければ null", () => {
    expect(projectFromHash("")).toBeNull();
    expect(projectFromHash("#other=1")).toBeNull();
  });
});

describe("保存", () => {
  it("保存したものを読み戻せる", () => {
    useFakeStorage();
    const project: DanceProject = { ...DEFAULT_PROJECT, bpm: 140, bars: 16 };
    saveProject(project);
    expect(loadStoredProject()).toEqual(project);
  });

  it("何も保存されていなければ null", () => {
    useFakeStorage();
    expect(loadStoredProject()).toBeNull();
  });

  it("壊れた保存データは null にする（例外を投げない）", () => {
    const store = useFakeStorage();
    store.set(STORAGE_KEY, "{壊れたJSON");
    expect(loadStoredProject()).toBeNull();
  });

  it("保存データが古い形でも正規化して読む", () => {
    const store = useFakeStorage();
    store.set(STORAGE_KEY, JSON.stringify({ bpm: 500 }));
    expect(loadStoredProject()?.bpm).toBe(BPM_RANGE.max);
  });

  it("localStorage が使えなくても落ちない", () => {
    // プライベートモードなどで setItem が例外を投げる状況
    expect(() => saveProject(DEFAULT_PROJECT)).not.toThrow();
    expect(loadStoredProject()).toBeNull();
  });
});

describe("音源との同期", () => {
  it("秒をループ内の拍位置に直す", () => {
    // 120BPM = 0.5秒/拍、32拍ループ
    expect(beatPosition(1, 0.5, 32)).toBeCloseTo(2, 6);
  });

  it("ループを超えたら巻き戻す", () => {
    expect(beatPosition(17, 0.5, 32)).toBeCloseTo(2, 6);
  });

  it("頭出しで負になっても範囲に収まる", () => {
    const pos = beatPosition(-1, 0.5, 32);
    expect(pos).toBeGreaterThanOrEqual(0);
    expect(pos).toBeCloseTo(30, 6);
  });

  it("0除算にならない", () => {
    expect(beatPosition(5, 0, 32)).toBe(0);
    expect(beatPosition(5, 0.5, 0)).toBe(0);
  });
});

describe("保存方法の判定", () => {
  it("iPhone を見分ける", () => {
    expect(isIosLike({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" })).toBe(
      true,
    );
  });

  it("Mac を名乗る iPad をタッチで見分ける", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
    expect(isIosLike({ userAgent: ua, maxTouchPoints: 5 })).toBe(true);
    expect(isIosLike({ userAgent: ua, maxTouchPoints: 0 })).toBe(false);
  });

  it("iOS で共有が使えるときだけ共有シートを選ぶ", () => {
    expect(pickSaveStrategy({ ios: true, canShareFiles: true })).toBe("share");
    expect(pickSaveStrategy({ ios: true, canShareFiles: false })).toBe("download");
    expect(pickSaveStrategy({ ios: false, canShareFiles: true })).toBe("download");
  });

  it("iOS では保存に改めてタップが必要", () => {
    // 共有の可否では判断しない。無視されるダウンロードを黙って実行しないため
    expect(needsManualSaveTap({ ios: true })).toBe(true);
    expect(needsManualSaveTap({ ios: false })).toBe(false);
  });

  it("ファイル名から使えない文字を落とす", () => {
    expect(safeFilename('a/b:c*d?e"f<g>h|i')).toBe("a_b_c_d_e_f_g_h_i");
    expect(safeFilename("空 白")).toBe("空_白");
    expect(safeFilename("")).toBe("dance");
    expect(safeFilename("あ".repeat(200)).length).toBe(80);
  });
});

describe("MP4 の中身の判定", () => {
  /** size(4) + type(4) + payload の箱を作る。 */
  function box(type: string, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + payload.length);
    new DataView(out.buffer).setUint32(0, out.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(payload, 8);
    return out;
  }

  /** stsd に FourCC を1つだけ入れた最小の MP4。 */
  function mp4With(fourcc: string): Uint8Array {
    const entry = box(fourcc, new Uint8Array(8));
    const stsdPayload = new Uint8Array(8 + entry.length);
    // version/flags は 0、entry_count は 1
    new DataView(stsdPayload.buffer).setUint32(4, 1);
    stsdPayload.set(entry, 8);
    return box("moov", box("trak", box("mdia", box("minf", box("stbl", box("stsd", stsdPayload))))));
  }

  it("H.264 のサンプルエントリを読み取る", () => {
    expect(readMp4SampleEntry(mp4With("avc1"))).toBe("avc1");
  });

  it("VP9 入りの MP4 も見分けられる", () => {
    // 拡張子が .mp4 でも中身が VP9 なことがある。推測せず実物を見るための判定
    expect(readMp4SampleEntry(mp4With("vp09"))).toBe("vp09");
  });

  it("stsd が無ければ null", () => {
    expect(readMp4SampleEntry(box("moov", new Uint8Array(16)))).toBeNull();
  });

  it("壊れた（長さが合わない）データでも落ちない", () => {
    const broken = new Uint8Array([0, 0, 0, 200, 109, 111, 111, 118]);
    expect(readMp4SampleEntry(broken)).toBeNull();
  });

  it("空のデータでも落ちない", () => {
    expect(readMp4SampleEntry(new Uint8Array(0))).toBeNull();
  });
});
