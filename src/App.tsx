/**
 * 画面全体。
 *
 * 入力は BPM・拍子・小節数・くり返しの4つだけ。ここから振り付けの長さが
 * 決まり、あとは dance/ 以下が組み立てる。
 *
 * 音源ファイルは「プレビューを実際の曲に合わせて見る」ためだけに読み込む。
 * 書き出す動画には入らない。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { AudioTrack, beatPosition } from "./audio";
import { DanceStudio } from "./components/DanceStudio";
import type { DanceSettings } from "./dance/choreo";
import {
  BARS_RANGE,
  BEATS_PER_BAR,
  BPM_RANGE,
  REPEATS_RANGE,
  beatsPerLoop,
  loadProject,
  loopSeconds,
  saveProject,
  secondsPerBeat,
  shareUrl,
  totalSeconds,
  type DanceProject,
} from "./project";

export default function App() {
  const [project, setProject] = useState<DanceProject>(() => loadProject());
  const [playing, setPlaying] = useState(false);
  /** 再生中のループ内の拍位置。プレビューを音に合わせるのに使う。 */
  const [playPosition, setPlayPosition] = useState<number | null>(null);
  const [trackName, setTrackName] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const trackRef = useRef<AudioTrack | null>(null);
  const track = (): AudioTrack => {
    if (!trackRef.current) trackRef.current = new AudioTrack();
    return trackRef.current;
  };

  // 保存（スライダー操作中の連続書き込みを避けるため少し待つ）
  useEffect(() => {
    const t = window.setTimeout(() => saveProject(project), 400);
    return () => window.clearTimeout(t);
  }, [project]);

  // 再生位置の取り出し
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const seconds = trackRef.current?.position();
      setPlayPosition(
        seconds === null || seconds === undefined
          ? null
          : beatPosition(seconds, secondsPerBeat(project), beatsPerLoop(project)),
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, project]);

  // 画面を離れるときは音を止める
  useEffect(() => () => trackRef.current?.dispose(), []);

  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 6000);
    return () => window.clearTimeout(t);
  }, [note]);

  const patch = useCallback((next: Partial<DanceProject>) => {
    setProject((current) => ({ ...current, ...next }));
  }, []);

  const handleDanceChange = useCallback((dance: DanceSettings) => {
    setProject((current) => ({ ...current, dance }));
  }, []);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const info = await track().load(file);
      setPlaying(false);
      setPlayPosition(null);
      setTrackName(info.name);
      setNote(
        info.duration > 0
          ? `${info.name} を読み込みました（${Math.round(info.duration)} 秒）。`
          : `${info.name} を読み込みました。`,
      );
    } catch (err) {
      setNote(`音源を読み込めませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handlePlay = async () => {
    const t = track();
    if (!t.loaded) return;
    if (playing) {
      t.pause();
      setPlaying(false);
      setPlayPosition(null);
      return;
    }
    try {
      await t.play();
      setPlaying(true);
    } catch (err) {
      setNote(`再生を開始できませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleShare = async () => {
    const url = shareUrl(project, window.location.href);
    try {
      await navigator.clipboard.writeText(url);
      setNote("共有リンクをコピーしました。");
    } catch {
      // クリップボードが使えないときは URL に載せるだけにして、手で選んでもらう
      window.location.hash = url.split("#")[1] ?? "";
      setNote("共有リンクをアドレスバーに入れました。コピーしてお使いください。");
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>💃 Dance Studio</h1>
          <p className="sub">
            マネキンが踊る無音動画を作ります。映像変換サービスに通して
            キャラクターに置き換えるための素材向けです。
          </p>
        </div>
      </header>

      <section className="panel">
        <h2>曲の設定</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="bpm">BPM</label>
            <input
              id="bpm"
              type="number"
              min={BPM_RANGE.min}
              max={BPM_RANGE.max}
              value={project.bpm}
              onChange={(e) => patch({ bpm: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label htmlFor="beats-per-bar">拍子</label>
            <select
              id="beats-per-bar"
              value={project.beatsPerBar}
              onChange={(e) => patch({ beatsPerBar: Number(e.target.value) })}
            >
              {BEATS_PER_BAR.map((b) => (
                <option key={b} value={b}>
                  {b}/4
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="bars">小節数</label>
            <input
              id="bars"
              type="number"
              min={BARS_RANGE.min}
              max={BARS_RANGE.max}
              value={project.bars}
              onChange={(e) => patch({ bars: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label htmlFor="repeats">くり返し</label>
            <input
              id="repeats"
              type="number"
              min={REPEATS_RANGE.min}
              max={REPEATS_RANGE.max}
              value={project.repeats}
              onChange={(e) => patch({ repeats: Number(e.target.value) })}
            />
          </div>
        </div>
        <p className="hint">
          1ループ {beatsPerLoop(project)} 拍（約 {Math.ceil(loopSeconds(project))} 秒）、
          書き出しはこれを {project.repeats} 回くり返して約 {Math.ceil(totalSeconds(project))} 秒に
          なります。
        </p>
        <div className="row">
          <button className="btn" onClick={handleShare}>
            🔗 共有リンクをコピー
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>音源に合わせて見る（任意）</h2>
        <p className="hint">
          手元の曲を読み込むと、プレビューがその音に合わせて動きます。
          この音は書き出す動画には入りません。
        </p>
        <div className="row">
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
          {trackName && (
            <button className="btn primary" onClick={handlePlay}>
              {playing ? "■ 停止" : "▶ 再生（ループ）"}
            </button>
          )}
        </div>
        {trackName && (
          <div className="row">
            <div className="field">
              <label htmlFor="offset">頭出し（秒）</label>
              <input
                id="offset"
                type="number"
                step={0.05}
                defaultValue={0}
                onChange={(e) => {
                  if (trackRef.current) trackRef.current.offset = Number(e.target.value);
                }}
              />
            </div>
            <p className="hint">
              1拍目が音源の何秒目にあるかを入れると、ずれが直ります。
            </p>
          </div>
        )}
        {note && <p className="hint">{note}</p>}
      </section>

      <DanceStudio project={project} onChange={handleDanceChange} playPosition={playPosition} />

      <footer className="footer">
        <p className="hint">
          書き出した動画は無音です。音は映像変換が終わったあとに動画編集側で
          合わせてください。
        </p>
      </footer>
    </div>
  );
}
