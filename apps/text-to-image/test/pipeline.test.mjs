import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MANIFEST,
  MODEL_FILE_SIZES,
  MODEL_BASE_URL,
  validateManifest,
  modelFileUrl,
  modelFilesFromManifest,
  externalDataPathCandidates,
  cacheRevision,
  hashString,
  mulberry32,
  gaussianNoise,
  shapeSize,
  createInitialLatent,
  denoiseStep,
  floatToHalf,
  float32ToFloat16Array,
  halfToFloat,
  float16ArrayToFloat32,
  tensorDataToFloat32,
  padOrTruncateTokens,
  nchwToRgba,
  resolveRoleInputs,
  resolveRoleOutput,
} from '../pipeline.mjs';

/* ---------------------------------------------------------
   乱数・ノイズ
   --------------------------------------------------------- */
test('mulberry32 は決定的で [0,1) を返す', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const values = [];
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1, `範囲外: ${v}`);
    values.push(v);
  }
  assert.ok(values.some((v) => v !== values[0]), '同じ値しか出ない');
});

test('gaussianNoise は決定的で平均0・分散1に近い', () => {
  const n = 20000;
  const data = gaussianNoise(12345, n);
  const again = gaussianNoise(12345, n);
  assert.equal(data.length, n);
  assert.deepEqual(Array.from(data.slice(0, 5)), Array.from(again.slice(0, 5)));

  let sum = 0;
  for (const v of data) sum += v;
  const mean = sum / n;
  let variance = 0;
  for (const v of data) variance += (v - mean) ** 2;
  variance /= n;

  assert.ok(Math.abs(mean) < 0.05, `平均がずれている: ${mean}`);
  assert.ok(Math.abs(variance - 1) < 0.1, `分散がずれている: ${variance}`);
  assert.ok(data.every((v) => Number.isFinite(v)));
});

test('shapeSize と createInitialLatent は initNoiseSigma を反映する', () => {
  assert.equal(shapeSize([1, 4, 64, 64]), 16384);
  const base = createInitialLatent(7, [1, 4, 64, 64], 1);
  const scaled = createInitialLatent(7, [1, 4, 64, 64], 2);
  assert.equal(base.length, 16384);
  for (let i = 0; i < base.length; i++) {
    assert.ok(Math.abs(scaled[i] - base[i] * 2) < 1e-5);
  }
});

test('denoiseStep は DEIS の係数をそのまま適用する', () => {
  const latent = Float32Array.from([1, 2, 3]);
  const pred = Float32Array.from([0.5, -1, 0]);
  const out = denoiseStep(latent, pred, 14.642590522766113, -14.579278945922852);
  for (let i = 0; i < 3; i++) {
    const expected = 14.642590522766113 * latent[i] + -14.579278945922852 * pred[i];
    assert.ok(Math.abs(out[i] - expected) < 1e-3);
  }
});

test('denoiseStep はサイズ不一致で例外を投げる', () => {
  assert.throws(() => denoiseStep(new Float32Array(2), new Float32Array(3), 1, 1), /サイズが一致/);
});

/* ---------------------------------------------------------
   float16 変換
   --------------------------------------------------------- */
test('float16 は代表値で往復できる', () => {
  const cases = [0, 1, -1, 0.5, -0.5, 0.25, 65504, -65504, 1024, 0.333251953125];
  for (const value of cases) {
    const bits = floatToHalf(value);
    const back = halfToFloat(bits);
    assert.equal(back, value, `${value} -> ${bits} -> ${back}`);
  }
});

test('float16 は無限大・NaN・アンダーフローを扱える', () => {
  assert.equal(halfToFloat(floatToHalf(Infinity)), Infinity);
  assert.equal(halfToFloat(floatToHalf(-Infinity)), -Infinity);
  assert.ok(Number.isNaN(halfToFloat(floatToHalf(NaN))));
  assert.equal(halfToFloat(floatToHalf(1e-30)), 0);
});

test('float32ToFloat16Array / float16ArrayToFloat32 は往復できる', () => {
  const input = Float32Array.from([0, 1, -2, 0.125, 100.5]);
  const half = float32ToFloat16Array(input);
  assert.ok(half instanceof Uint16Array);
  const back = float16ArrayToFloat32(half);
  for (let i = 0; i < input.length; i++) {
    assert.ok(Math.abs(back[i] - input[i]) < 1e-3, `${input[i]} -> ${back[i]}`);
  }
});

test('tensorDataToFloat32 は float32 と float16 (生ビット) を変換する', () => {
  const f32 = Float32Array.from([0.5, -0.25]);
  assert.equal(tensorDataToFloat32('float32', f32), f32);

  const bits = float32ToFloat16Array(f32);
  const decoded = tensorDataToFloat32('float16', bits);
  assert.ok(Math.abs(decoded[0] - 0.5) < 1e-3);
  assert.ok(Math.abs(decoded[1] + 0.25) < 1e-3);

  assert.throws(() => tensorDataToFloat32('int32', new Int32Array([1])), /float へ変換できない/);
});

/* ---------------------------------------------------------
   トークン
   --------------------------------------------------------- */
test('padOrTruncateTokens は bigint を数値化してパディングする', () => {
  const ids = [BigInt(49406), 100n, 200n];
  const out = padOrTruncateTokens(ids, 5, 49407);
  assert.deepEqual(Array.from(out), [49406, 100, 200, 49407, 49407]);

  const truncated = padOrTruncateTokens([1, 2, 3, 4, 5], 3, 0);
  assert.deepEqual(Array.from(truncated), [1, 2, 3]);
});

test('padOrTruncateTokens は不正な maxLength を拒否する', () => {
  assert.throws(() => padOrTruncateTokens([1], 0, 0), /maxLength/);
});

/* ---------------------------------------------------------
   画像変換
   --------------------------------------------------------- */
test('nchwToRgba は RGB を [0,1] から 8bit に写像する', () => {
  const rgba = nchwToRgba(Float32Array.from([1, 0, 0.5]), 3, 1, 1);
  assert.equal(rgba.length, 4);
  assert.equal(rgba[0], 255);
  assert.equal(rgba[1], 0);
  assert.equal(rgba[2], 128);
  assert.equal(rgba[3], 255);
});

test('nchwToRgba は 2x1 でピクセル順を守る', () => {
  // C=1, H=1, W=2 : [pixel0, pixel1]
  const rgba = nchwToRgba(Float32Array.from([0, 1]), 1, 1, 2);
  assert.deepEqual(Array.from(rgba), [0, 0, 0, 255, 255, 255, 255, 255]);
});

test('nchwToRgba はデータ不足で例外を投げる', () => {
  assert.throws(() => nchwToRgba(Float32Array.from([0]), 3, 2, 2), /画像データが不足/);
});

/* ---------------------------------------------------------
   manifest
   --------------------------------------------------------- */
test('validateManifest は既定値を埋めて返す', () => {
  const manifest = validateManifest({ width: 512, height: 512 });
  assert.equal(manifest.latentShape.length, 4);
  assert.equal(manifest.models.unet, 'unet_mixed_q4q8.onnx');
  assert.equal(manifest.scheduler.timestep, 999.0);
});

test('validateManifest は壊れた入力を拒否する', () => {
  assert.throws(() => validateManifest(null), /形式が不正/);
  assert.throws(() => validateManifest({ width: 0, height: 512 }), /width\/height/);
  assert.throws(() => validateManifest({ latentShape: [1, 4, 64] }), /latentShape/);
  assert.throws(() => validateManifest({ scheduler: { timestep: 'x' } }), /scheduler.timestep/);
});

test('modelFilesFromManifest と modelFileUrl は HF の URL を組み立てる', () => {
  const files = modelFilesFromManifest(validateManifest(DEFAULT_MANIFEST));
  assert.deepEqual(
    files.map((f) => f.name),
    ['text_encoder_q4.onnx', 'unet_mixed_q4q8.onnx', 'vae_decoder_fp16.onnx'],
  );
  assert.equal(modelFileUrl('manifest.json'), `${MODEL_BASE_URL}/manifest.json`);
  assert.equal(files[1].externalDataName, 'unet_mixed_q4q8.onnx.data');
  assert.ok(files[1].externalDataUrl.endsWith('/unet_mixed_q4q8.onnx.data'));
});

test('externalDataPathCandidates は重複なしで .data を優先する', () => {
  const candidates = externalDataPathCandidates('unet_mixed_q4q8.onnx');
  assert.equal(candidates[0], 'unet_mixed_q4q8.onnx.data');
  assert.ok(candidates.includes('./unet_mixed_q4q8.onnx.data'));
  assert.equal(new Set(candidates).size, candidates.length);
});

test('cacheRevision は manifest に対して安定し、変化に反応する', () => {
  const rev = cacheRevision(DEFAULT_MANIFEST);
  assert.equal(rev, cacheRevision({ ...DEFAULT_MANIFEST, scheduler: { ...DEFAULT_MANIFEST.scheduler } }));
  assert.match(rev, /^[0-9a-f]{8}$/);
  assert.notEqual(rev, cacheRevision({ ...DEFAULT_MANIFEST, width: 768 }));
});

test('hashString は決定的で 8 桁 hex', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.match(hashString('abc'), /^[0-9a-f]{8}$/);
  assert.notEqual(hashString('abc'), hashString('abd'));
});

test('MODEL_FILE_SIZES の合計はおおよそ 382MiB の想定内', () => {
  const total = Object.values(MODEL_FILE_SIZES).reduce((a, b) => a + b, 0);
  const mib = total / 1024 / 1024;
  assert.ok(mib > 350 && mib < 400, `合計サイズが想定外: ${mib} MiB`);
});

/* ---------------------------------------------------------
   ONNX 入出力名の解決
   --------------------------------------------------------- */
test('resolveRoleInputs は標準的な text_encoder の入力を解決する', () => {
  const resolved = resolveRoleInputs('text_encoder', ['input_ids', 'attention_mask']);
  assert.equal(resolved.input_ids, 'input_ids');
  assert.equal(resolved.attention_mask, 'attention_mask');
});

test('resolveRoleInputs は diffusers 風 U-Net の入力を解決する', () => {
  const resolved = resolveRoleInputs('unet', ['sample', 'timestep', 'encoder_hidden_states']);
  assert.equal(resolved.sample, 'sample');
  assert.equal(resolved.timestep, 'timestep');
  assert.equal(resolved.encoder_hidden_states, 'encoder_hidden_states');
});

test('resolveRoleInputs は latent 表記の decoder を解決する', () => {
  assert.equal(resolveRoleInputs('decoder', ['latent']).latent, 'latent');
  assert.equal(resolveRoleInputs('decoder', ['z']).latent, 'z');
  assert.equal(resolveRoleInputs('decoder', ['sample']).latent, 'sample');
});

test('resolveRoleInputs は見つからない役割を null にする', () => {
  const resolved = resolveRoleInputs('unet', ['sample', 'encoder_hidden_states']);
  assert.equal(resolved.timestep, null);
});

test('resolveRoleOutput は最初の一致または先頭を返す', () => {
  assert.equal(resolveRoleOutput('text_encoder', ['last_hidden_state']), 'last_hidden_state');
  assert.equal(resolveRoleOutput('unet', ['out_sample']), 'out_sample');
  assert.equal(resolveRoleOutput('decoder', ['image']), 'image');
  assert.equal(resolveRoleOutput('unet', ['weird']), 'weird');
  assert.throws(() => resolveRoleOutput('unknown', ['x']), /未知の role/);
});
