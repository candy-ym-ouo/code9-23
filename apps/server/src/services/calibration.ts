import type { MissReason } from '@flil/shared';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { errors } from '../http/errors.js';
import { loadTiming } from './windowEngine.js';
import { touch } from './inspirations.js';

export interface CalibrationOutcome {
  hitRate: number;
  hitCount: number;
  partialCount: number;
  missCount: number;
  tightened: { field: string; before: unknown; after: unknown }[];
  suggestions: string[];
}

/** 重算命中率：hit 计 1，partial 计 0.5（文档 6.3） */
export function recomputeHitRate(inspirationId: string): {
  hitRate: number;
  hitCount: number;
  partialCount: number;
  missCount: number;
} {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN hit_level = 'hit' THEN 1 ELSE 0 END) AS hit_count,
         SUM(CASE WHEN hit_level = 'partial' THEN 1 ELSE 0 END) AS partial_count,
         SUM(CASE WHEN hit_level = 'miss' THEN 1 ELSE 0 END) AS miss_count
       FROM shoot_result WHERE inspiration_id = ?`,
    )
    .get(inspirationId) as {
    hit_count: number | null;
    partial_count: number | null;
    miss_count: number | null;
  };

  const hitCount = row.hit_count ?? 0;
  const partialCount = row.partial_count ?? 0;
  const missCount = row.miss_count ?? 0;
  const total = hitCount + partialCount + missCount;
  const hitRate = total ? (hitCount + partialCount * 0.5) / total : 0;

  db.prepare(
    'UPDATE inspiration SET hit_count = ?, partial_count = ?, miss_count = ?, hit_rate = ? WHERE id = ?',
  ).run(hitCount, partialCount, missCount, Number(hitRate.toFixed(4)), inspirationId);

  return { hitRate: Number(hitRate.toFixed(4)), hitCount, partialCount, missCount };
}

function lastResults(inspirationId: string, limit = 5): { hit_level: string; miss_reasons: MissReason[] }[] {
  const rows = getDb()
    .prepare(
      'SELECT hit_level, miss_reasons FROM shoot_result WHERE inspiration_id = ? ORDER BY filled_at DESC LIMIT ?',
    )
    .all(inspirationId, limit) as { hit_level: string; miss_reasons: string }[];
  return rows.map((r) => ({
    hit_level: r.hit_level,
    miss_reasons: parseJson<MissReason[]>(r.miss_reasons, []),
  }));
}

function logCalibration(
  libraryId: string,
  inspirationId: string,
  field: string,
  before: unknown,
  after: unknown,
  reason: string,
  triggeredBy: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO calibration_log (id, library_id, inspiration_id, field, before_value, after_value, reason, triggered_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(newId(), libraryId, inspirationId, field, toJson(before), toJson(after), reason, triggeredBy, nowIso());
}

/**
 * 回填后的校准（文档 6.3 规则 2/3）：
 * 连续 3 次同因 miss（天气不符 / 时间差了）→ 收紧一档判断；site_rebuilt 出现 2 次 → 建议归档。
 * **只收紧判断与给建议，绝不自动改卡片状态**——人的决定由人做。
 */
export function applyCalibration(
  libraryId: string,
  inspirationId: string,
  triggeredBy: string,
): CalibrationOutcome {
  const db = getDb();
  const stats = recomputeHitRate(inspirationId);
  const results = lastResults(inspirationId, 5);
  const tightened: CalibrationOutcome['tightened'] = [];
  const suggestions: string[] = [];

  const timingRow = loadTiming(inspirationId);
  const recent3 = results.slice(0, 3);
  const allMissSameCause =
    recent3.length === 3 &&
    recent3.every((r) => r.hit_level === 'miss') &&
    recent3.every((r) => r.miss_reasons.some((m) => m === 'timing_off' || m === 'weather_mismatch'));

  if (timingRow && allMissSameCause) {
    if (timingRow.azimuth_tolerance > 8) {
      const before = timingRow.azimuth_tolerance;
      const after = Math.max(8, before - 5);
      db.prepare('UPDATE timing SET azimuth_tolerance = ?, updated_at = ? WHERE id = ?').run(
        after,
        nowIso(),
        timingRow.id,
      );
      logCalibration(
        libraryId,
        inspirationId,
        'azimuth_tolerance',
        before,
        after,
        '连续 3 次未命中且原因为时间/天气偏差，方位角容差收紧一档',
        triggeredBy,
      );
      tightened.push({ field: 'azimuth_tolerance', before, after });
    } else {
      const profile = parseJson<{ cloudCoverPct?: { min: number; max: number } }>(timingRow.weather_profile, {});
      if (profile.cloudCoverPct && profile.cloudCoverPct.max - profile.cloudCoverPct.min > 15) {
        const before = { ...profile.cloudCoverPct };
        const after = { min: profile.cloudCoverPct.min + 5, max: profile.cloudCoverPct.max - 5 };
        profile.cloudCoverPct = after;
        db.prepare('UPDATE timing SET weather_profile = ?, updated_at = ? WHERE id = ?').run(
          toJson(profile),
          nowIso(),
          timingRow.id,
        );
        logCalibration(
          libraryId,
          inspirationId,
          'weather_profile',
          before,
          after,
          '连续 3 次未命中且原因为时间/天气偏差，云量区间收窄一档',
          triggeredBy,
        );
        tightened.push({ field: 'cloudCoverPct', before, after });
      } else if (timingRow.window_tolerance_min > 6) {
        const before = timingRow.window_tolerance_min;
        const after = Math.max(6, before - 3);
        db.prepare('UPDATE timing SET window_tolerance_min = ?, updated_at = ? WHERE id = ?').run(
          after,
          nowIso(),
          timingRow.id,
        );
        logCalibration(
          libraryId,
          inspirationId,
          'window_tolerance_min',
          before,
          after,
          '连续 3 次未命中且原因为时间偏差，窗口容差收紧一档',
          triggeredBy,
        );
        tightened.push({ field: 'window_tolerance_min', before, after });
      }
    }
  }

  if (results.filter((r) => r.miss_reasons.includes('site_rebuilt')).length >= 2) {
    suggestions.push('该地点已有 2 次「现场已改造」记录，建议归档这张卡（系统不会自动改状态）。');
  }
  if (results.filter((r) => r.miss_reasons.includes('too_crowded')).length >= 2) {
    suggestions.push('该地点已有 2 次「人太多」记录，建议在机位备注里补充备用时段。');
  }

  if (tightened.length) touch(inspirationId);
  return { ...stats, tightened, suggestions };
}

export function listCalibration(inspirationId: string): Record<string, unknown>[] {
  const rows = getDb()
    .prepare('SELECT * FROM calibration_log WHERE inspiration_id = ? ORDER BY created_at DESC')
    .all(inspirationId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id,
    field: r.field,
    before: parseJson(r.before_value, null),
    after: parseJson(r.after_value, null),
    reason: r.reason,
    undoneAt: (r.undone_at as string | null) ?? null,
    createdAt: r.created_at,
  }));
}

/**
 * 撤销一次收窄（校准必须可回溯、可撤销）。
 *
 * 坏档防护（历史备份里可能存在旧版本写入的异常数据）：
 * - 记录不存在 / 跨库 / 已撤销 → 抛错，不静默 200（接口层据此给出 404/400）。
 * - before_value 损坏、类型不对或 timing 行已丢失：只标记 undone_at，绝不把脏值写回 NOT NULL 列。
 * - 幂等：已撤销的记录再次撤销返回 400，并发撤销只有一方成功（UPDATE 带 undone_at IS NULL 守卫）。
 */
export function undoCalibration(calibrationId: string, libraryId: string, inspirationId: string): {
  restored: boolean;
  field: string;
  skippedReason?: string;
} {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM calibration_log WHERE id = ? AND inspiration_id = ?')
    .get(calibrationId, inspirationId) as Record<string, unknown> | undefined;
  if (!row || row.library_id !== libraryId) throw errors.notFound('校准记录');
  if (row.undone_at) throw errors.badRequest('该校准记录已撤销，请勿重复操作');

  const field = row.field as string;
  const before = parseJson<unknown>(row.before_value, null);
  const timing = loadTiming(inspirationId);

  let restored = false;
  let skippedReason: string | undefined;

  const restore = db.transaction(() => {
    if (!timing) {
      skippedReason = 'timing_missing';
    } else if (field === 'azimuth_tolerance' || field === 'window_tolerance_min') {
      if (typeof before === 'number' && Number.isFinite(before) && before >= 0 && before <= 360) {
        const column = field === 'azimuth_tolerance' ? 'azimuth_tolerance' : 'window_tolerance_min';
        db.prepare(`UPDATE timing SET ${column} = ?, updated_at = ? WHERE id = ?`).run(
          before,
          nowIso(),
          timing.id,
        );
        restored = true;
      } else {
        skippedReason = 'before_value_invalid';
      }
    } else if (field === 'weather_profile') {
      // 当前 profile 本身也可能是坏档 JSON：parseJson 已回退为 {}，不会抛错
      const profile = parseJson<{ cloudCoverPct?: unknown }>(timing.weather_profile, {});
      if (
        before !== null &&
        typeof before === 'object' &&
        typeof (before as { min?: unknown }).min === 'number' &&
        typeof (before as { max?: unknown }).max === 'number'
      ) {
        profile.cloudCoverPct = before as { min: number; max: number };
        db.prepare('UPDATE timing SET weather_profile = ?, updated_at = ? WHERE id = ?').run(
          toJson(profile),
          nowIso(),
          timing.id,
        );
        restored = true;
      } else {
        skippedReason = 'before_value_invalid';
      }
    } else {
      // 未知字段（新版本可能产生旧代码不认识的收窄）：无值可恢复，仅留撤销痕迹
      skippedReason = 'unknown_field';
    }

    // 守卫更新：并发撤销时只有一方 changes === 1
    const res = db
      .prepare('UPDATE calibration_log SET undone_at = ? WHERE id = ? AND undone_at IS NULL')
      .run(nowIso(), calibrationId);
    if (res.changes === 0) throw errors.badRequest('该校准记录已撤销，请勿重复操作');
  });
  restore();

  return { restored, field, skippedReason };
}
