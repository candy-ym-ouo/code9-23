/**
 * L3 断网降级专用环境：WEATHER_PROVIDER=off。
 * 必须最先导入 —— config 在首次导入时读取并缓存环境变量。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-offline-'));
process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
process.env.SHARE_DIR = path.join(tmpDir, 'share');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
process.env.JWT_SECRET = 'offline-secret';
process.env.WEATHER_PROVIDER = 'off'; // ← 断网：纯天文降级模式
process.env.ENABLE_CLIMATE_BASELINE = 'false';
process.env.LOG_SILENT = 'true';

export { tmpDir };
