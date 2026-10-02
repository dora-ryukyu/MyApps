import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_ID,
  SAMPLE_RATE,
  DTYPE_WEBGPU,
  DTYPE_WASM,
  TASK_PROMPTS,
  TASKS,
  MODEL_VARIANTS,
  estimateModelBytes,
  formatBytes,
  buildTaskPrompt,
  isKnownTask,
  downmixChannels,
  resampleLinear,
  sliceSeconds,
  computePeaks,
  findSpeechSegments,
  formatTimestamp,
  transcriptToText,
} from '../pipeline.mjs';

/* ---------------------------------------------------------
   モデル定数 / dtype
   --------------------------------------------------------- */
test('MODEL_ID と SAMPLE_RATE は Granite Speech の想定値', () => {
  assert.equal(MODEL_ID, 'onnx-community/granite-speech-4.1-2b-ONNX');
  assert.equal(SAMPLE_RATE, 16000);
});

test('DTYPE_WEBGPU は IBM 公式デモと同じ構成', () => {
  assert.deepEqual(DTYPE_WEBGPU, {
    audio_encoder: 'q4',
    embed_tokens: 'q4f16',
    decoder_model_merged: 'q4f16',
  });
  assert.equal(DTYPE_WASM.decoder_model_merged, 'q4');
});

test('estimateModelBytes は WebGPU 構成で約 1.7GB になる', () => {
  const bytes = estimateModelBytes(DTYPE_WEBGPU);
  const gb = bytes / 1e9;
  assert.ok(gb > 1.6 && gb < 1.8, `想定外のサイズ: ${gb} GB`);
});

test('estimateModelBytes は未知の量子化を拒否する', () => {
  assert.throws(() => estimateModelBytes({ audio_encoder: 'nope' }), /未知のモデル資産/);
});

test('MODEL_VARIANTS の各ファイルは 2 種類の外部重みを持つ', () => {
  for (const module of ['audio_encoder', 'embed_tokens', 'decoder_model_merged']) {
    assert.ok(`onnx/${module}_q4.onnx` in MODEL_VARIANTS);
    assert.ok(`onnx/${module}_q4.onnx_data` in MODEL_VARIANTS);
    assert.ok(`onnx/${module}_q4f16.onnx` in MODEL_VARIANTS);
    assert.ok(`onnx/${module}_q4f16.onnx_data` in MODEL_VARIANTS);
  }
});

test('formatBytes は MiB / GiB を切り替える', () => {
  assert.equal(formatBytes(382 * 1024 * 1024), '382 MiB');
  assert.equal(formatBytes(estimateModelBytes(DTYPE_WEBGPU)), '1.6 GiB');
  assert.equal(formatBytes(-1), '-');
});

/* ---------------------------------------------------------
   タスク
   --------------------------------------------------------- */
test('TASK_PROMPTS はすべて <|audio|> を含む', () => {
  for (const [key, prompt] of Object.entries(TASK_PROMPTS)) {
    assert.ok(prompt.startsWith('<|audio|>'), `${key} にプレースホルダが無い`);
  }
});

test('buildTaskPrompt は未知のキーで文字起こしにフォールバックする', () => {
  assert.equal(buildTaskPrompt('transcribe'), TASK_PROMPTS.transcribe);
  assert.match(buildTaskPrompt('translate_ja'), /Japanese/);
  assert.equal(buildTaskPrompt('unknown-key'), TASK_PROMPTS.transcribe);
  assert.equal(buildTaskPrompt(undefined), TASK_PROMPTS.transcribe);
});

test('isKnownTask は定義済みキーだけ true', () => {
  assert.equal(isKnownTask('translate_ja'), true);
  assert.equal(isKnownTask('nope'), false);
});

test('TASKS のキーはすべて TASK_PROMPTS に存在する', () => {
  assert.ok(TASKS.length >= 3);
  for (const task of TASKS) {
    assert.ok(isKnownTask(task.key), `未知のタスクキー: ${task.key}`);
    assert.ok(task.label && task.description);
  }
  assert.ok(TASKS.some((t) => t.key === 'transcribe'));
  assert.ok(TASKS.some((t) => t.key === 'translate_ja'));
});

/* ---------------------------------------------------------
   音声の前処理
   --------------------------------------------------------- */
test('downmixChannels は複数チャンネルを平均する', () => {
  const out = downmixChannels([
    Float32Array.from([0, 2, 4]),
    Float32Array.from([2, 4, 6]),
  ]);
  assert.deepEqual(Array.from(out), [1, 3, 5]);
});

test('downmixChannels はモノラルをコピーして返す', () => {
  const src = Float32Array.from([0.5, 0.25]);
  const out = downmixChannels([src]);
  assert.deepEqual(Array.from(out), [0.5, 0.25]);
  assert.notEqual(out, src);
});

test('downmixChannels は空・長さ不一致を拒否する', () => {
  assert.throws(() => downmixChannels([]), /チャンネル/);
  assert.throws(
    () => downmixChannels([Float32Array.from([1]), Float32Array.from([1, 2])]),
    /一致しません/,
  );
});

test('resampleLinear は同一レートで内容を保持する', () => {
  const src = Float32Array.from([0, 1, 2, 3]);
  const out = resampleLinear(src, 16000, 16000);
  assert.deepEqual(Array.from(out), [0, 1, 2, 3]);
  assert.notEqual(out, src);
});

test('resampleLinear は線形補間で長さを変える', () => {
  const out = resampleLinear(Float32Array.from([0, 1]), 2, 4);
  assert.deepEqual(Array.from(out), [0, 0.5, 1, 1]);
  assert.equal(resampleLinear(new Float32Array(100), 8000, 16000).length, 200);
});

test('resampleLinear は空配列と不正レートを扱う', () => {
  assert.equal(resampleLinear(new Float32Array(0), 8000, 16000).length, 0);
  assert.throws(() => resampleLinear(new Float32Array(1), 0, 16000), /fromRate/);
  assert.throws(() => resampleLinear(new Float32Array(1), 16000, 0), /toRate/);
});

test('sliceSeconds はサンプル範囲を切り出す', () => {
  const samples = new Float32Array(16000);
  for (let i = 0; i < samples.length; i++) samples[i] = i;
  const out = sliceSeconds(samples, 16000, 0.25, 0.5);
  assert.equal(out.length, 4000);
  assert.equal(out[0], 4000);
});

test('sliceSeconds は範囲をクランプする', () => {
  const samples = new Float32Array(16000);
  const out = sliceSeconds(samples, 16000, 0.9, 2);
  assert.equal(out.length, 1600);
  assert.equal(sliceSeconds(samples, 16000, 0.5, 0.25).length, 0);
});

/* ---------------------------------------------------------
   波形
   --------------------------------------------------------- */
test('computePeaks は最大振幅で正規化する', () => {
  const peaks = computePeaks(Float32Array.from([0, 0, 1, -1]), 2);
  assert.deepEqual(Array.from(peaks), [0, 1]);
});

test('computePeaks は無音で 0 を返す', () => {
  const peaks = computePeaks(new Float32Array(100), 4);
  assert.deepEqual(Array.from(peaks), [0, 0, 0, 0]);
});

test('computePeaks は不正なバケット数を拒否する', () => {
  assert.throws(() => computePeaks(new Float32Array(4), 0), /bucketCount/);
});

/* ---------------------------------------------------------
   簡易 VAD
   --------------------------------------------------------- */
function makeAudio(sampleRate, totalMs, speechRanges, amplitude = 0.5) {
  const samples = new Float32Array(Math.round((sampleRate * totalMs) / 1000));
  for (const [startMs, endMs] of speechRanges) {
    const from = Math.round((sampleRate * startMs) / 1000);
    const to = Math.min(samples.length, Math.round((sampleRate * endMs) / 1000));
    for (let i = from; i < to; i++) samples[i] = amplitude;
  }
  return samples;
}

const VAD_OPTS = { frameMs: 20, minSpeechMs: 100, minSilenceMs: 200, padMs: 0, maxSegmentMs: 10000 };

test('findSpeechSegments は無音のみで空を返す', () => {
  const samples = makeAudio(1000, 500, []);
  assert.deepEqual(findSpeechSegments(samples, 1000, VAD_OPTS), []);
});

test('findSpeechSegments は発話区間を検出する', () => {
  const samples = makeAudio(1000, 500, [[100, 400]]);
  const segments = findSpeechSegments(samples, 1000, VAD_OPTS);
  assert.equal(segments.length, 1);
  assert.ok(Math.abs(segments[0].start - 0.1) < 1e-6, `start=${segments[0].start}`);
  assert.ok(Math.abs(segments[0].end - 0.4) < 1e-6, `end=${segments[0].end}`);
});

test('findSpeechSegments は十分な無音で区間を分割する', () => {
  const samples = makeAudio(1000, 500, [[0, 100], [300, 400]]);
  const segments = findSpeechSegments(samples, 1000, VAD_OPTS);
  assert.equal(segments.length, 2);
  assert.ok(segments[0].end <= 0.11);
  assert.ok(segments[1].start >= 0.29);
});

test('findSpeechSegments は短すぎる発話を捨てる', () => {
  const samples = makeAudio(1000, 500, [[0, 60]]);
  assert.deepEqual(findSpeechSegments(samples, 1000, VAD_OPTS), []);
});

test('findSpeechSegments はパディングを前後に付ける', () => {
  const samples = makeAudio(1000, 500, [[100, 400]]);
  const segments = findSpeechSegments(samples, 1000, { ...VAD_OPTS, padMs: 50 });
  assert.ok(Math.abs(segments[0].start - 0.05) < 1e-6, `start=${segments[0].start}`);
  assert.ok(Math.abs(segments[0].end - 0.45) < 1e-6, `end=${segments[0].end}`);
});

test('findSpeechSegments は長い発話を maxSegmentMs で分割する', () => {
  const samples = makeAudio(1000, 1000, [[0, 1000]]);
  const segments = findSpeechSegments(samples, 1000, { ...VAD_OPTS, maxSegmentMs: 400 });
  assert.equal(segments.length, 3);
  assert.ok(segments[0].end <= 0.4 + 1e-6);
  assert.ok(segments[2].end <= 1.0 + 1e-6);
});

test('findSpeechSegments は不正な入力を拒否する', () => {
  assert.throws(() => findSpeechSegments(new Float32Array(1), 0), /sampleRate/);
  assert.throws(() => findSpeechSegments(null, 16000), /samples/);
});

/* ---------------------------------------------------------
   表示ヘルパー
   --------------------------------------------------------- */
test('formatTimestamp は m:ss / h:mm:ss を返す', () => {
  assert.equal(formatTimestamp(0), '0:00');
  assert.equal(formatTimestamp(5), '0:05');
  assert.equal(formatTimestamp(65), '1:05');
  assert.equal(formatTimestamp(3599), '59:59');
  assert.equal(formatTimestamp(3600), '1:00:00');
  assert.equal(formatTimestamp(3661), '1:01:01');
  assert.equal(formatTimestamp(NaN), '0:00');
  assert.equal(formatTimestamp(-5), '0:00');
});

test('transcriptToText はタイムスタンプ付きで連結する', () => {
  const text = transcriptToText([
    { start: 0, text: 'Hello' },
    { start: 65, text: 'World' },
  ]);
  assert.equal(text, '[0:00] Hello\n\n[1:05] World');
});

test('transcriptToText は空テキストを無視する', () => {
  assert.equal(transcriptToText([{ start: 0, text: '  ' }, null]), '');
  assert.equal(transcriptToText(null), '');
});
