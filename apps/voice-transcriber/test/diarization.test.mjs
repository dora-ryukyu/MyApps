import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIARIZATION_MODEL_ID,
  DIARIZATION_VARIANTS,
  DIARIZATION_EXTRA_FILES,
  DIARIZATION_DTYPE,
  DIARIZATION_MAX_SPEAKERS,
  resolveDiarizationDtype,
  estimateDiarizationBytes,
  speakerLabel,
  overlapSeconds,
  probabilitiesToSegments,
  assignSpeakers,
  formatSpeakerTranscript,
} from '../pipeline.mjs';

/* ---------------------------------------------------------
   モデル定数
   --------------------------------------------------------- */
test('DIARIZATION_MODEL_ID は Nemotron 3 Diarization の ONNX 版', () => {
  assert.equal(DIARIZATION_MODEL_ID, 'onnx-community/Nemotron-3-Diarization-ONNX');
  assert.equal(DIARIZATION_MAX_SPEAKERS, 8);
});

test('DIARIZATION_VARIANTS は q4 / q4f16 の重みを持つ', () => {
  for (const dtype of ['q4', 'q4f16', 'quantized', 'fp16', 'fp32']) {
    assert.ok(dtype in DIARIZATION_VARIANTS, `${dtype} が無い`);
    assert.ok(Object.keys(DIARIZATION_VARIANTS[dtype]).length >= 2);
  }
  assert.ok('onnx/model_q4.onnx' in DIARIZATION_VARIANTS.q4);
  assert.ok('onnx/model_q4.onnx_data' in DIARIZATION_VARIANTS.q4);
});

test('resolveDiarizationDtype は WebGPU で q4f16、WASM で q4', () => {
  assert.equal(resolveDiarizationDtype('webgpu'), 'q4f16');
  assert.equal(resolveDiarizationDtype('wasm'), 'q4');
  assert.equal(resolveDiarizationDtype('unknown'), 'q4');
  assert.equal(DIARIZATION_DTYPE.webgpu, 'q4f16');
});

test('estimateDiarizationBytes は config 込みで見積もる', () => {
  const q4 = estimateDiarizationBytes('q4');
  const expected =
    DIARIZATION_VARIANTS.q4['onnx/model_q4.onnx'] +
    DIARIZATION_VARIANTS.q4['onnx/model_q4.onnx_data'] +
    Object.values(DIARIZATION_EXTRA_FILES).reduce((a, b) => a + b, 0);
  assert.equal(q4, expected);
  assert.ok(q4 > 70 * 1024 * 1024 && q4 < 100 * 1024 * 1024, `想定外のサイズ: ${q4}`);
  assert.throws(() => estimateDiarizationBytes('nope'), /未知の dtype/);
});

/* ---------------------------------------------------------
   話者名
   --------------------------------------------------------- */
test('speakerLabel は 0 から順に A, B, … を返す', () => {
  assert.equal(speakerLabel(0), '話者A');
  assert.equal(speakerLabel(1), '話者B');
  assert.equal(speakerLabel(7), '話者H');
  assert.equal(speakerLabel(25), '話者Z');
  assert.equal(speakerLabel(26), '話者27');
});

test('speakerLabel は不正な値で「話者不明」を返す', () => {
  assert.equal(speakerLabel(-1), '話者不明');
  assert.equal(speakerLabel(1.5), '話者不明');
  assert.equal(speakerLabel(null), '話者不明');
  assert.equal(speakerLabel(undefined), '話者不明');
});

/* ---------------------------------------------------------
   区間の重なり
   --------------------------------------------------------- */
test('overlapSeconds は重なり秒数を返す', () => {
  assert.equal(overlapSeconds({ start: 0, end: 2 }, { start: 1, end: 3 }), 1);
  assert.equal(overlapSeconds({ start: 0, end: 2 }, { start: 2, end: 3 }), 0);
  assert.equal(overlapSeconds({ start: 0, end: 5 }, { start: 1, end: 2 }), 1);
  assert.equal(overlapSeconds({ start: 3, end: 4 }, { start: 0, end: 2 }), 0);
  assert.equal(overlapSeconds(null, { start: 0, end: 1 }), 0);
});

/* ---------------------------------------------------------
   確率 → 話者区間
   --------------------------------------------------------- */
function probsFromLabels(labels, numSpeakers = 8, high = 0.9, low = 0.05) {
  const data = new Float32Array(labels.length * numSpeakers);
  for (let f = 0; f < labels.length; f++) {
    for (let s = 0; s < numSpeakers; s++) data[f * numSpeakers + s] = low;
    if (labels[f] >= 0) data[f * numSpeakers + labels[f]] = high;
  }
  return data;
}

// 浮動小数の境界を避けるため、テストでは 1 フレーム = 1 秒として扱う
const FRAME = { frameDuration: 1 };

test('probabilitiesToSegments は連続フレームを話者区間へ変換する', () => {
  const labels = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
  const segments = probabilitiesToSegments(probsFromLabels(labels), labels.length, 8, {
    ...FRAME,
    minDuration: 4,
    mergeGap: 0,
  });
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[0], { speaker: 0, start: 0, end: 5 });
  assert.deepEqual(segments[1], { speaker: 1, start: 5, end: 10 });
  assert.deepEqual(segments[2], { speaker: 0, start: 10, end: 15 });
});

test('probabilitiesToSegments は短い無音で分かれた同一話者を繋ぐ', () => {
  const labels = [0, 0, 0, -1, -1, 0, 0, 0];
  const segments = probabilitiesToSegments(probsFromLabels(labels), labels.length, 8, {
    ...FRAME,
    minDuration: 1,
    mergeGap: 3,
  });
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0], { speaker: 0, start: 0, end: 8 });
});

test('probabilitiesToSegments は間に別話者がいる区間を繋がない', () => {
  const labels = [0, 0, 1, 1, 0, 0];
  const segments = probabilitiesToSegments(probsFromLabels(labels), labels.length, 8, {
    ...FRAME,
    minDuration: 1,
    mergeGap: 3,
  });
  assert.equal(segments.length, 3);
  assert.deepEqual(
    segments.map((s) => s.speaker),
    [0, 1, 0],
  );
});

test('probabilitiesToSegments は minDuration 未満の区間を捨てる', () => {
  const labels = [0, 1, 1, 1, 1, 1];
  const segments = probabilitiesToSegments(probsFromLabels(labels), labels.length, 8, {
    ...FRAME,
    minDuration: 2,
  });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].speaker, 1);
});

test('probabilitiesToSegments はしきい値未満のフレームを無視する', () => {
  const data = new Float32Array(10 * 8).fill(0.2);
  const segments = probabilitiesToSegments(data, 10, 8, { threshold: 0.5, minDuration: 1 });
  assert.deepEqual(segments, []);
});

test('probabilitiesToSegments は不正な入力を拒否する', () => {
  assert.throws(() => probabilitiesToSegments(null, 1, 8), /probabilities/);
  assert.throws(() => probabilitiesToSegments(new Float32Array(8), -1, 8), /numFrames/);
  assert.throws(() => probabilitiesToSegments(new Float32Array(8), 1, 0), /numSpeakers/);
  assert.throws(() => probabilitiesToSegments(new Float32Array(4), 1, 8), /長さ/);
});

/* ---------------------------------------------------------
   ASR 区間への話者割当
   --------------------------------------------------------- */
test('assignSpeakers は最も重なる話者を割り当てる', () => {
  const asr = [
    { start: 0, end: 2, text: 'a' },
    { start: 2, end: 4, text: 'b' },
    { start: 4, end: 6, text: 'c' },
  ];
  const diar = [
    { speaker: 0, start: 0, end: 1.5 },
    { speaker: 1, start: 1.5, end: 3.5 },
    { speaker: 2, start: 3.5, end: 6 },
  ];
  const out = assignSpeakers(asr, diar);
  assert.deepEqual(
    out.map((s) => s.speaker),
    [0, 1, 2],
  );
  assert.equal(out[0].text, 'a');
});

test('assignSpeakers は重なりが無い区間を話者不明 (null) にする', () => {
  const out = assignSpeakers([{ start: 10, end: 12, text: 'x' }], [{ speaker: 0, start: 0, end: 5 }]);
  assert.equal(out[0].speaker, null);
});

test('assignSpeakers は空・不正な入力を安全に扱う', () => {
  assert.deepEqual(assignSpeakers([], []), []);
  assert.deepEqual(assignSpeakers(null, []), []);
  const out = assignSpeakers([{ start: 0, end: 1, text: 'x' }], null);
  assert.equal(out[0].speaker, null);
});

/* ---------------------------------------------------------
   タイムライン整形
   --------------------------------------------------------- */
test('formatSpeakerTranscript は連続する同一話者を 1 行にまとめる', () => {
  const text = formatSpeakerTranscript([
    { start: 0, end: 1, text: 'Hello', speaker: 0 },
    { start: 1, end: 2, text: 'world', speaker: 0 },
    { start: 2, end: 3, text: 'Hi', speaker: 1 },
  ]);
  assert.equal(text, '[0:00] 話者A: Hello world\n\n[0:02] 話者B: Hi');
});

test('formatSpeakerTranscript は話者不明を明示する', () => {
  const text = formatSpeakerTranscript([{ start: 65, end: 66, text: 'x', speaker: null }]);
  assert.equal(text, '[1:05] 話者不明: x');
});

test('formatSpeakerTranscript は空テキストを無視する', () => {
  assert.equal(formatSpeakerTranscript([{ start: 0, text: '  ', speaker: 0 }, null]), '');
  assert.equal(formatSpeakerTranscript(null), '');
});
