/**
 * model-cache.mjs — モデル資産を Cache API に保存するローダー
 *
 * 設計方針 (NanoDiffuser のモデルカードの記述に準拠):
 *   - ダウンロードはストリームで読み、進捗をコールバックに流す
 *   - Content-Length と既知サイズで切り詰めを検出し、壊れたキャッシュは捨てて再取得
 *   - 同時リクエストは同じ Promise を共有する (多重ダウンロード防止)
 *   - Cache API が無い/失敗する環境では素の fetch にフォールバックする
 *
 * Node のテストから使えるように caches / fetch は注入可能にしてある。
 */

export const CACHE_PREFIX = 'nanodiffuser-';

function defaultFetch(...args) {
  return globalThis.fetch(...args);
}

function getDefaultCaches() {
  try {
    return typeof globalThis.caches !== 'undefined' ? globalThis.caches : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.cacheName   Cache Storage のバケット名
 * @param {object} [opts.caches]    caches 実装 (既定: globalThis.caches)
 * @param {function} [opts.fetch]   fetch 実装 (既定: globalThis.fetch)
 * @param {function} [opts.onProgress] ({ url, loaded, total }) => void
 */
export function createModelStore(opts = {}) {
  const cacheName = opts.cacheName || `${CACHE_PREFIX}default`;
  const cachesImpl = opts.caches !== undefined ? opts.caches : getDefaultCaches();
  const fetchImpl = opts.fetch || defaultFetch;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  /** url -> Promise<Blob> */
  const pending = new Map();
  let cachePromise = null;

  function openCache() {
    if (!cachesImpl) return Promise.resolve(null);
    if (!cachePromise) {
      cachePromise = Promise.resolve()
        .then(() => cachesImpl.open(cacheName))
        .catch((err) => {
          console.warn('Cache API を開けませんでした。キャッシュなしで続行します:', err);
          return null;
        });
    }
    return cachePromise;
  }

  /**
   * キャッシュ済み Response が完全かどうかを判定する。
   * expectedSize が分かっていればそれと比較し、無ければ保持した blob サイズヘッダを使う。
   */
  async function cachedBlobIfValid(cache, url, expectedSize) {
    if (!cache) return null;
    let hit;
    try {
      hit = await cache.match(url);
    } catch {
      return null;
    }
    if (!hit) return null;
    let blob;
    try {
      blob = await hit.blob();
    } catch {
      return null;
    }
    const declared = Number(hit.headers.get('x-blob-size') || 0);
    const validAgainstExpected = !expectedSize || blob.size >= expectedSize;
    const validAgainstDeclared = !declared || blob.size >= declared;
    if (blob.size > 0 && validAgainstExpected && validAgainstDeclared) {
      return blob;
    }
    try {
      await cache.delete(url);
    } catch {
      /* 削除できなくても致命的ではない */
    }
    return null;
  }

  async function fetchToBlob(url, expectedSize) {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res || !res.ok) {
      throw new Error(`モデル取得に失敗しました (${res ? res.status : 'no response'}): ${url}`);
    }
    const headerTotal = Number(res.headers.get('content-length') || 0);
    const total = expectedSize || headerTotal || 0;
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;

    let blob;
    if (!reader) {
      const buf = await res.arrayBuffer();
      onProgress({ url, loaded: buf.byteLength, total: buf.byteLength });
      blob = new Blob([buf], { type: 'application/octet-stream' });
    } else {
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress({ url, loaded, total });
      }
      blob = new Blob(chunks, { type: 'application/octet-stream' });
    }

    if (expectedSize && blob.size < expectedSize) {
      throw new Error(
        `ダウンロードが途中で切れました (${blob.size} / ${expectedSize} bytes): ${url}`,
      );
    }
    return blob;
  }

  async function storeInCache(cache, url, blob) {
    if (!cache) return;
    try {
      await cache.put(
        url,
        new Response(blob, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'x-blob-size': String(blob.size),
          },
        }),
      );
    } catch (err) {
      // 容量超過・プライベートブラウズ等。保存できなくても生成自体は続行できる。
      console.warn('モデルをキャッシュに保存できませんでした:', err);
    }
  }

  return {
    cacheName,

    /**
     * URL からモデル資産を取得する。キャッシュがあればそれを返す。
     * @param {string} url
     * @param {{expectedSize?: number}} [options]
     * @returns {Promise<Blob>}
     */
    async load(url, options = {}) {
      const expectedSize = options.expectedSize || 0;
      if (pending.has(url)) return pending.get(url);

      const task = (async () => {
        const cache = await openCache();
        const cached = await cachedBlobIfValid(cache, url, expectedSize);
        if (cached) {
          onProgress({ url, loaded: cached.size, total: cached.size, cached: true });
          return cached;
        }
        const blob = await fetchToBlob(url, expectedSize);
        await storeInCache(cache, url, blob);
        return blob;
      })();

      pending.set(url, task);
      try {
        return await task;
      } finally {
        pending.delete(url);
      }
    },

    /** 指定 URL がキャッシュ済みかを返す */
    async has(url) {
      const cache = await openCache();
      if (!cache) return false;
      try {
        return Boolean(await cache.match(url));
      } catch {
        return false;
      }
    },

    /** このアプリのキャッシュを削除する */
    async clear() {
      pending.clear();
      cachePromise = null; // 次回 open() で新しいバケットを開き直す
      if (!cachesImpl) return 0;
      try {
        const deleted = await cachesImpl.delete(cacheName);
        return deleted ? 1 : 0;
      } catch {
        return 0;
      }
    },
  };
}
