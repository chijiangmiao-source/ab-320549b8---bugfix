// 页面构建：用 esbuild 把仿真内核与页面逻辑打包到 web/dist（无框架，浏览器原生 ESM 产物）。
import { build } from 'esbuild';
import { copyFile, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'web');
const DIST = path.join(SRC, 'dist');

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

await build({
  entryPoints: [path.join(SRC, 'app.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  outfile: path.join(DIST, 'app.js'),
  logLevel: 'info',
});

await copyFile(path.join(SRC, 'styles.css'), path.join(DIST, 'styles.css'));
let html = await readFile(path.join(SRC, 'index.html'), 'utf-8');
html = html.replace('<!-- built -->', '');
await writeFile(path.join(DIST, 'index.html'), html);

console.log('[build] 页面产物已写入 web/dist');
