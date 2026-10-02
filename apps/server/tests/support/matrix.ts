/**
 * 分层测试矩阵共享工具：
 *
 * - mulberry32：确定性伪随机（种子固定 → 同一条用例的全部随机回放结果逐次一致）。
 * - setupHarness：给每个 L2/L3 测试文件独立的临时 SQLite 与图片目录，
 *   动态导入 src 模块，避免 config 提前读到默认 DATABASE_URL。
 * - fingerprint：把结构化判定结果压成稳定字符串，供「跑两遍逐字节相同」断言。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

/** 固定种子的 32 位 PRNG（mulberry32）——随机回放必须可复现，禁止直接 Math.random。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next(): number;
  int(minInclusive: number, maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  range(min: number, max: number, digits?: number): number;
}

export function rng(seed: number): Rng {
  const gen = mulberry32(seed);
  return {
    next: gen,
    int: (min, max) => min + Math.floor(gen() * (max - min)),
    pick: (items) => items[Math.floor(gen() * items.length)],
    range: (min, max, digits = 4) => {
      const f = 10 ** digits;
      return Math.round((min + gen() * (max - min)) * f) / f;
    },
  };
}

/** 分层测试中「随机但确定」的统一采样维度。 */
export function hashJson(value: unknown): string {
  // 键序固定：先 stringify（JS 对象键按插入顺序，构造处也保持同一顺序）
  const json = JSON.stringify(value);
  let h1 = 0xdeadbeef ^ json.length;
  let h2 = 0x41c6ce57 ^ json.length;
  for (let i = 0; i < json.length; i += 1) {
    const ch = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const out = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return out.toString(16).padStart(13, '0');
}

/** 判定结果指纹：剔除时间戳/行 id 后应跨库、跨次回放保持一致。 */
export function windowFingerprint(r: {
  date: string;
  verdict: string;
  reasons: { code: string; level: string }[];
  episode?: { degraded: boolean; provider: string } | null;
}): string {
  return hashJson({
    date: r.date,
    verdict: r.verdict,
    reasons: r.reasons.map((x) => `${x.level}:${x.code}`),
    degraded: r.episode?.degraded ?? true,
    provider: r.episode?.provider ?? null,
  });
}

export interface Harness {
  tmpDir: string;
  /** 动态加载的服务端模块（各测试文件独立模块注册表与数据库） */
  mod: typeof import('../../src/db.js');
  config: typeof import('../../src/config.js').config;
}

/**
 * 建立独立的临时库并迁移表结构（不 seed 业务数据）。
 * L2（service）与 L3（HTTP 闭环）共用；每个文件独立 tmpDir，互不污染。
 */
export async function setupHarness(opts: { weatherProvider?: 'off' | 'fixture' | 'open-meteo' } = {}): Promise<{
  tmpDir: string;
  db: import('../../src/db.js').SqliteDb;
  mod: typeof import('../../src/db.js');
  config: typeof import('../../src/config.js').config;
  close: () => void;
}> {
  // 本套测试在 singleFork 下运行：文件间模块注册表默认共享，db 单例会串库。
  // 每个文件建库前显式重置注册表，之后所有 import 都拿到绑定新临时库的模块。
  vi.resetModules();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-matrix-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'matrix-test-secret';
  process.env.WEATHER_PROVIDER = opts.weatherProvider ?? 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';
  process.env.LOG_SILENT = 'true';

  const mod = await import('../../src/db.js');
  const { config } = await import('../../src/config.js');
  mod.migrate();
  return { tmpDir, db: mod.getDb(), mod, config, close: () => mod.closeDb() };
}

export function cleanup(h: { tmpDir: string; close: () => void }): void {
  h.close();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

/** 进程级自增，避免同一文件多次建库时默认生成的 id 撞唯一键。 */
let librarySeq = 0;

/** 直接插一条 owner + library，返回主键（测试专用，绕过注册流程）。 */
export function seedLibrary(
  db: import('../../src/db.js').SqliteDb,
  seed: { id?: string; email?: string; defaultFuzzLevel?: string } = {},
): { userId: string; libraryId: string } {
  // 默认 id 带进程级自增，保证同一文件多次建库（不同 harness）不撞唯一键
  librarySeq += 1;
  const userId = seed.id ?? `u_${librarySeq.toString(36)}${hashJson(seed.email ?? 'owner').slice(0, 8)}`;
  const libraryId = `lib_${userId}`;
  const ts = '2026-09-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO "user" (id, email, password_hash, display_name, timezone, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(userId, seed.email ?? `${userId}@matrix.local`, 'x', '矩阵测试用户', 'Asia/Shanghai', ts, ts);
  db.prepare(
    `INSERT INTO library (id, name, owner_id, default_fuzz_level, tz, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(libraryId, '矩阵测试库', userId, seed.defaultFuzzLevel ?? 'g500', 'Asia/Shanghai', ts, ts);
  return { userId, libraryId };
}

export function seedPlaceAndSpot(
  db: import('../../src/db.js').SqliteDb,
  libraryId: string,
  p: { idPrefix: string; lat: number; lng: number; bearing?: number; tz?: string; district?: string; city?: string },
): { placeId: string; spotId: string } {
  const ts = '2026-09-01T00:00:00.000Z';
  const placeId = `pl_${p.idPrefix}`;
  const spotId = `sp_${p.idPrefix}`;
  db.prepare(
    `INSERT INTO place (id, library_id, name, city, district, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(placeId, libraryId, `地点 ${p.idPrefix}`, p.city ?? '上海', p.district ?? null, ts, ts);
  db.prepare(
    `INSERT INTO spot (id, library_id, place_id, lat, lng, camera_bearing, visibility, tz, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'private', ?, ?, ?)`,
  ).run(spotId, libraryId, placeId, p.lat, p.lng, p.bearing ?? 0, p.tz ?? 'Asia/Shanghai', ts, ts);
  return { placeId, spotId };
}

export function seedInspiration(
  db: import('../../src/db.js').SqliteDb,
  libraryId: string,
  spotId: string | null,
  idPrefix: string,
  status = 'ready',
): string {
  const ts = '2026-09-01T00:00:00.000Z';
  const id = `in_${idPrefix}`;
  db.prepare(
    `INSERT INTO inspiration (id, library_id, title, status, spot_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, libraryId, `灵感 ${idPrefix}`, status, spotId, ts, ts);
  return id;
}

/** 逐小时预报构造：用回调决定每个小时，避免依赖系统时钟（回放稳定性）。 */
export function hourlyForecast(
  startUtcIso: string,
  hours: number,
  fill: (h: number, d: number) => Partial<import('../../src/services/weather.js').HourlyForecast>,
): import('../../src/services/weather.js').HourlyForecast[] {
  const start = new Date(startUtcIso);
  const base = {
    cloudCoverPct: 30,
    precipProbPct: 5,
    precipMm: 0,
    visibilityKm: 20,
    windSpeedMs: 3,
    tempC: 20,
    humidityPct: 55,
    snowfallCm: 0,
  };
  return Array.from({ length: hours }, (_, i) => {
    const d = Math.floor(i / 24);
    const h = i % 24;
    return { time: new Date(start.getTime() + i * 3600000).toISOString(), ...base, ...fill(h, d) };
  });
}
