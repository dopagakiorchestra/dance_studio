/**
 * 振り付けの操作パネル。
 *
 * BPM と小節数から振り付けを組み立てて、プレビューし、動画として書き出す。
 * 振り付けそのものは dance/ 以下が作る。ここは操作と表示だけを持つ。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { blockLabel, generateChoreography, withOverride, type DanceSettings } from "../dance/choreo";
import { MOVES, type Mood } from "../dance/moves";
import { createStage, drawFrame, getPalette, PALETTES, type DrawMode } from "../dance/render";
import { sampleSkeleton } from "../dance/sampler";
import {
  FRAME_RATES,
  getVideoSize,
  pickVideoFormat,
  RecordAborted,
  recordDance,
  VIDEO_SIZES,
  type FrameRate,
} from "../dance/video";
import { BODY_RANGE, beatsPerLoop, secondsPerBeat, totalSeconds, type DanceProject } from "../project";
import { headToBody, restHeightOf, type Body } from "../dance/skeleton";
import { saveBlob, safeFilename, saveNeedsUserTap, type SaveOutcome } from "../save";

type ExportState =
  | { kind: "idle" }
  | { kind: "working"; ratio: number }
  | {
      kind: "ready";
      blob: Blob;
      filename: string;
      needsTap: boolean;
      outcome: SaveOutcome | null;
      codec: string | null;
    }
  | { kind: "error"; message: string };

export interface DanceStudioProps {
  project: DanceProject;
  onChange: (dance: DanceSettings) => void;
  onBodyChange: (body: Body) => void;
  /** 再生中のループ内の拍位置。止まっていれば null。 */
  playPosition: number | null;
}

/** 一覧の並べ分け。未指定の振りは「基本」に入る。 */
const MOOD_GROUPS: Array<{ mood: Mood | undefined; label: string }> = [
  { mood: undefined, label: "基本" },
  { mood: "cool", label: "かっこいい" },
  { mood: "sultry", label: "妖艶" },
  { mood: "cute", label: "かわいい" },
];

/** 体型のつまみ。 */
const BODY_PARTS: Array<{ key: keyof Body; label: string }> = [
  { key: "head", label: "頭の大きさ" },
  { key: "legs", label: "脚の長さ" },
  { key: "arms", label: "腕の長さ" },
  { key: "build", label: "体の太さ" },
  { key: "shoulders", label: "肩幅" },
];

/** 頭身の目安になる型。細かく作り込むより、まずここから寄せるほうが早い。 */
const BODY_PRESETS: Array<{ label: string; body: Body }> = [
  { label: "標準", body: { head: 1, legs: 1, arms: 1, build: 1, shoulders: 1 } },
  { label: "スタイル良く", body: { head: 0.9, legs: 1.14, arms: 1.04, build: 0.9, shoulders: 0.98 } },
  { label: "デフォルメ", body: { head: 1.4, legs: 0.82, arms: 0.9, build: 1.16, shoulders: 0.9 } },
  { label: "がっしり", body: { head: 0.94, legs: 0.96, arms: 1.02, build: 1.3, shoulders: 1.25 } },
];

const DEFAULT_PROJECT_BODY: Body = { head: 1, legs: 1, arms: 1, build: 1, shoulders: 1 };

/** プレビューの表示上の最大の高さ（CSS ピクセル）。 */
const PREVIEW_MAX_HEIGHT = 400;

export function DanceStudio({ project, onChange, onBodyChange, playPosition }: DanceStudioProps) {
  const dance = project.dance;

  const [sizeId, setSizeId] = useState("portrait");
  const [paletteId, setPaletteId] = useState("night");
  const [fps, setFps] = useState<FrameRate>(30);
  const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });
  const [previewRunning, setPreviewRunning] = useState(true);
  const [floor, setFloor] = useState(false);
  const [drawMode, setDrawMode] = useState<DrawMode>("depth");

  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const exportRef = useRef<HTMLCanvasElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 再生していないときにプレビューを回すための自前の時計。 */
  const clockRef = useRef({ startedAt: 0, running: false });

  const size = getVideoSize(sizeId);
  const palette = getPalette(paletteId);
  const beatSeconds = secondsPerBeat(project);
  const loopBeats = beatsPerLoop(project);

  /** 描画に使うサンプリング設定。プレビューと書き出しで必ず同じものを使う。 */
  const sampleOpts = useMemo(
    () => ({
      bounce: dance.bounce,
      groove: dance.groove,
      chain: dance.chain,
      snap: dance.snap,
      follow: dance.follow,
      body: project.body,
    }),
    [dance.bounce, dance.groove, dance.chain, dance.snap, dance.follow, project.body],
  );

  /** rAF から最新の値を読むための箱。再描画のたびにループを張り直さないため。 */
  const liveRef = useRef({ playPosition, secondsPerBeat: beatSeconds, opts: sampleOpts });

  const choreo = useMemo(() => generateChoreography(loopBeats, dance), [loopBeats, dance]);

  // プレビューは書き出しと同じ縦横比にする。見えているものがそのまま出るように
  const previewSize = useMemo(() => {
    const scale = Math.min(1, PREVIEW_MAX_HEIGHT / size.height);
    return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
  }, [size]);

  const previewStage = useMemo(
    () => createStage(previewSize.width, previewSize.height, choreo, sampleOpts),
    [previewSize, choreo, sampleOpts],
  );

  const drawOptions = useMemo(
    () => ({ palette, body: project.body, floor, mode: drawMode }),
    [palette, project.body, floor, drawMode],
  );

  // 描画ループは張りっぱなしにして、変わる値だけをここから流し込む。
  // 再生位置が更新されるたびにループを組み直すと、毎フレーム張り替えになる。
  useEffect(() => {
    liveRef.current = { playPosition, secondsPerBeat: beatSeconds, opts: sampleOpts };
  }, [playPosition, beatSeconds, sampleOpts]);

  // --- プレビューの描画ループ ---
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const tick = () => {
      const live = liveRef.current;
      let countPos: number;
      if (live.playPosition !== null) {
        // 再生中は音に合わせる
        countPos = live.playPosition;
        clockRef.current.running = false;
      } else if (previewRunning) {
        // 止まっているときは自前の時計で回す
        if (!clockRef.current.running) {
          clockRef.current = { startedAt: performance.now(), running: true };
        }
        countPos = (performance.now() - clockRef.current.startedAt) / 1000 / live.secondsPerBeat;
      } else {
        clockRef.current.running = false;
        countPos = 0;
      }

      const skeleton = sampleSkeleton(choreo, countPos, live.opts);
      drawFrame(ctx, skeleton, previewStage, drawOptions);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [choreo, previewStage, drawOptions, previewRunning]);

  const patch = useCallback(
    (next: Partial<DanceSettings>) => onChange({ ...dance, ...next }),
    [dance, onChange],
  );

  const reroll = useCallback(() => {
    // 手で決めたブロックは残したまま、自動のところだけ引き直す
    patch({ seed: 1 + Math.floor(Math.random() * 999998) });
  }, [patch]);

  const videoFormat = useMemo(() => pickVideoFormat(), []);
  const canRecord =
    videoFormat !== null &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function";

  const exportSeconds = totalSeconds(project);

  const handleExport = useCallback(async () => {
    const canvas = exportRef.current;
    if (!canvas || !canRecord) return;

    canvas.width = size.width;
    canvas.height = size.height;

    const controller = new AbortController();
    abortRef.current = controller;
    setExportState({ kind: "working", ratio: 0 });

    try {
      const stage = createStage(size.width, size.height, choreo, sampleOpts);
      const result = await recordDance({
        canvas,
        choreo,
        stage,
        draw: { palette, body: project.body, floor, mode: drawMode },
        bounce: dance.bounce,
        groove: dance.groove,
        chain: dance.chain,
        snap: dance.snap,
        follow: dance.follow,
        body: project.body,
        secondsPerBeat: beatSeconds,
        totalBeats: loopBeats * project.repeats,
        fps,
        signal: controller.signal,
        onProgress: (ratio) => setExportState({ kind: "working", ratio }),
      });

      const filename = safeFilename(`dance-${dance.seed}`) + `.${result.format.extension}`;
      const base = { kind: "ready" as const, blob: result.blob, filename, codec: result.codec };
      if (saveNeedsUserTap()) {
        setExportState({ ...base, needsTap: true, outcome: null });
      } else {
        setExportState({ ...base, needsTap: false, outcome: await saveBlob(result.blob, filename) });
      }
    } catch (err) {
      if (err instanceof RecordAborted) {
        setExportState({ kind: "idle" });
        return;
      }
      setExportState({
        kind: "error",
        message: err instanceof Error ? err.message : "動画を作れませんでした。",
      });
    } finally {
      abortRef.current = null;
    }
  }, [
    canRecord,
    size,
    choreo,
    sampleOpts,
    dance.bounce,
    dance.groove,
    dance.chain,
    dance.snap,
    dance.follow,
    dance.seed,
    loopBeats,
    project.repeats,
    palette,
    floor,
    drawMode,
    project.body,
    beatSeconds,
    fps,
  ]);

  const handleManualSave = useCallback(async () => {
    if (exportState.kind !== "ready") return;
    const outcome = await saveBlob(exportState.blob, exportState.filename);
    setExportState({ ...exportState, needsTap: false, outcome });
  }, [exportState]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);


  return (
    <>
      <section className="panel">
        <h2>振り付けとプレビュー</h2>
        <div className="dance-layout">
          <div className="dance-preview">
            <canvas
              ref={previewRef}
              width={previewSize.width}
              height={previewSize.height}
              style={{ width: previewSize.width, height: previewSize.height }}
            />
            <div className="row">
              <button className="btn" onClick={() => setPreviewRunning((v) => !v)}>
                {previewRunning ? "⏸ プレビュー停止" : "▶ プレビュー再生"}
              </button>
              <button className="btn" onClick={reroll}>
                🎲 振り付けを引き直す
              </button>
            </div>
            <p className="hint">
              シード {dance.seed} ／ {choreo.blocks.length} ブロック（{loopBeats} 拍）
              {playPosition !== null && " ／ 音源に同期中"}
            </p>
          </div>

          <div className="dance-controls">
            <div className="row">
              <div className="field">
                <label htmlFor="dance-intensity">動きの大きさ</label>
                <input
                  id="dance-intensity"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={dance.intensity}
                  onChange={(e) => patch({ intensity: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label htmlFor="dance-bounce">ビートの乗り</label>
                <input
                  id="dance-bounce"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={dance.bounce}
                  onChange={(e) => patch({ bounce: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label htmlFor="dance-groove">ノリの向き（縦↔横）</label>
                <input
                  id="dance-groove"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={dance.groove}
                  onChange={(e) => patch({ groove: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label htmlFor="dance-snap">ダイナミクス</label>
                <input
                  id="dance-snap"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={dance.snap}
                  onChange={(e) => patch({ snap: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label htmlFor="dance-follow">追従（振り終わりの余韻）</label>
                <input
                  id="dance-follow"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={dance.follow}
                  onChange={(e) => patch({ follow: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label htmlFor="dance-chain">体の連鎖</label>
                <input
                  id="dance-chain"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={dance.chain}
                  onChange={(e) => patch({ chain: Number(e.target.value) })}
                />
              </div>
            </div>

            <div className="row">
              <div className="field">
                <label htmlFor="dance-size">サイズ</label>
                <select id="dance-size" value={sizeId} onChange={(e) => setSizeId(e.target.value)}>
                  {VIDEO_SIZES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="dance-mode">描き方</label>
                <select
                  id="dance-mode"
                  value={drawMode}
                  onChange={(e) => setDrawMode(e.target.value as DrawMode)}
                >
                  <option value="depth">深度マップ</option>
                  <option value="mannequin">マネキン</option>
                </select>
              </div>
              {drawMode === "mannequin" && (
                <div className="field">
                  <label htmlFor="dance-palette">配色</label>
                  <select
                    id="dance-palette"
                    value={paletteId}
                    onChange={(e) => setPaletteId(e.target.value)}
                  >
                    {PALETTES.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field">
                <label htmlFor="dance-floor">床</label>
                <label className="checkline" htmlFor="dance-floor">
                  <input
                    id="dance-floor"
                    type="checkbox"
                    checked={floor}
                    onChange={(e) => setFloor(e.target.checked)}
                  />
                  描く
                </label>
              </div>
              <div className="field">
                <label htmlFor="dance-fps">フレームレート</label>
                <select
                  id="dance-fps"
                  value={fps}
                  onChange={(e) => setFps(Number(e.target.value) as FrameRate)}
                >
                  {FRAME_RATES.map((r) => (
                    <option key={r} value={r}>
                      {r} fps
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <p className="hint">
              「動きの大きさ」を上げると、大ぶりな振りが選ばれやすくなります。
              「ビートの乗り」は拍への乗りの深さです。0 にすると踊っているように
              見えなくなるので、少しは残しておくのがおすすめです。
              「ノリの向き」は左に振ると縦（沈み込み）、右に振ると横（重心の左右移動）。
              縦だけだとスクワットに見えることがあります。
              「ダイナミクス」がキレを決めます。上げるほど速く動いて止まり、
              行き過ぎてから戻り、振り幅と上下動も大きくなります。0 にすると
              終始等速で動き続ける体操になります。
              「追従」は振り終わりの余韻です。手先が止まる位置を少し行き過ぎてから
              戻り、振り始めにはわずかに引きます。急に止まるほど大きく出るので、
              重さのあるものの止まり方になります。上げるほど手先が速くなるので、
              映像変換が追いつかないときはここを下げてください。
              「体の連鎖」は腰から手先へ動きが伝わる遅れの量です。0 だと全身が同時に
              動いて人形のように見えます。
            </p>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>体型</h2>
        <p className="hint">
          映像変換は入力のプロポーションを参照します。背丈そのものは画角が
          自動で合わせるため見た目に出ませんが、頭身や脚の長さは変換後の
          キャラクターに残ります。
        </p>
        <div className="row">
          {BODY_PRESETS.map((preset) => (
            <button key={preset.label} className="btn small" onClick={() => onBodyChange(preset.body)}>
              {preset.label}
            </button>
          ))}
        </div>
        <div className="row">
          {BODY_PARTS.map(({ key, label }) => (
            <div className="field" key={key}>
              <label htmlFor={`body-${key}`}>{label}</label>
              <input
                id={`body-${key}`}
                type="range"
                min={BODY_RANGE.min}
                max={BODY_RANGE.max}
                step={0.02}
                value={project.body[key]}
                onChange={(e) => onBodyChange({ ...project.body, [key]: Number(e.target.value) })}
              />
            </div>
          ))}
        </div>
        <p className="hint">
          およそ {headToBody(project.body).toFixed(1)} 頭身 ／ 身長は標準の{" "}
          {Math.round((restHeightOf(project.body) / restHeightOf(DEFAULT_PROJECT_BODY)) * 100)}%
        </p>
      </section>

      <section className="panel">
        <h2>振り付けの中身</h2>
        <p className="hint">
          1小節ごとに振りを差し替えられます。気に入らないところだけ選び直してください。
          手で選んだ小節は、引き直してもそのまま残ります。
          「ボックスステップ」と「半回転」だけは2小節ぶん使います。
        </p>
        <ol className="dance-blocks">
          {choreo.blocks.map((block) => (
            <li key={block.slot} className={block.manual ? "manual" : undefined}>
              <span className="dance-block-range">
                {Math.floor(block.startCount / project.beatsPerBar) + 1}–
                {Math.floor((block.startCount + block.counts - 0.001) / project.beatsPerBar) + 1}
                小節
              </span>
              <select
                value={block.manual ? block.moveId : "auto"}
                onChange={(e) => {
                  const value = e.target.value;
                  onChange(
                    withOverride(
                      dance,
                      block.slot,
                      value === "auto" ? null : { moveId: value, mirrored: block.mirrored },
                    ),
                  );
                }}
              >
                {/* 手動のときは「自動なら何が来るか」が分からないので名前を出さない */}
                <option value="auto">{block.manual ? "自動" : `自動（${blockLabel(block)}）`}</option>
                {MOOD_GROUPS.map(({ mood, label }) => {
                  const group = MOVES.filter((m) => m.mood === mood);
                  if (group.length === 0) return null;
                  return (
                    <optgroup key={label} label={label}>
                      {group.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={block.mirrored}
                  onChange={(e) =>
                    onChange(
                      withOverride(dance, block.slot, {
                        moveId: block.moveId,
                        mirrored: e.target.checked,
                      }),
                    )
                  }
                />
                左右反転
              </label>
            </li>
          ))}
        </ol>
        {dance.overrides.some((o) => o !== null) && (
          <button className="btn" onClick={() => patch({ overrides: [] })}>
            すべて自動に戻す
          </button>
        )}
      </section>

      <section className="panel">
        <h2>動画を書き出す</h2>
        {!canRecord ? (
          <p className="hint">
            このブラウザは動画の書き出し（MediaRecorder ＋ canvas.captureStream）に
            対応していません。PC の Chrome か Safari でお試しください。
          </p>
        ) : (
          <>
            <div className="row">
              <button
                className="btn primary"
                onClick={handleExport}
                disabled={exportState.kind === "working"}
              >
                {exportState.kind === "working" ? "録画中…" : "🎬 動画を書き出す"}
              </button>
              {exportState.kind === "working" && (
                <button className="btn" onClick={() => abortRef.current?.abort()}>
                  中止
                </button>
              )}
              {exportState.kind === "ready" && exportState.needsTap && (
                <button className="btn primary" onClick={handleManualSave}>
                  保存する
                </button>
              )}
            </div>

            {exportState.kind === "working" && (
              <p className="hint">
                {Math.round(exportState.ratio * 100)}%
                ／録画は実時間かかります（約 {Math.ceil(exportSeconds)} 秒）。
                終わるまでこのタブを開いたままにしてください。
              </p>
            )}
            {exportState.kind === "ready" && (
              <p className="hint">
                {exportState.filename} を作りました
                {exportState.codec && `（${exportState.codec}）`}
                {exportState.outcome === "blocked" &&
                  "。この表示のままでは保存できないので、単独のタブで開き直してください"}
                。
              </p>
            )}
            {exportState.kind === "error" && <p className="hint">{exportState.message}</p>}
            {exportState.kind !== "working" && (
              <p className="hint">
                形式は {videoFormat?.label}、長さは「小節数 × くり返し」で決まります
                （今は約 {Math.ceil(exportSeconds)} 秒）。
                映像変換サービスは尺の上限があることが多いので、まずは 8〜16 小節で
                試すのが安全です。
              </p>
            )}
          </>
        )}

        {/* 書き出し用。captureStream を使うため、画面外だが描画される場所に置く */}
        <canvas ref={exportRef} className="dance-export-canvas" />
      </section>
    </>
  );
}
