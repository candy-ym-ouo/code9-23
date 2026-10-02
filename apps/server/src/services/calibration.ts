import type { MissReason } from '@flil/shared';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
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

/** 撤销一次收窄（校准必须可回溯、可撤销） */
export function undoCalibration(calibrationId: string, libraryId: string, inspirationId: string): void {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM calibration_log WHERE id = ? AND inspiration_id = ?')
    .get(calibrationId, inspirationId) as Record<string, unknown> | undefined;
  if (!row || row.library_id !== libraryId) return;

  const field = row.field as string;
  const before = parseJson<unknown>(row.before_value, null);
  const timing = loadTiming(inspirationId);
  if (timing) {
    if (field === 'azimuth_tolerance') {
      // 历史坏档的 before_value 可能解析为 null/非法类型；NOT NULL 列不接受 null，
      // 此时放弃恢复数值（只把校准记录标记为已撤销），绝不用脏值覆盖当前 timing。
      if (typeof before === 'number' && Number.isFinite(before)) {
        db.prepare('UPDATE timing SET azimuth_tolerance = ? WHERE id = ?').run(before, timing.id);
      }
    } else if (field === 'window_tolerance_min') {
      if (typeof before === 'number' && Number.isFinite(before)) {
        db.prepare('UPDATE timing SET window_tolerance_min = ? WHERE id = ?').run(before, timing.id);
      }
    } else if (field === 'weather_profile') {
      const profile = parseJson<{ cloudCoverPct?: unknown }>(timing.weather_profile, {});
      const cloud = before as { min?: unknown; max?: unknown } | null;
      // 只有当旧值是合法的 {min,max} 数值区间时才恢复，避免坏档写出半截 JSON
      if (
        cloud &&
        typeof cloud.min === 'number' &&
        typeof cloud.max === 'number' &&
        Number.isFinite(cloud.min) &&
        Number.isFinite(cloud.max)
      ) {
        profile.cloudCoverPct = cloud as { min: number; max: number };
        db.prepare('UPDATE timing SET weather_profile = ? WHERE id = ?').run(toJson(profile), timing.id);
      }
    }
  }
  db.prepare('UPDATE calibration_log SET undone_at = ? WHERE id = ?').run(nowIso(), calibrationId);
}
