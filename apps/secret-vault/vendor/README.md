# vendor/age.js

このディレクトリの `age.js` は、暗号化ボルトが使用する age 実装を
オフラインで動かすために同梱したバンドルです。

- パッケージ: `age-encryption` v0.3.1
- ライセンス: **BSD-3-Clause**
- 上流: https://github.com/FiloSottile/typage
- 作者: Filippo Valsorda

## 生成方法

`package.json` の devDependency に固定した版から、次のコマンドで再現できます。

```bash
npm install
npx esbuild node_modules/age-encryption/dist/index.js \
  --bundle --minify --target=es2022 --format=iife --global-name=age \
  --legal-comments=inline --outfile=apps/crypto-vault/vendor/age.js
```

`window.age` として `Encrypter` / `Decrypter` / `armor` / `generateIdentity` などを公開します。
外部 CDN には依存せず、このファイルだけで動作します。

## 更新するとき

1. `package.json` の `age-encryption` の版を上げる
2. 上のコマンドで `age.js` を再生成する
3. `apps/crypto-vault/pipeline.mjs` の `AGE_LIB_VERSION` を合わせる
4. `npm test` を実行する
