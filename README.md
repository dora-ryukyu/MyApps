# MyApps Hub

個人ツール・Webアプリのコレクションハブ。  
GitHub Pages 上で動作し、各アプリは独立した静的サイトとして実装されていますが、共通のデザイントークンとヘッダーにより統一された UX を提供します。

## 🚀 特徴

- **Hub & Spoke 構成**: `index.html` (Hub) が各アプリ (`apps/*/`) を一覧表示
- **共通デザインシステム**: `shared/base.css` による一貫したモダンUI（Glassmorphism & Depth）
- **共通ヘッダー**: `shared/header.js` により、全てのアプリに Hub への戻りリンクやテーマ切替機能を自動注入
- **テーマ同期**: Hub で設定したテーマ（Light/Dark/System）が全アプリに即座に反映
- **自動デプロイ**: GitHub Actions により、アプリを追加して push するだけで `registry.json` が自動生成されデプロイ完了

## 📂 プロジェクト構造

```
MyApps/
├── index.html              # Hub トップページ
├── hub/                    # Hub 固有のリソース
├── shared/                 # 全アプリ共通リソース
│   ├── base.css            # デザイントークン（色・フォント・SP）
│   ├── header.css          # 共通ヘッダースタイル
│   └── header.js           # 共通ヘッダー注入スクリプト
├── apps/                   # 各アプリケーション
│   ├── sample-app/
│   │   ├── index.html
│   │   ├── meta.json       # アプリのメタ情報（Hub表示用）
│   │   ├── favicon.svg     # アプリ固有アイコン
│   │   └── ...
├── .github/workflows/
│   └── deploy.yml          # GitHub Pages 自動デプロイと registry.json 生成
└── registry.json           # (CI/CDで自動生成されるためリポジトリには含めない)
```

## 🛠️ ローカル開発

```bash
# 依存関係のインストール（初回のみ）
npm install

# registry.json を生成（ローカル確認用）
npm run registry

# ローカルサーバー起動
npm run dev
# -> http://localhost:8080 を開く
```

> **Note**: `registry.json` は `.gitignore` に含まれています。ローカルで生成してもコミットされません。本番環境では GitHub Actions がデプロイ時に最新の `apps/` 構造に基づいて自動生成します。

## ➕ 新しいアプリの追加

1. `apps/` 直下に新しいディレクトリを作成（例: `apps/my-new-tool/`）
2. 以下のファイルを作成:

   **`meta.json`** (Hub 表示用)

   ```json
   {
     "id": "my-new-tool",
     "name": "ツール名",
     "description": "ツールの説明文",
     "icon": "zap",
     "color": "#3b82f6",
     "tags": ["ツール", "便利"]
   }
   ```

   - `icon`: [Lucide Icons](https://lucide.dev/) の名前
   - `color`: ブランドカラー

   **`index.html`** (テンプレート)

   ```html
   <!DOCTYPE html>
   <html lang="ja" data-theme="system">
     <head>
       <!-- ... meta tags ... -->
       <link rel="icon" href="favicon.svg" type="image/svg+xml" />
       <link rel="stylesheet" href="../../shared/base.css" />
       <link rel="stylesheet" href="../../shared/header.css" />
       <!-- テーマ初期化（FOUC防止） -->
       <script>
         document.documentElement.setAttribute(
           "data-theme",
           localStorage.getItem("myapps-theme") || "system",
         );
       </script>
     </head>
     <body>
       <!-- コンテンツ -->

       <!-- 共通ヘッダー注入 -->
       <script
         src="../../shared/header.js"
         data-app-name="ツール名"
         data-app-icon="zap"
         data-app-color="#3b82f6"
       ></script>
     </body>
   </html>
   ```

3. **`favicon.svg`**: `meta.json` の `icon` と同じ Lucide アイコンの SVG を配置推奨

詳細は [DESIGN.md](./DESIGN.md) を参照してください。

## 🌍 デプロイ

`main` ブランチに push するだけで、GitHub Actions が自動的に `registry.json` を生成し、GitHub Pages にデプロイします。
（初回のみリポジトリ設定で Pages の Source を **GitHub Actions** に変更する必要があります）
