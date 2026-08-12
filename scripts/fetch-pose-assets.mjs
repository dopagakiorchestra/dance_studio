/**
 * 姿勢推定に使う資材を public/pose/ に用意する。
 *
 * WASM は npm の @mediapipe/tasks-vision に入っているのでコピーするだけ。
 * モデル（.task）は npm には含まれないので Google の配布元から落とす。
 *
 * 合わせて 28MB ほどあるのでリポジトリには入れず、ビルドのたびに用意する
 * （.gitignore 済み）。取れなかったら黙って進めずに落とすこと。動画の
 * 取り込みだけが実行時に静かに壊れるほうが厄介なので。
 */
import { createWriteStream } from "node:fs";
import { mkdir, copyFile, stat, readdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "public", "pose");
const WASM_SRC = path.join(ROOT, "node_modules", "@mediapipe", "tasks-vision", "wasm");

/** 姿勢推定モデル。lite / full / heavy のうち一番軽いもの。 */
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const MODEL_OUT = path.join(OUT, "pose_landmarker_lite.task");

async function exists(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

await mkdir(path.join(OUT, "wasm"), { recursive: true });

const names = await readdir(WASM_SRC).catch(() => {
  throw new Error(`@mediapipe/tasks-vision が入っていない。npm install を先に。`);
});
for (const name of names) {
  await copyFile(path.join(WASM_SRC, name), path.join(OUT, "wasm", name));
}
console.log(`pose: wasm ${names.length} 件をコピー`);

if (await exists(MODEL_OUT)) {
  console.log("pose: モデルは取得済み");
} else {
  const res = await fetch(MODEL);
  if (!res.ok) throw new Error(`モデルを取得できない: ${res.status} ${MODEL}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(MODEL_OUT));
  const { size } = await stat(MODEL_OUT);
  console.log(`pose: モデルを取得 ${(size / 1048576).toFixed(1)}MB`);
}
