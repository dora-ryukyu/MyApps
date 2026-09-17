import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelStore, CACHE_PREFIX } from '../model-cache.mjs';

/* ---------------------------------------------------------
   テスト用の偽 Cache Storage / fetch
   --------------------------------------------------------- */
function createFakeCaches() {
  const buckets = new Map();
  return {
    buckets,
    async open(name) {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const store = buckets.get(name);
      return {
        async match(url) {
          return store.get(url);
        },
        async put(url, response) {
          store.set(url, response);
        },
        async delete(url) {
          return store.delete(url);
        },
      };
    },
    async delete(name) {
      return buckets.delete(name);
    },
  };
}

function makeFetcher(bytes, { chunkSize = 4 } = {}) {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    let offset = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-length': String(bytes.length) },
    });
  };
  return {
    fetchImpl,
    get calls() {
      return calls;
    },
  };
}

const URL_A = 'https://example.test/model.onnx';
const BYTES = Uint8Array.from({ length: 32 }, (_, i) => i);

async function readBlob(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/* ---------------------------------------------------------
   テスト
   --------------------------------------------------------- */
test('load はストリームを結合して Blob を返し、進捗を報告する', async () => {
  const caches = createFakeCaches();
  const fetcher = makeFetcher(BYTES, { chunkSize: 5 });
  const progress = [];
  const store = createModelStore({
    cacheName: `${CACHE_PREFIX}test`,
    caches,
    fetch: fetcher.fetchImpl,
    onProgress: (p) => progress.push(p),
  });

  const blob = await store.load(URL_A, { expectedSize: BYTES.length });
  assert.deepEqual(Array.from(await readBlob(blob)), Array.from(BYTES));
  assert.equal(fetcher.calls, 1);

  const nonCached = progress.filter((p) => !p.cached);
  assert.ok(nonCached.length >= 1);
  assert.equal(nonCached[0].total, BYTES.length);
  assert.ok(nonCached[nonCached.length - 1].loaded === BYTES.length);
});

test('2 回目の load はキャッシュから返し fetch しない', async () => {
  const caches = createFakeCaches();
  const fetcher = makeFetcher(BYTES);
  const progress = [];
  const store = createModelStore({
    cacheName: `${CACHE_PREFIX}test`,
    caches,
    fetch: fetcher.fetchImpl,
    onProgress: (p) => progress.push(p),
  });

  await store.load(URL_A, { expectedSize: BYTES.length });
  const second = await store.load(URL_A, { expectedSize: BYTES.length });

  assert.equal(fetcher.calls, 1, 'キャッシュがあるのに再取得している');
  assert.deepEqual(Array.from(await readBlob(second)), Array.from(BYTES));
  assert.ok(progress.some((p) => p.cached === true));
});

test('同時 load は同じダウンロードを共有する', async () => {
  const caches = createFakeCaches();
  const fetcher = makeFetcher(BYTES);
  const store = createModelStore({
    cacheName: `${CACHE_PREFIX}test`,
    caches,
    fetch: fetcher.fetchImpl,
  });

  const [a, b] = await Promise.all([store.load(URL_A), store.load(URL_A)]);
  assert.equal(fetcher.calls, 1);
  assert.deepEqual(Array.from(await readBlob(a)), Array.from(await readBlob(b)));
});

test('期待サイズより小さいダウンロードは切り詰めとして例外になる', async () => {
  const caches = createFakeCaches();
  const fetcher = makeFetcher(BYTES);
  const store = createModelStore({
    cacheName: `${CACHE_PREFIX}test`,
    caches,
    fetch: fetcher.fetchImpl,
  });

  await assert.rejects(
    () => store.load(URL_A, { expectedSize: BYTES.length + 100 }),
    /途中で切れました/,
  );
});

test('壊れたキャッシュは捨てて再取得する', async () => {
  const caches = createFakeCaches();
  const fetcher = makeFetcher(BYTES);
  const store = createModelStore({
    cacheName: `${CACHE_PREFIX}test`,
    caches,
    fetch: fetcher.fetchImpl,
  });

  // 不完全なキャッシュを先に仕込む
  const cache = await caches.open(`${CACHE_PREFIX}test`);
  await cache.put(
    URL_A,
    new Response(Uint8Array.from([1, 2, 3]), { headers: { 'x-blob-size': '3' } }),
  );

  const blob = await store.load(URL_A, { expectedSize: BYTES.length });
  assert.equal(fetcher.calls, 1, '壊れたキャッシュを使い続けている');
  assert.deepEqual(Array.from(await readBlob(blob)), Array.from(BYTES));
});

test('Cache API が無くても fetch にフォールバックして動作する', async () => {
  const fetcher = makeFetcher(BYTES);
  const store = createModelStore({
    cacheName: `${CACHE_PREFIX}test`,
    caches: null,
    fetch: fetcher.fetchImpl,
  });

  await store.load(URL_A);
  await store.load(URL_A);
  assert.equal(fetcher.calls, 2, 'キャッシュ無しでは毎回取得する');
});

test('has() はキャッシュの有無を返す', async () => {
  const caches = createFakeCaches();
  const fetcher = makeFetcher(BYTES);
  const store = createModelStore({
    cacheName: `${CACHE_PREFIX}test`,
    caches,
    fetch: fetcher.fetchImpl,
  });

  assert.equal(await store.has(URL_A), false);
  await store.load(URL_A);
  assert.equal(await store.has(URL_A), true);
});

test('clear() はバケットを削除し、次回は再取得する', async () => {
  const caches = createFakeCaches();
  const fetcher = makeFetcher(BYTES);
  const store = createModelStore({
    cacheName: `${CACHE_PREFIX}test`,
    caches,
    fetch: fetcher.fetchImpl,
  });

  await store.load(URL_A);
  assert.equal(await store.clear(), 1);
  await store.load(URL_A);
  assert.equal(fetcher.calls, 2);
});

test('HTTP エラーは例外になる', async () => {
  const caches = createFakeCaches();
  const store = createModelStore({
    cacheName: `${CACHE_PREFIX}test`,
    caches,
    fetch: async () => new Response('not found', { status: 404 }),
  });
  await assert.rejects(() => store.load(URL_A), /モデル取得に失敗/);
});
