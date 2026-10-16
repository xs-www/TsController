/**
 * 清掉验证脚本产生的临时数据目录。
 *
 * 存在的理由是防止一类真实事故：验证脚本把数据写在 `<DATA_DIR>/verify*` 子目录下，
 * 而真实映射库就在 `<DATA_DIR>/mappings.json`。此前直接 `rm -rf data` 清理时，
 * 把用户的真实映射库一并删掉了。
 *
 * **只删已知的验证子目录，且逐个断言名字前缀**——不做任何通配式的递归删除。
 *
 * 用法：node scripts/clean-verify.ts
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 允许删除的目录名白名单（相对项目根）。绝不接受通配或用户输入。 */
const ALLOWED = ['data/verify', 'data/verify-security', 'data/verify-api', 'data/verify-web', 'data/smoke'];

async function main(): Promise<void> {
  const dataRoot = path.join(PROJECT_ROOT, 'data');
  let removed = 0;

  for (const rel of ALLOWED) {
    const target = path.join(PROJECT_ROOT, rel);

    // 双保险：路径必须真的落在 data/ 之下，且目录名必须以前缀 verify/smoke 开头。
    const normalized = path.resolve(target);
    if (!normalized.startsWith(path.resolve(dataRoot) + path.sep)) {
      process.stderr.write(`拒绝删除 ${normalized}：不在 data/ 目录之下\n`);
      continue;
    }
    const base = path.basename(normalized);
    if (!base.startsWith('verify') && !base.startsWith('smoke')) {
      process.stderr.write(`拒绝删除 ${normalized}：目录名不在白名单前缀内\n`);
      continue;
    }

    try {
      await fs.rm(normalized, { recursive: true, force: true });
      process.stdout.write(`  已清理 ${rel}\n`);
      removed += 1;
    } catch (err) {
      process.stderr.write(`  清理 ${rel} 失败：${(err as Error).message}\n`);
    }
  }

  // 明确提示真实映射库仍在——避免下次又有人「顺手」删整个 data/。
  const realStore = path.join(dataRoot, 'mappings.json');
  try {
    await fs.access(realStore);
    process.stdout.write(`\n真实映射库仍在：${path.relative(PROJECT_ROOT, realStore)}\n`);
  } catch {
    process.stdout.write('\n注意：未找到真实映射库 data/mappings.json。\n');
  }
  process.stdout.write(`共清理 ${removed} 个验证数据目录。\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`清理失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
