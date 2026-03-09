/**
 * registry.json 生成スクリプト
 * 
 * apps/ 配下の meta.json を持つディレクトリを収集し、
 * registry.json を出力する。
 * 
 * 使い方: node scripts/generate-registry.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const appsDir = path.join(root, 'apps');
const apps = [];

if (fs.existsSync(appsDir)) {
  for (const dir of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    if (fs.existsSync(path.join(appsDir, dir.name, 'meta.json'))) {
      apps.push(dir.name);
    }
  }
}

apps.sort();

const registry = {
  apps,
  generatedAt: new Date().toISOString()
};

const outPath = path.join(root, 'registry.json');
fs.writeFileSync(outPath, JSON.stringify(registry, null, 2) + '\n');
console.log(`registry.json generated: ${apps.length} apps [${apps.join(', ')}]`);
