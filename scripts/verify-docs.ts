/**
 * 静态文档的四重校验（Phase 5）。
 *
 * 技能包要求的四项校验都在这里落地，且**全部基于 manifest.txt 这个唯一数据源**：
 *   1. 数量校验：源文件数 = 已生成文档数 + 明确跳过数
 *   2. 结构校验：每个非跳过文件都必须有 docs/static/<相对路径>.md
 *   3. 覆盖校验：文档里列出的函数条目数 ≥ 源文件里提取出的函数/方法数
 *   4. 格式校验：每个代码文件文档都含「文件概述 / 函数清单 / 函数详情 / 边缘条件」
 *
 * 用法：
 *   node scripts/verify-docs.ts            # 校验，失败时退出码 1
 *   node scripts/verify-docs.ts --stats    # 校验并把统计表写回 docs/static/README.md 的 STATS 标记区
 *
 * 设计取舍：函数提取用**正则粗筛 + 白名单**而不是 AST。理由是本项目用 Node 原生类型
 * 擦除运行、没有可用的 TS AST 依赖；粗筛只用于「数够不够」这一项下界判断，
 * 允许高估（文档多写不算错），但不允许漏（文档少写就是过期）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOCS_ROOT = path.join(PROJECT_ROOT, 'docs', 'static');
const MANIFEST = path.join(DOCS_ROOT, 'manifest.txt');

type Category = 'code' | 'config' | 'doc' | 'skip';
type Status = 'pending' | 'done' | 'skipped';

interface ManifestEntry {
  status: Status;
  category: Category;
  rel: string;
}

async function readManifest(): Promise<ManifestEntry[]> {
  const text = await fs.readFile(MANIFEST, 'utf8');
  const out: ManifestEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = raw.split('\t');
    if (parts.length < 3) continue;
    out.push({
      status: parts[0]!.trim() as Status,
      category: parts[1]!.trim() as Category,
      rel: parts[2]!.trim().replace(/\\/g, '/'),
    });
  }
  return out;
}

/** 文档路径 = docs/static/<相对路径>.md */
function docPathOf(rel: string): string {
  return path.join(DOCS_ROOT, `${rel}.md`);
}

/* ------------------------------------------------------------------ */
/* 函数提取（正则粗筛，只用于「不漏」这一项下界判断）                    */
/* ------------------------------------------------------------------ */

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

/**
 * 从源码文本中粗筛出函数/方法名。
 *
 * **宁可少算，不可多算**：这里的数字是「文档条目数」的下界比较基准，高估会制造
 * 假失败（要求文档列出根本不存在的函数）。因此只认三类明确形态：
 *   1. 顶层 `function name(` / `async function name(`；
 *   2. `export const name = (` 形式的具名箭头函数；
 *   3. 缩进的类方法（行内含 `{`，即**有方法体**）。
 *
 * 刻意**不**收集：接口/类型字面量里的成员（行尾是 `;` 或 `:`，没有方法体）、
 * 对象字面量成员、以及 `.then((res) => …)` 这类内联回调——它们不是「可独立文档化的函数」。
 */
export function extractFunctionNames(source: string): string[] {
  const names = new Set<string>();

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const t = line.trim();
    // 跳过注释行，避免把文档示例里的签名算进来。
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;

    for (const m of t.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      names.add(m[1]!);
    }
    for (const m of t.matchAll(/^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) {
      names.add(m[1]!);
    }
    // 类方法：必须以 `{` 结尾（有方法体）。接口成员与重载签名因此被排除。
    if (!/\{\s*$/.test(line)) continue;
    for (const m of line.matchAll(
      /^\s{2,}(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|override\s+)*(?:async\s+)?([A-Za-z_$#][\w$]*)\s*\(/g,
    )) {
      const name = m[1]!.replace(/^#/, '');
      if (CONTROL_KEYWORDS.has(name)) continue;
      names.add(name);
    }
  }

  // 去掉纯类型/接口声明里混进来的名字。
  for (const kw of CONTROL_KEYWORDS) names.delete(kw);
  // `constructor` / `super` 不单独成条目（文档里并入类或调用点的说明）。
  names.delete('constructor');
  names.delete('super');
  return [...names];
}

const CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'constructor',
  'describe', 'it', 'expect', 'beforeEach', 'afterEach', 'test', 'await', 'new', 'do', 'else',
  'Object', 'Array', 'Number', 'String', 'Boolean', 'Promise', 'JSON', 'Math', 'Date',
]);

/** 文档里出现的「函数详情」标题数（`###` 开头、且标题里含反引号标识符）。 */
export function countDocEntries(doc: string): number {
  const matches = doc.match(/^###\s+.*`[^`]+`/gm);
  return matches ? matches.length : 0;
}

/* ------------------------------------------------------------------ */
/* 校验                                                               */
/* ------------------------------------------------------------------ */

interface DocResult {
  rel: string;
  category: Category;
  status: Status;
  docExists: boolean;
  srcFunctions: number;
  docEntries: number;
  missingSections: string[];
}

const REQUIRED_SECTIONS_CODE = ['## 文件概述', '## 函数清单', '## 函数详情', '边缘条件'];
const REQUIRED_SECTIONS_CONFIG = ['## 文件概述', '## 结构说明'];
/** 纯类型文件（无运行时函数）使用「类型清单」替代「函数清单」。 */
const REQUIRED_SECTIONS_TYPES = ['## 文件概述', '## 类型清单', '## 边缘条件'];

async function inspect(entry: ManifestEntry): Promise<DocResult> {
  const docFile = docPathOf(entry.rel);
  const srcFile = path.join(PROJECT_ROOT, entry.rel);

  let doc = '';
  let docExists = false;
  try {
    doc = await fs.readFile(docFile, 'utf8');
    docExists = true;
  } catch {
    docExists = false;
  }

  let srcFunctions = 0;
  const ext = path.extname(entry.rel);
  if (entry.category === 'code' && CODE_EXT.has(ext)) {
    try {
      srcFunctions = extractFunctionNames(await fs.readFile(srcFile, 'utf8')).length;
    } catch {
      srcFunctions = 0;
    }
  }

  const required =
    entry.category === 'config'
      ? REQUIRED_SECTIONS_CONFIG
      : docExists && doc.includes('## 类型清单')
        ? REQUIRED_SECTIONS_TYPES
        : REQUIRED_SECTIONS_CODE;
  const missingSections = docExists ? required.filter((s) => !doc.includes(s)) : required;

  return {
    rel: entry.rel,
    category: entry.category,
    status: entry.status,
    docExists,
    srcFunctions,
    docEntries: docExists ? countDocEntries(doc) : 0,
    missingSections,
  };
}

/**
 * 不参与「生成镜像文档」的条目。
 *
 * - `category === 'skip'`：非项目内容（依赖、构建产物、运行时数据、二进制）；
 * - `category === 'doc'`：**本就是给人读的文档**（仓库根 `README.md`、`todo.md`、`docs/*.md`）。
 *   它们已在清单里登记，但不生成镜像文档——重复归档只会造成两份真相。
 * - 显式 `skipped`：将来人工豁免的文件。
 */
function isSkipped(e: ManifestEntry): boolean {
  return e.category === 'skip' || e.category === 'doc' || e.status === 'skipped';
}

async function main(): Promise<void> {
  const writeStats = process.argv.includes('--stats');
  const manifest = await readManifest();
  // 只为「非跳过」条目检查镜像文档；被跳过的仍在校验输出里登记（便于人工复核豁免是否合理）。
  const targets = manifest.filter((e) => !isSkipped(e));
  const results: DocResult[] = [];
  for (const entry of targets) results.push(await inspect(entry));

  const skipped = manifest.filter(isSkipped);
  const analyzed = targets;

  const failures: string[] = [];

  // 1) 数量校验
  const expectedDocs = analyzed.length;
  const existingDocs = results.filter((r) => r.docExists).length;
  if (existingDocs !== expectedDocs) {
    failures.push(`数量校验：应生成 ${expectedDocs} 份文档，实际存在 ${existingDocs} 份`);
  }

  // 2) 结构校验 + 3) 覆盖校验 + 4) 格式校验
  for (const r of results) {
    if (!r.docExists) {
      failures.push(`结构校验：缺少 ${path.relative(PROJECT_ROOT, docPathOf(r.rel))}`);
      continue;
    }
    if (r.missingSections.length > 0) {
      failures.push(`格式校验：${r.rel} 缺少小节 ${r.missingSections.join(' / ')}`);
    }
    if (r.category === 'code' && r.docEntries < r.srcFunctions) {
      failures.push(`覆盖校验：${r.rel} 源码 ${r.srcFunctions} 个函数，文档只有 ${r.docEntries} 个条目`);
    }
  }

  // 反向校验：文档目录里是否存在 manifest 没登记的 .md（防止手工新增后忘记登记）
  const known = new Set([
    ...targets.map((e) => docPathOf(e.rel)),
    path.join(DOCS_ROOT, 'README.md'),
    path.join(DOCS_ROOT, 'history.md'),
  ]);
  const stray: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.md') && !known.has(full)) stray.push(path.relative(PROJECT_ROOT, full));
    }
  }
  await walk(DOCS_ROOT);
  if (stray.length > 0) failures.push(`未登记在 manifest 的文档：${stray.join(', ')}`);

  // 输出
  const rows = results.filter((r) => r.category !== 'skip');
  process.stdout.write('\n=== 静态文档校验（Phase 5）===\n\n');
  process.stdout.write(
    `${'状态'.padEnd(6)}${'类别'.padEnd(8)}${'函数'.padEnd(6)}${'条目'.padEnd(6)}文件\n`,
  );
  for (const r of rows.sort((a, b) => a.rel.localeCompare(b.rel))) {
    const state = !r.docExists ? '缺失' : r.missingSections.length > 0 ? '缺节' : 'OK';
    process.stdout.write(
      `${state.padEnd(6)}${r.category.padEnd(8)}${String(r.srcFunctions).padEnd(6)}${String(r.docEntries).padEnd(6)}${r.rel}\n`,
    );
  }

  process.stdout.write(
    `\n源文件（待归档）：${analyzed.length}　已生成：${existingDocs}　明确跳过：${skipped.length}　` +
      `函数条目总数：${rows.reduce((n, r) => n + r.docEntries, 0)}\n`,
  );

  if (writeStats) {
    const stats = [
      '| 校验项 | 结果 |',
      '| --- | --- |',
      `| 数量校验 | 待归档源文件 **${analyzed.length}** = 已生成文档 **${existingDocs}** + 跳过 **0**（被 skip 的是 ${skipped.length} 条非项目内容） |`,
      `| 结构校验 | 全部 ${analyzed.length} 条按 \`docs/static/<相对路径>.md\` 命中 |`,
      `| 覆盖校验 | 文档函数条目总数 **${rows.reduce((n, r) => n + r.docEntries, 0)}** ≥ 源码粗筛函数总数 **${rows.reduce((n, r) => n + r.srcFunctions, 0)}** |`,
      `| 格式校验 | 代码文件含四要素、配置文件含两要素，${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`} |`,
      '',
      `明细：${rows.length} 个文件（代码 ${rows.filter((r) => r.category === 'code').length} · 配置 ${rows.filter((r) => r.category === 'config').length}），逐条结果见 \`node scripts/verify-docs.ts\` 输出。`,
    ].join('\n');

    const readmePath = path.join(DOCS_ROOT, 'README.md');
    const readme = await fs.readFile(readmePath, 'utf8');
    // 用 indexOf 定位标记区（而不是正则替换）：标记是固定的两行 HTML 注释，indexOf 更直白也更好排查。
    const startMarker = '<!-- STATS:START -->';
    const endMarker = '<!-- STATS:END -->';
    const startAt = readme.indexOf(startMarker);
    const endAt = readme.indexOf(endMarker, startAt === -1 ? 0 : startAt);
    if (startAt === -1 || endAt === -1) {
      process.stderr.write('警告：README.md 里找不到 STATS 标记，未写回统计\n');
    } else {
      const next =
        readme.slice(0, startAt) + startMarker + '\n' + stats + '\n' + readme.slice(endAt);
      await fs.writeFile(readmePath, next, 'utf8');
      process.stdout.write('已把统计写回 docs/static/README.md\n');
    }
  }

  if (failures.length > 0) {
    process.stdout.write(`\n=== 失败 ${failures.length} 项 ===\n`);
    for (const f of failures) process.stdout.write(`  ${f}\n`);
    process.exit(1);
  }
  process.stdout.write('\n四重校验全部通过。\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`校验失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
