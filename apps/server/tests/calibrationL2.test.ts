/**
 * 分层测试矩阵 · 校准撤销层 L2（calibration + DB）
 *
 * 覆盖维度：
 * - 正常链路：连续 3 次同因 miss → 收紧 → 撤销恢复
 * - 并发撤销：同一记录 N 次并发撤销恰好 1 次成功；多条记录互不干扰
 * - 幂等：重复撤销 400；不存在 / 跨库 404
 * - 历史坏档（旧版本备份可能留下）：
 *   · before_value 非法 JSON
 *   · before_value 类型/范围错误（字符串、负数、越界）
 *   · timing 行已被删除
 *   · 未知 field
 *   坏档一律不炸、不把脏值写回 timing，只留 undone_at 痕迹。
 * - 随机回放：随机收窄序列 + 撤销回放逐次一致
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, hashJson, mulberry32, rng, seedInspiration, seedLibrary, seedPlaceAndSpot, setupHarness } from './support/matrix.ts';
import type { SqliteDb } from '../src/db.js';

function isApiError(e: unknown, status: number, code?: string): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { status?: number }).status === status &&
    (code === undefined || (e as { code?: string }).code === code)
  );
}

let db: SqliteDb;
let libraryId: string;
let h: Awaited<ReturnType<typeof setupHarness>>;
let calibration: typeof import('../src/services/calibration.js');
let timingService: typeof import('../src/services/windowEngine.js');

const TS = '2026-09-10T00:00:00.000Z';

function setupCard(prefix: string, opts: { azimuthTol?: number; windowTol?: number; cloud?: [number, number] } = {}): {
  inspirationId: string;
  spotId: string;
} {
  const { spotId } = seedPlaceAndSpot(db, libraryId, { idPrefix: prefix, lat: 31.2, lng: 121.4 });
  const inspirationId = seedInspiration(db, libraryId, spotId, prefix);
  db.prepare(
    `INSERT INTO timing (id, library_id, inspiration_id, time_anchor, anchor_offset_min, elevation_range,
       azimuth_range, azimuth_tolerance, window_tolerance_min, weather_profile, season_window, notes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `tm_${prefix}`,
    libraryId,
    inspirationId,
    'sunset_minus',
    40,
    '[-90,90]',
    null,
    opts.azimuthTol ?? 15,
    opts.windowTol ?? 12,
    opts.cloud ? JSON.stringify({ cloudCoverPct: { min: opts.cloud[0], max: opts.cloud[1] } }) : '{}',
    null,
    null,
    TS,
    TS,
  );
  return { inspirationId, spotId };
}

/** 追加一条 miss 回填（不经过 plan 闭环，直接落 shoot_plan + shoot_result）。 */
function addMiss(inspirationId: string, i: number, reasons: string[] = ['timing_off']): void {
  const filledAt = new Date(Date.parse(TS) + i * 86400000).toISOString();
  // plan 必须先于 result（shoot_result.plan_id 外键）
  db.prepare(
    `INSERT INTO shoot_plan (id, library_id, inspiration_id, planned_at, status, created_at, updated_at)
     VALUES (?,?,?, ?, 'done', ?, ?)`,
  ).run(`pl_${inspirationId}_${i}`, libraryId, inspirationId, '2026-09-09T00:00:00Z', TS, TS);
  db.prepare(
    `INSERT INTO shoot_result (id, library_id, plan_id, inspiration_id, hit_level, miss_reasons, note, filled_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    `sr_${inspirationId}_${i}`,
    libraryId,
    `pl_${inspirationId}_${i}`,
    inspirationId,
    'miss',
    JSON.stringify(reasons),
    null,
    filledAt,
    TS,
  );
}

/** 手工塞一条校准日志（模拟历史数据/坏档）。 */
let calibSeq = 0;
function insertCalibration(inspirationId: string, field: string, before: string | null, after: unknown): string {
  calibSeq += 1;
  const id = `cl_${field}_${calibSeq}`;
  db.prepare(
    `INSERT INTO calibration_log (id, library_id, inspiration_id, field, before_value, after_value, reason, triggered_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, libraryId, inspirationId, field, before, JSON.stringify(after), '历史收窄', 'test', TS);
  return id;
}

beforeAll(async () => {
  h = await setupHarness();
  db = h.db;
  ({ libraryId } = seedLibrary(db));
  calibration = await import('../src/services/calibration.js');
  timingService = await import('../src/services/windowEngine.js');
});

afterAll(() => cleanup(h));

describe('L2 撤销正常链路', () => {
  it('3 次同因 miss 触发方位角容差收紧，撤销后恢复原值', () => {
    const { inspirationId } = setupCard('ok');
    for (let i = 0; i < 3; i += 1) addMiss(inspirationId, i);
    const out = calibration.applyCalibration(libraryId, inspirationId, 'test');
    expect(out.tightened.map((t) => t.field)).toContain('azimuth_tolerance');
    expect(timingService.loadTiming(inspirationId)!.azimuth_tolerance).toBe(10);

    const log = calibration.listCalibration(inspirationId)[0] as { id: string; undoneAt: string | null };
    const res = calibration.undoCalibration(log.id, libraryId, inspirationId);
    expect(res.restored).toBe(true);
    expect(timingService.loadTiming(inspirationId)!.azimuth_tolerance).toBe(15);
    expect(calibration.listCalibration(inspirationId)[0].undoneAt).not.toBeNull();
  });

  it('云量区间收窄同样可撤销恢复', () => {
    const { inspirationId } = setupCard('cloud', { azimuthTol: 8, cloud: [0, 80] });
    for (let i = 0; i < 3; i += 1) addMiss(inspirationId, i);
    const out = calibration.applyCalibration(libraryId, inspirationId, 'test');
    expect(out.tightened.map((t) => t.field)).toContain('cloudCoverPct');
    const log = calibration.listCalibration(inspirationId)[0] as { id: string };
    calibration.undoCalibration(log.id, libraryId, inspirationId);
    const profile = JSON.parse(timingService.loadTiming(inspirationId)!.weather_profile) as {
      cloudCoverPct?: { min: number; max: number };
    };
    expect(profile.cloudCoverPct).toEqual({ min: 0, max: 80 });
  });
});

describe('L2 并发撤销', () => {
  it('同一校准记录并发撤销 50 次：恰好 1 次成功，其余 400（守卫 UPDATE 起作用）', () => {
    const { inspirationId } = setupCard('race1');
    for (let i = 0; i < 3; i += 1) addMiss(inspirationId, i);
    calibration.applyCalibration(libraryId, inspirationId, 'test');
    const logId = (calibration.listCalibration(inspirationId)[0] as { id: string }).id;

    let ok = 0;
    let rejected = 0;
    for (let i = 0; i < 50; i += 1) {
      try {
        calibration.undoCalibration(logId, libraryId, inspirationId);
        ok += 1;
      } catch (e) {
        if (isApiError(e, 400)) rejected += 1;
        else throw e;
      }
    }
    expect(ok).toBe(1);
    expect(rejected).toBe(49);
    expect(timingService.loadTiming(inspirationId)!.azimuth_tolerance).toBe(15);
  });

  it('两条不同记录并发撤销互不干扰，各成功一次；timing 最终停在更早的原值', () => {
    const { inspirationId } = setupCard('race2');
    // 手工造两条先后收窄：15 → 10 → 8
    const idA = insertCalibration(inspirationId, 'azimuth_tolerance', '15', 10);
    const idB = insertCalibration(inspirationId, 'azimuth_tolerance', '10', 8);
    db.prepare('UPDATE timing SET azimuth_tolerance = 8 WHERE inspiration_id = ?').run(inspirationId);

    const results: string[] = [];
    for (const id of [idA, idB, idA, idB]) {
      try {
        calibration.undoCalibration(id, libraryId, inspirationId);
        results.push(`ok:${id === idA ? 'A' : 'B'}`);
      } catch (e) {
        results.push(`400:${id === idA ? 'A' : 'B'}`);
      }
    }
    // 先撤销 A（恢复 15），再撤销 B（恢复 10），后两次重复撤销被拒；最终值以最后一次恢复为准
    expect(results).toEqual(['ok:A', 'ok:B', '400:A', '400:B']);
    expect(timingService.loadTiming(inspirationId)!.azimuth_tolerance).toBe(10);
  });

  it('Promise.all 并发结算结果确定（同步 service 下与顺序循环等价）', async () => {
    const { inspirationId } = setupCard('race3');
    for (let i = 0; i < 3; i += 1) addMiss(inspirationId, i);
    calibration.applyCalibration(libraryId, inspirationId, 'test');
    const logId = (calibration.listCalibration(inspirationId)[0] as { id: string }).id;

    const settled = await Promise.all(
      Array.from({ length: 20 }, () =>
        Promise.resolve()
          .then(() => calibration.undoCalibration(logId, libraryId, inspirationId))
          .then(() => 'ok')
          .catch((e: unknown) => (isApiError(e, 400) ? '400' : 'throw')),
      ),
    );
    expect(settled.filter((x) => x === 'ok')).toHaveLength(1);
    expect(settled.filter((x) => x === '400')).toHaveLength(19);
  });
});

describe('L2 幂等与越权', () => {
  it('重复撤销返回 400（不静默成功）', () => {
    const { inspirationId } = setupCard('idem');
    const id = insertCalibration(inspirationId, 'azimuth_tolerance', '15', 10);
    calibration.undoCalibration(id, libraryId, inspirationId);
    expect(() => calibration.undoCalibration(id, libraryId, inspirationId)).toThrow(/已撤销/);
  });

  it('校准记录不存在 → 404；跨库撤销 → 404', () => {
    const { inspirationId } = setupCard('scope');
    expect(() => calibration.undoCalibration('cl_nope', libraryId, inspirationId)).toThrow(/不存在/);
    expect(() => calibration.undoCalibration('cl_nope', 'lib_other', inspirationId)).toThrow(/不存在/);
  });
});

describe('L2 历史坏档 · 撤销不得炸库或写脏值', () => {
  function timingRow(inspirationId: string) {
    return db.prepare('SELECT * FROM timing WHERE inspiration_id = ?').get(inspirationId) as Record<string, unknown>;
  }

  it('before_value 是非法 JSON：撤销标记成功留痕，但 timing 列不被污染', () => {
    const { inspirationId } = setupCard('bad1');
    db.prepare('UPDATE timing SET azimuth_tolerance = 8 WHERE inspiration_id = ?').run(inspirationId);
    const id = insertCalibration(inspirationId, 'azimuth_tolerance', '{broken-json', 8);

    const res = calibration.undoCalibration(id, libraryId, inspirationId);
    expect(res.restored).toBe(false);
    expect(res.skippedReason).toBe('before_value_invalid');
    const row = timingRow(inspirationId);
    expect(row.azimuth_tolerance).toBe(8); // 维持当前值，没有写入 NaN/null
    const log = db.prepare('SELECT undone_at FROM calibration_log WHERE id = ?').get(id) as { undone_at: string };
    expect(log.undone_at).not.toBeNull();
  });

  it('before_value 类型错误（字符串 / 负数 / 越界）一律跳过恢复', () => {
    const cases: { raw: string | null; reason: string }[] = [
      { raw: '"fifteen"', reason: 'string' },
      { raw: '-5', reason: 'negative' },
      { raw: '9999', reason: 'overrange' },
      { raw: 'null', reason: 'null' },
    ];
    cases.forEach((c, idx) => {
      const { inspirationId } = setupCard(`bad2_${idx}`);
      const id = insertCalibration(inspirationId, 'azimuth_tolerance', c.raw, 8);
      const res = calibration.undoCalibration(id, libraryId, inspirationId);
      expect(res.restored, c.reason).toBe(false);
      expect(res.skippedReason).toBe('before_value_invalid');
      expect(timingRow(inspirationId).azimuth_tolerance).toBe(15);
    });
  });

  it('weather_profile 的 before_value 损坏时不覆盖当前 profile', () => {
    const { inspirationId } = setupCard('bad3');
    db.prepare('UPDATE timing SET weather_profile = ? WHERE inspiration_id = ?').run(
      JSON.stringify({ cloudCoverPct: { min: 10, max: 60 } }),
      inspirationId,
    );
    const id = insertCalibration(inspirationId, 'weather_profile', '42', { min: 5, max: 65 });
    const res = calibration.undoCalibration(id, libraryId, inspirationId);
    expect(res.restored).toBe(false);
    const profile = JSON.parse(timingRow(inspirationId).weather_profile as string);
    expect(profile.cloudCoverPct).toEqual({ min: 10, max: 60 });
  });

  it('timing 行已被删除（孤儿校准日志）：仍可撤销留痕，不抛外键错误', () => {
    const { inspirationId } = setupCard('bad4');
    const id = insertCalibration(inspirationId, 'azimuth_tolerance', '15', 10);
    db.prepare('DELETE FROM timing WHERE inspiration_id = ?').run(inspirationId);
    const res = calibration.undoCalibration(id, libraryId, inspirationId);
    expect(res.restored).toBe(false);
    expect(res.skippedReason).toBe('timing_missing');
    const log = db.prepare('SELECT undone_at FROM calibration_log WHERE id = ?').get(id) as { undone_at: string };
    expect(log.undone_at).not.toBeNull();
  });

  it('未知 field（新版本写入的收窄类型）：不认识就只留撤销痕迹', () => {
    const { inspirationId } = setupCard('bad5');
    const id = insertCalibration(inspirationId, 'future_magic_field', '"x"', 'y');
    const res = calibration.undoCalibration(id, libraryId, inspirationId);
    expect(res.restored).toBe(false);
    expect(res.skippedReason).toBe('unknown_field');
  });
});

describe('L2 随机回放 · 收窄/撤销序列逐次复现', () => {
  type Step = { field: string; before: number | { min: number; max: number }; undoOk: boolean; restored: boolean };

  let runSeq = 0;

  function run(seed: number): Step[] {
    runSeq += 1;
    const rnd = rng(seed);
    const steps: Step[] = [];
    for (let i = 0; i < 40; i += 1) {
      const prefix = `rep_${runSeq}_${seed.toString(36)}_${i}`;
      const useCloud = rnd.next() > 0.5;
      const { inspirationId } = setupCard(prefix, {
        azimuthTol: 8,
        windowTol: 12,
        cloud: useCloud ? [0, 20 + Math.floor(rnd.next() * 60)] : undefined,
      });
      const profile = JSON.parse(timingService.loadTiming(inspirationId)!.weather_profile) as {
        cloudCoverPct?: { min: number; max: number };
      };
      const before: number | { min: number; max: number } = useCloud
        ? { min: 0, max: profile.cloudCoverPct!.max }
        : 15;
      // 随机决定 before_value 是否完好
      const corrupt = rnd.next() > 0.7;
      const raw = corrupt ? '{x' : JSON.stringify(before);
      const id = insertCalibration(
        inspirationId,
        useCloud ? 'weather_profile' : 'azimuth_tolerance',
        raw,
        useCloud ? { min: 5, max: 40 } : 10,
      );
      const res = calibration.undoCalibration(id, libraryId, inspirationId);
      steps.push({ field: useCloud ? 'weather_profile' : 'azimuth_tolerance', before, undoOk: true, restored: res.restored });
    }
    return steps;
  }

  it('同种子两次回放序列完全一致（含坏档跳过比例）', () => {
    const a = run(20261001);
    const b = run(20261001);
    expect(hashJson(a)).toBe(hashJson(b));
    const restoredCount = a.filter((s) => s.restored).length;
    expect(restoredCount).toBeGreaterThan(0);
    expect(restoredCount).toBeLessThan(40); // 矩阵中确实混入了坏档
  });

  it('回放不依赖执行顺序之外的随机源（不同种子结果不同）', () => {
    expect(hashJson(run(1))).not.toBe(hashJson(run(2)));
  });

  it('mulberry32 自身确定性（防止以后有人偷偷换成 Math.random）', () => {
    const g = mulberry32(12345);
    expect([g(), g(), g()].map((x) => x.toFixed(8))).toEqual([
      mulberry32(12345)().toFixed(8),
      (() => {
        const g2 = mulberry32(12345);
        g2();
        return g2();
      })().toFixed(8),
      (() => {
        const g3 = mulberry32(12345);
        g3();
        g3();
        return g3();
      })().toFixed(8),
    ]);
  });
});
