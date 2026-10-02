import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SAMPLE_RATE,
  N_FFT,
  HOP_LENGTH,
  N_MELS,
  FPS,
  CHUNK_SIZE,
  BORDER_SIZE,
  PEAK_RADIUS,
  PEAK_THRESHOLD,
  MAX_INPUT_SECONDS,
  MIN_BPM,
  MAX_BPM,
  DEFAULT_METER,
  SONGBIRD_MODEL_BASE,
  MEL_MODEL_FILE,
  BEAT_MODEL_FILE,
  MEL_MODEL_BYTES,
  SMALL_MODEL_BYTES,
  ORT_WASM_BYTES,
  ORT_LOADER_BYTES,
  ORT_MODULE_URL,
  ORT_VERSION,
  estimateDownloadBytes,
  clamp,
  round,
  mixToMono,
  resampleLinear,
  melFrameCount,
  frameToSeconds,
  secondsToFrame,
  planSpectChunks,
  buildChunkInput,
  aggregateChunkPredictions,
  deduplicatePeaks,
  pickPeaks,
  snapToBeats,
  estimateTempo,
  inferMeter,
  buildBeatGrid,
  gridToJson,
  gridToCsv,
  BEAT_HANDOFF_KEY,
  HANDOFF_MAX_BYTES,
  compactGrid,
  serializeBeatHandoff,
  deserializeBeatHandoff,
  canHandoffBeat,
  isSupportedAudioFile,
  sanitizeBaseName,
  buildFileName,
  formatBytes,
  formatSeconds,
  formatMeter,
} from '../pipeline.mjs';

/* ==========================================================
   カタログ / 定数
   ========================================================== */

test('前処理の定数は公式 LogMelSpect に一致する', () => {
  assert.equal(SAMPLE_RATE, 22050);
  assert.equal(N_FFT, 1024);
  assert.equal(HOP_LENGTH, 441);
  assert.equal(N_MELS, 128);
  assert.equal(FPS, 50);
  assert.equal(PEAK_RADIUS, 3);
  assert.equal(PEAK_THRESHOLD, 0);
  assert.equal(MAX_INPUT_SECONDS, 600);
});

test('モデルの入手先と見積りは実測値に基づく', () => {
  assert.ok(SONGBIRD_MODEL_BASE.startsWith('https://huggingface.co/ashudesai/songbird-models/'));
  assert.equal(MEL_MODEL_FILE, 'mel_spectrogram.onnx');
  assert.equal(BEAT_MODEL_FILE, 'small0.onnx');
  assert.equal(MEL_MODEL_BYTES, 302301);
  assert.equal(SMALL_MODEL_BYTES, 10401044);
  assert.equal(estimateDownloadBytes(), MEL_MODEL_BYTES + SMALL_MODEL_BYTES + ORT_WASM_BYTES + ORT_LOADER_BYTES);
  assert.ok(ORT_MODULE_URL.includes(`onnxruntime-web@${ORT_VERSION}`));
  assert.ok(ORT_MODULE_URL.endsWith('.mjs'));
});

/* ==========================================================
   数値
   ========================================================== */

test('clamp / round は非数値と桁を丸める', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp('x', 3, 10), 3);
  assert.equal(round(1.234567, 2), 1.23);
  assert.equal(round(NaN), 0);
});

/* ==========================================================
   モノラル化 / リサンプル
   ========================================================== */

test('mixToMono はチャンネルを平均し、元配列を破壊しない', () => {
  const left = Float32Array.from([1, 0, -1]);
  const right = Float32Array.from([1, 1, 1]);
  const mono = mixToMono([left, right]);
  assert.deepEqual(Array.from(mono).map((v) => +v.toFixed(4)), [1, 0.5, 0]);
  assert.deepEqual(Array.from(left), [1, 0, -1]);
  assert.equal(mixToMono([]).length, 0);
  assert.deepEqual(Array.from(mixToMono([Float32Array.from([0.5, -0.5])])), [0.5, -0.5]);
});

test('resampleLinear はレート比で長さを変え、端点を保つ', () => {
  const out = resampleLinear(Float32Array.from([0, 10]), 1, 2);
  assert.equal(out.length, 4);
  assert.equal(out[0], 0);
  assert.equal(out[3], 10);
  assert.deepEqual(Array.from(resampleLinear(Float32Array.from([7]), 48000, 22050)), [7]);
  assert.throws(() => resampleLinear([1, 2], 0, 22050), /正の数/);
  assert.equal(resampleLinear([], 48000, 22050).length, 0);
});

/* ==========================================================
   フレーム / チャンク
   ========================================================== */

test('melFrameCount は floor(N/hop)+1 を返す', () => {
  assert.equal(melFrameCount(0), 0);
  assert.equal(melFrameCount(441), 2);
  assert.equal(melFrameCount(22050), 51);
  assert.equal(melFrameCount(-5), 0);
  assert.throws(() => melFrameCount(100, 0), /正の数/);
});

test('frameToSeconds / secondsToFrame は往復する', () => {
  assert.equal(frameToSeconds(50), 1);
  assert.equal(frameToSeconds(0), 0);
  assert.equal(secondsToFrame(1), 50);
  assert.equal(secondsToFrame(0.5), 25);
});

test('planSpectChunks はチャンク長以下なら 1 窓にする', () => {
  assert.deepEqual(planSpectChunks(0), []);
  assert.deepEqual(planSpectChunks(100, { chunkSize: 200, border: 6 }), [
    { start: 0, chunkStart: 0, chunkEnd: 100, padLeft: 0, padRight: 0 },
  ]);
  assert.deepEqual(planSpectChunks(200, { chunkSize: 200, border: 6 }), [
    { start: 0, chunkStart: 0, chunkEnd: 200, padLeft: 0, padRight: 0 },
  ]);
});

test('planSpectChunks は公式と同じ開始位置とパディングを返す', () => {
  const plans = planSpectChunks(10, { chunkSize: 4, border: 1 });
  assert.deepEqual(plans, [
    { start: -1, chunkStart: 0, chunkEnd: 3, padLeft: 1, padRight: 0 },
    { start: 1, chunkStart: 1, chunkEnd: 5, padLeft: 0, padRight: 0 },
    { start: 3, chunkStart: 3, chunkEnd: 7, padLeft: 0, padRight: 0 },
    { start: 5, chunkStart: 5, chunkEnd: 9, padLeft: 0, padRight: 0 },
    { start: 7, chunkStart: 7, chunkEnd: 10, padLeft: 0, padRight: 1 },
  ]);
});

test('planSpectChunks は最後の開始位置を末尾へ寄せる', () => {
  const plans = planSpectChunks(5, { chunkSize: 4, border: 1 });
  assert.equal(plans[plans.length - 1].start, 2);
  assert.equal(plans[plans.length - 1].chunkEnd, 5);
  assert.equal(plans[plans.length - 1].padRight, 1);
});

test('planSpectChunks は不正な引数を拒否する', () => {
  assert.throws(() => planSpectChunks(-1), /不正/);
  assert.throws(() => planSpectChunks(10, { chunkSize: 0 }), /チャンク長/);
  assert.throws(() => planSpectChunks(10, { chunkSize: 4, border: 2 }), /border/);
});

test('buildChunkInput は左右をゼロで埋めて 1 チャンクを作る', () => {
  const spect = Float32Array.from([0, 1, 2, 3, 4, 5]);
  const plan = { start: 0, chunkStart: 1, chunkEnd: 3, padLeft: 1, padRight: 1 };
  const chunk = buildChunkInput(spect, plan, 2, 4);
  assert.deepEqual(Array.from(chunk), [0, 0, 2, 3, 4, 5, 0, 0]);
});

test('aggregateChunkPredictions は keep_first で先のチャンクを優先する', () => {
  const plans = planSpectChunks(5, { chunkSize: 4, border: 1 });
  const chunkPreds = plans.map((_, i) => ({
    beat: Float32Array.from([i * 10, i * 10 + 1, i * 10 + 2, i * 10 + 3]),
    downbeat: Float32Array.from([i * 100, i * 100 + 1, i * 100 + 2, i * 100 + 3]),
  }));
  const { beat } = aggregateChunkPredictions(chunkPreds, plans, 5, { chunkSize: 4, border: 1 });
  assert.deepEqual(Array.from(beat), [1, 2, 11, 12, 22]);
});

/* ==========================================================
   ピーク検出
   ========================================================== */

test('deduplicatePeaks は近接フレームを平均でまとめる', () => {
  assert.deepEqual(deduplicatePeaks([1, 2, 5, 6, 7, 20], 1), [1.5, 5.5, 7, 20]);
  assert.deepEqual(deduplicatePeaks([], 1), []);
  assert.deepEqual(deduplicatePeaks([3], 1), [3]);
});

test('pickPeaks は ±radius の最大値かつしきい値超のフレームを秒で返す', () => {
  const logits = new Float32Array(11);
  logits[2] = 5;
  logits[8] = 3;
  logits[7] = 1;
  assert.deepEqual(pickPeaks(logits), [0.04, 0.16]);
  assert.deepEqual(pickPeaks(new Float32Array(11)), []);
});

test('pickPeaks はしきい値と半径を尊重する', () => {
  const logits = Float32Array.from([2, 0.5, 0.2, 0.1]);
  assert.deepEqual(pickPeaks(logits), [0]);
  assert.deepEqual(pickPeaks(logits, { threshold: 0.4 }), [0]);
  assert.deepEqual(pickPeaks(logits, { radius: 1 }), [0]);
});

test('snapToBeats は最寄りのビートへ寄せて重複を除く', () => {
  assert.deepEqual(snapToBeats([0.49, 1.02], [0, 0.5, 1, 1.5]), [0.5, 1]);
  assert.deepEqual(snapToBeats([0.49, 1.02], [0, 0.5, 1, 1.5], 0.01), []);
  assert.deepEqual(snapToBeats([1, 2], []), []);
});

/* ==========================================================
   テンポ / 拍子
   ========================================================== */

test('estimateTempo は間隔の中央値から BPM を出す', () => {
  const tempo = estimateTempo([0, 0.5, 1.0, 1.5, 2.0]);
  assert.equal(tempo.bpm, 120);
  assert.equal(tempo.confidence, 1);
  assert.equal(tempo.intervalCount, 4);
  assert.equal(tempo.intervalSeconds, 0.5);
});

test('estimateTempo は速すぎる外れ値を除く', () => {
  const tempo = estimateTempo([0, 0.5, 1.0, 1.5, 5.0]);
  assert.equal(tempo.bpm, 120);
  assert.equal(tempo.intervalCount, 3);
});

test('estimateTempo はビート不足で 0 を返す', () => {
  assert.deepEqual(estimateTempo([]), { bpm: 0, confidence: 0, intervalCount: 0, intervalSeconds: 0 });
  assert.equal(estimateTempo([1]).bpm, 0);
  assert.ok(MIN_BPM < MAX_BPM);
});

test('inferMeter はダウンビート間の拍数から拍子を出す', () => {
  const four = inferMeter(
    [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5],
    [0, 2.0],
  );
  assert.equal(four.beatsPerBar, 4);
  assert.equal(four.confidence, 1);
  const three = inferMeter([0, 0.5, 1.0, 1.5, 2.0, 2.5], [0, 1.5, 3.0]);
  assert.equal(three.beatsPerBar, 3);
  assert.equal(three.confidence, 1);
});

test('inferMeter はダウンビート不足で既定値を返す', () => {
  assert.deepEqual(inferMeter([0, 0.5], []), { beatsPerBar: DEFAULT_METER, confidence: 0, samples: 0 });
  assert.equal(inferMeter([0, 0.5], [0]).beatsPerBar, DEFAULT_METER);
});

/* ==========================================================
   グリッド / 書き出し
   ========================================================== */

test('buildBeatGrid は範囲外を除き統計をまとめる', () => {
  const grid = buildBeatGrid(
    [-1, 0, 0.5, 1.0, 1.5, 9999],
    [0, 1.0, 9999],
    { duration: 2 },
  );
  assert.deepEqual(grid.beats, [0, 0.5, 1, 1.5]);
  assert.deepEqual(grid.downbeats, [0, 1]);
  assert.equal(grid.bpm, 120);
  assert.equal(grid.beatsPerBar, 2);
  assert.equal(grid.beatCount, 4);
  assert.equal(grid.downbeatCount, 2);
  assert.equal(grid.firstBeat, 0);
  assert.equal(grid.lastBeat, 1.5);
  assert.equal(grid.duration, 2);
  assert.equal(grid.version, 1);
});

test('buildBeatGrid はビート無しでも壊れない', () => {
  const grid = buildBeatGrid([], []);
  assert.equal(grid.beatCount, 0);
  assert.equal(grid.bpm, 0);
  assert.equal(grid.firstBeat, null);
});

test('gridToJson / gridToCsv は内容を書き出せる', () => {
  const grid = buildBeatGrid([0, 0.5, 1.0], [0], { duration: 1 });
  const json = JSON.parse(gridToJson(grid));
  assert.equal(json.beats.length, 3);
  const csv = gridToCsv(grid);
  assert.equal(
    csv,
    ['time_seconds,type', '0,downbeat', '0.5,beat', '1,beat', ''].join('\n'),
  );
});

/* ==========================================================
   受け渡し
   ========================================================== */

test('handoff のキーは midi-studio と一致する', () => {
  assert.equal(BEAT_HANDOFF_KEY, 'myapps:beat-grid');
  assert.ok(HANDOFF_MAX_BYTES > 0);
});

test('compactGrid / serialize / deserialize は往復する', () => {
  const grid = buildBeatGrid([0, 0.5, 1.0], [0], { duration: 1 });
  const compact = compactGrid(grid);
  assert.deepEqual(Object.keys(compact).sort(), ['beats', 'beatsPerBar', 'bpm', 'downbeats', 'duration', 'version']);
  const restored = deserializeBeatHandoff(serializeBeatHandoff(grid));
  assert.equal(restored.bpm, 120);
  assert.deepEqual(restored.beats, [0, 0.5, 1]);
  assert.deepEqual(restored.downbeats, [0]);
});

test('deserializeBeatHandoff は不正入力を null にする', () => {
  assert.equal(deserializeBeatHandoff(''), null);
  assert.equal(deserializeBeatHandoff('{'), null);
  assert.equal(deserializeBeatHandoff('null'), null);
  assert.equal(deserializeBeatHandoff(JSON.stringify({ beats: [] })), null);
  assert.equal(deserializeBeatHandoff(JSON.stringify({ beats: [1, 'x'] })), null);
  assert.equal(deserializeBeatHandoff(JSON.stringify({ beats: [1], downbeats: 'x' })), null);
});

test('canHandoffBeat は小さいグリッドを許可し、巨大なものを拒否する', () => {
  const grid = buildBeatGrid([0, 0.5, 1.0], [0], { duration: 1 });
  assert.equal(canHandoffBeat(grid), true);
  const huge = { bpm: 120, beatsPerBar: 4, beats: Array.from({ length: 200000 }, (_, i) => i * 0.5), downbeats: [], duration: 100000 };
  assert.ok(serializeBeatHandoff(huge).length > HANDOFF_MAX_BYTES);
  assert.equal(canHandoffBeat(huge), false);
});

/* ==========================================================
   ファイル / 表示
   ========================================================== */

test('isSupportedAudioFile は拡張子で判定する', () => {
  assert.equal(isSupportedAudioFile('take.m4a'), true);
  assert.equal(isSupportedAudioFile('take.WAV'), true);
  assert.equal(isSupportedAudioFile({ name: 'song.mp3' }), true);
  assert.equal(isSupportedAudioFile('song.txt'), false);
  assert.equal(isSupportedAudioFile(null), false);
});

test('sanitizeBaseName / buildFileName は安全な名前を作る', () => {
  assert.equal(sanitizeBaseName('My Song!.m4a'), 'My_Song');
  assert.equal(sanitizeBaseName('曲'), 'beats');
  assert.equal(buildFileName('take.wav', '.csv'), 'take.csv');
  assert.equal(buildFileName('take.wav', 'json'), 'take.json');
  assert.equal(buildFileName('', '.json'), 'beats.json');
});

test('formatBytes / formatSeconds / formatMeter は読みやすい表示にする', () => {
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(2048), '2.0 KiB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MiB');
  assert.equal(formatBytes(-1), '-');
  assert.equal(formatSeconds(0), '0:00.0');
  assert.equal(formatSeconds(61.5), '1:01.5');
  assert.equal(formatSeconds(NaN), '0:00.0');
  assert.equal(formatMeter(4), '4/4');
  assert.equal(formatMeter(0), '1/4');
  assert.equal(formatMeter(13), '12/4');
});
