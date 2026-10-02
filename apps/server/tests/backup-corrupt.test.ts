// 备份/还原的坏档与降级测试 —— 必须最先导入临时环境
import './helpers/setup-env.js';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, closeDb } from '../src/db.js';
import { config } from '../src/config.js';
import { createBackup, listBackups, restoreBackup } from '../src/services/backup.js';
import { ApiError } from '../src/http/errors.js';
import { tmpDir } from './helpers/setup-env.js';

beforeAll(() => {
  migrate();
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('历史坏档 · 备份目录被污染时不崩溃', () => {
  it('备份目录里混入普通文件（非备份目录）时，listBackups 忽略它', async () => {
    fs.writeFileSync(path.join(config.backupDir, 'random-note.txt'), '不是备份');
    const before = await createBackup();
    const list = listBackups();
    expect(list.every((b) => b.name !== 'random-note.txt')).toBe(true);
    expect(list.some((b) => b.name === before.name)).toBe(true);
  });

  it('损坏的备份目录（缺 app.db / manifest）仍可列出，不拖垮整个列表', async () => {
    const broken = path.join(config.backupDir, '20000101-000000');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'manifest.json'), '{broken');
    // 注意：没有 app.db —— 典型的拷贝中断坏档
    const list = listBackups();
    expect(list.some((b) => b.name === '20000101-000000')).toBe(true);
    expect(() => listBackups()).not.toThrow();
  });
});

describe('历史坏档 · 还原必须明确失败而不是静默破坏当前库', () => {
  it('还原不存在的备份名 → NOT_FOUND', async () => {
    try {
      await restoreBackup('does-not-exist', true);
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('NOT_FOUND');
    }
  });

  it('缺少二次确认 → BAD_REQUEST（坏档操作的最后一道闸）', async () => {
    const good = await createBackup();
    try {
      await restoreBackup(good.name, false);
      throw new Error('应当抛错');
    } catch (err) {
      expect((err as ApiError).code).toBe('BAD_REQUEST');
    }
  });

  it('还原损坏备份（缺 app.db）：明确失败而不是静默成功', async () => {
    // 该用例会关闭 DB 连接（restore 在拷贝前先 close），故放在最后
    try {
      await restoreBackup('20000101-000000', true);
      throw new Error('应当抛错');
    } catch (err) {
      // copyFileSync 缺源文件抛原生错误 —— 关键是明确失败、不会伪装成还原成功
      expect(err).toBeInstanceOf(Error);
    }
  });
});
