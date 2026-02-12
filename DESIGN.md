# MyApps デザイン定義書

> **対象読者**: このプロジェクトのコードを生成する LLM（AI アシスタント）
> **目的**: 各アプリ間の UI 一貫性を保つためのデザインガイドライン

---

## 概要

MyApps は個人ツール・Web アプリのコレクションで、GitHub Pages 上にデプロイされる静的サイトです。
Hub ページ（`index.html`）から各アプリ（`apps/{id}/`）へ遷移します。

すべてのアプリは独立しつつも、**共通トークン（`shared/base.css`）を読み込む**ことで視覚的な一貫性を保ちます。

---

## デザイン哲学: Modern Glass & Depth

**キーワード**: モダン、グラスモーフィズム、深度、立体感、プロフェッショナル

- コンテンツが主役。装飾はコンテンツを引き立てる手段
- フラットではなく「奥行きのある空間」を意識する
- 背景には微細なグラデーションメッシュで空気感を出す
- インタラクティブ要素には明確なフィードバック（ホバー、フォーカス、アクティブ）

---

## 共通トークン (`shared/base.css`)

各アプリは以下を HTML `<head>` に追加する:

```html
<link rel="stylesheet" href="../../shared/base.css" />
```

### トークンの使い方

`shared/base.css` は **CSS カスタムプロパティ（変数）のみ** を提供する。
各アプリはこれを自由に参照・オーバーライドできる。

```css
/* 基本的な使い方 — トークンを参照 */
.my-element {
  color: var(--c-text);
  background: var(--c-surface-solid);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  transition: all var(--duration) var(--ease-default);
}

/* アプリ固有の色にオーバーライドも可 */
:root {
  --c-accent: #e11d48; /* このアプリだけローズ色に */
}
```

---

## カラーパレット

### Light Mode

| 変数                | 値                      | 用途                                |
| ------------------- | ----------------------- | ----------------------------------- |
| `--c-bg`            | `#f5f7fa`               | ページ背景                          |
| `--c-surface-solid` | `#ffffff`               | カード・パネル                      |
| `--c-text`          | `#1e293b`               | 本文テキスト (コントラスト比 12:1+) |
| `--c-text-2`        | `#475569`               | 補助テキスト (7:1+)                 |
| `--c-text-3`        | `#94a3b8`               | ヒント・ラベル (3:1+)               |
| `--c-accent`        | `#3b82f6`               | アクセントカラー                    |
| `--c-border`        | `rgba(226,232,240,0.8)` | ボーダー                            |

### Dark Mode

`[data-theme="dark"]` または `[data-theme="system"]` + `prefers-color-scheme: dark` で自動切替。

| 変数                | 値        | 用途             |
| ------------------- | --------- | ---------------- |
| `--c-bg`            | `#0f1115` | ページ背景       |
| `--c-surface-solid` | `#19191d` | カード・パネル   |
| `--c-text`          | `#f1f5f9` | 本文テキスト     |
| `--c-accent`        | `#60a5fa` | アクセントカラー |

---

## タイポグラフィ

| 項目       | 値                         |
| ---------- | -------------------------- |
| フォント   | `DM Sans` + `Noto Sans JP` |
| 本文サイズ | `15px` (`--text-base`)     |
| 行間       | `1.6` (`--leading`)        |
| 見出し行間 | `1.3` (`--leading-tight`)  |

- **見出し**: `font-weight: 700`, `letter-spacing: -0.01em`
- **本文**: `font-weight: 400`
- **ラベル・キャプション**: `--text-sm` (13px), `font-weight: 500`

---

## スペーシング

4px ベースのスケール (`--sp-1` 〜 `--sp-16`):

```
4 → 8 → 12 → 16 → 20 → 24 → 32 → 40 → 48 → 64
```

- セクション間: `--sp-8` (32px) 以上
- 要素間: `--sp-3` (12px) 〜 `--sp-4` (16px)
- 内部パディング: `--sp-4` (16px) 〜 `--sp-6` (24px)

---

## コンポーネントパターン

以下は **コード規定ではなく方針** です。各アプリは状況に応じて調整してよい。

### ボタン

```css
.btn {
  padding: var(--sp-3) var(--sp-5);
  font-family: var(--font);
  font-weight: 600;
  border-radius: var(--r);
  cursor: pointer;
  transition: all var(--duration) var(--ease-default);
}
.btn:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 2px;
}
```

### カード

```css
.card {
  background: var(--c-surface-solid);
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow);
  padding: var(--sp-5);
  transition: all var(--duration-slow) var(--ease-default);
}
.card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-2px);
}
```

### 入力フィールド

```css
input,
textarea,
select {
  font-family: var(--font);
  font-size: var(--text-base);
  color: var(--c-text);
  background: var(--c-surface-solid);
  border: 1px solid var(--c-border);
  border-radius: var(--r);
  padding: var(--sp-3) var(--sp-4);
  outline: none;
  transition:
    border-color var(--duration-fast),
    box-shadow var(--duration-fast);
}
input:focus-visible,
textarea:focus-visible,
select:focus-visible {
  border-color: var(--c-accent);
  box-shadow: 0 0 0 3px var(--c-accent-soft);
}
```

---

## テーマ切替

### 仕組み

`<html>` 要素の `data-theme` 属性で管理:

- `data-theme="system"` — OS設定に追従（デフォルト）
- `data-theme="light"` — 常にライト
- `data-theme="dark"` — 常にダーク

### 各アプリの `<head>` テンプレート（必須）

```html
<link rel="icon" href="favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="../../shared/base.css" />
<script>
  document.documentElement.setAttribute(
    "data-theme",
    localStorage.getItem("myapps-theme") || "system",
  );
</script>
```

- **favicon**: アプリ固有の SVG favicon（`meta.json` の `icon` + `color` に対応する Lucide アイコンを同ディレクトリに `favicon.svg` として配置）
- **base.css**: 共通デザイントークンを読み込み
- **テーマ初期化**: Hub で選択したテーマを `localStorage` から読み取り適用（FOUC 防止のため CSS 直後に配置）

### 実装パターン

```javascript
// テーマ読み込み
const saved = localStorage.getItem("myapps-theme") || "system";
document.documentElement.setAttribute("data-theme", saved);

// テーマ切替
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const isDark =
    cur === "dark" ||
    (cur === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = isDark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("myapps-theme", next);
}
```

---

## 共通ナビゲーション要素

### ハブへ戻るリンク

各アプリのヘッダーに以下のパターンで「戻る」リンクを設置することを推奨:

```html
<a href="../../" class="back-to-hub" aria-label="ハブに戻る">
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="m15 18-6-6 6-6" />
  </svg>
  MyApps
</a>
```

---

## Do / Don't

### ✅ Do

- `shared/base.css` を読み込む
- CSS 変数（`var(--c-*)`）でテーマ対応する
- `focus-visible` で全インタラクティブ要素にフォーカス表示を付ける
- 装飾 SVG に `aria-hidden="true"` を付ける
- `cursor: pointer` をクリック可能要素に付ける
- `prefers-reduced-motion` を尊重する
- ライト・ダーク両方で見た目を確認する

### ❌ Don't

- **Inter / Roboto / Arial をフォントに使わない**（DM Sans + Noto Sans JP を使う）
- **紫グラデーション一色のデザインにしない**（AIっぽく見える）
- **全要素を中央揃えにしない**
- **過度に均一な角丸にしない**（要素の役割に応じて `--r-sm` 〜 `--r-xl` を使い分ける）
- **emoji をアイコンとして使わない**（SVG アイコンを使う。Lucide Icons 推奨）
- **`transition: all` を安易に使わない**（変化するプロパティのみ指定推奨）
- **base.css のトークン定義を直接編集しない**（オーバーライドで対応）

---

## ディレクトリ構造

```
MyApps/
├── index.html                  # Hub ページ
├── hub/
│   ├── style.css               # Hub 固有スタイル
│   └── script.js
├── shared/
│   └── base.css                # ← 全アプリ共通トークン
├── apps/
│   ├── my-app/
│   │   ├── index.html          # base.css を読み込む
│   │   ├── favicon.svg         # アプリ固有 favicon
│   │   ├── style.css           # アプリ固有スタイル
│   │   ├── script.js
│   │   └── meta.json           # Hub に表示するメタ情報
│   └── ...
├── registry.json
├── DESIGN.md                   # ← この文書
└── .github/workflows/
    └── generate-registry.yml
```

---

## meta.json 仕様

各アプリの `meta.json`:

```json
{
  "id": "app-id",
  "name": "アプリ名",
  "description": "短い説明文",
  "icon": "lucide-icon-name",
  "color": "#hex-color",
  "tags": ["タグ1", "タグ2"]
}
```

| フィールド    | 必須 | 説明                                      |
| ------------- | ---- | ----------------------------------------- |
| `id`          | ✅   | ディレクトリ名と一致                      |
| `name`        | ✅   | Hub での表示名                            |
| `description` | ✅   | 1〜2行の説明                              |
| `icon`        | ❌   | Lucide Icons 名（未指定時 `zap`）         |
| `color`       | ❌   | テーマカラー HEX（未指定時 `--c-accent`） |
| `tags`        | ❌   | フィルタ用タグ配列                        |
