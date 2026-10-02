import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 服务层 / 路由层测试共用的临时环境。
 *
 * 必须在任何 src/* 模块被静态导入之前设置环境变量（config.ts 在首次导入时求值并缓存）。
 * 使用方式：测试文件顶部 `import './helpers/setup-env.js';`（vitest 按导入顺序先执行它）。
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-matrix-'));
process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
process.env.SHARE_DIR = path.join(tmpDir, 'share');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
process.env.JWT_SECRET = 'test-secret';
process.env.WEATHER_PROVIDER = 'fixture';
process.env.ENABLE_CLIMATE_BASELINE = 'false';
process.env.LOG_SILENT = 'true';

export { tmpDir };
