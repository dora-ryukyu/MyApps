# MyApps

個人ツール・Web アプリのコレクション。GitHub Pages でホスティング。

## 構造

```
MyApps/
├── index.html          # Hub ページ（アプリ一覧）
├── shared/base.css     # 共通デザイントークン
├── DESIGN.md           # デザイン定義書（LLM 向け）
├── apps/               # 各アプリ
│   └── {app-id}/
│       ├── index.html
│       ├── meta.json   # Hub に表示するメタ情報
│       └── ...
└── registry.json       # アプリ一覧（GitHub Actions で自動生成）
```

## アプリの追加方法

1. `apps/{app-id}/` ディレクトリを作成
2. `meta.json` を作成（[仕様は DESIGN.md 参照](DESIGN.md)）
3. `index.html` で `shared/base.css` を読み込む
4. push すると GitHub Actions が `registry.json` を自動更新

## ローカル開発

```bash
npx -y http-server . -p 8080 -c-1
# → http://localhost:8080
```

## デザインガイドライン

[DESIGN.md](DESIGN.md) を参照。LLM でのコード生成時に読み込ませることで、各アプリ間の UI 一貫性を保てます。

## ライセンス

Private
