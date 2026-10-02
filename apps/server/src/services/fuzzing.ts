import {
  FUZZ_LEVEL_GEOHASH_LEN,
  FUZZ_LEVEL_LABEL,
  SHARE_ALLOWED_FUZZ_LEVELS,
  decodeGeohashBounds,
  encodeGeohash,
  geohashCenter,
  roundCoord,
  type FuzzLevel,
  type FuzzResult,
} from '@flil/shared';
import { getDb, newId, nowIso } from '../db.js';
import { errors } from '../http/errors.js';

export interface SpotRow {
  id: string;
  library_id: string;
  place_id: string;
  lat: number;
  lng: number;
  camera_bearing: number;
  elevation_m: number | null;
  access_note: string | null;
  best_time_note: string | null;
  visibility: 'private' | 'fuzzy_shared';
  tz: string;
}

export interface PlaceRow {
  id: string;
  name: string;
  city: string | null;
  district: string | null;
  category: string | null;
  address_text: string | null;
}

/** 分享场景的模糊级别校验：必须是 g500 或更粗（文档 13.4 安全底线） */
export function assertShareFuzzLevel(level: FuzzLevel): FuzzLevel {
  if (!SHARE_ALLOWED_FUZZ_LEVELS.includes(level)) {
    // 不抛错而是强制降级，保证"手填 exact 也会被服务端拦下"
    return 'g500';
  }
  return level;
}

export function isShareFuzzLevelAllowed(level: FuzzLevel): boolean {
  return SHARE_ALLOWED_FUZZ_LEVELS.includes(level);
}

/**
 * 读取路径的级别兜底：历史坏档里 fuzz_level 可能被写成未知值。
 * 未知一律退到最粗的安全默认（g500 或更粗由调用方决定），绝不按 exact 处理。
 */
export function safeFuzzLevel(level: unknown, fallback: FuzzLevel = 'g500'): FuzzLevel {
  return typeof level === 'string' && (SHARE_ALLOWED_FUZZ_LEVELS as string[]).includes(level)
    ? (level as FuzzLevel)
    : fallback;
}

/**
 * 计算某机位在某模糊级别下的对外坐标。
 * 关键：取 geohash 网格中心，而不是原坐标 + 随机抖动（文档 13.2）——
 * 随机抖动可被多次请求平均反推真值，网格中心只有一个稳定解。
 */
export function fuzzSpot(spot: SpotRow, place: PlaceRow | null, level: FuzzLevel): FuzzResult {
  if (level === 'exact') {
    return {
      fuzzLevel: level,
      lat: spot.lat,
      lng: spot.lng,
      geohash: encodeGeohash({ lat: spot.lat, lng: spot.lng }, 12),
      label: '精确坐标',
    };
  }

  const len = FUZZ_LEVEL_GEOHASH_LEN[level];
  const hash = encodeGeohash({ lat: spot.lat, lng: spot.lng }, len);

  let label = FUZZ_LEVEL_LABEL[level];
  if (level === 'district') {
    const b = decodeGeohashBounds(hash);
    const area = place?.district ?? place?.city;
    return {
      fuzzLevel: level,
      lat: null,
      lng: null,
      geohash: hash,
      label: area ? `${area}` : `${label} · ${b.minLat.toFixed(2)},${b.minLng.toFixed(2)} 一带`,
    };
  }
  if (level === 'neighborhood') {
    const area = place?.district ?? place?.city ?? place?.name ?? '街区不详';
    return { fuzzLevel: level, lat: null, lng: null, geohash: hash, label: `${area}` };
  }

  const center = geohashCenter(hash);
  const area = place?.district ?? place?.city;
  return {
    fuzzLevel: level,
    lat: roundCoord(center.lat, 5),
    lng: roundCoord(center.lng, 5),
    geohash: hash,
    label: area ? `${FUZZ_LEVEL_LABEL[level]} · ${area}` : FUZZ_LEVEL_LABEL[level],
  };
}

/** 带缓存的模糊化（结果恒定，避免同一机位多次请求模糊到不同位置） */
export function fuzzSpotCached(
  spot: SpotRow,
  place: PlaceRow | null,
  level: FuzzLevel,
): FuzzResult {
  const db = getDb();
  const cached = db
    .prepare('SELECT * FROM place_fuzz_cache WHERE spot_id = ? AND fuzz_level = ?')
    .get(spot.id, level) as
    | { fuzz_lat: number | null; fuzz_lng: number | null; fuzz_label: string; geohash: string }
    | undefined;

  if (cached) {
    return {
      fuzzLevel: level,
      lat: cached.fuzz_lat,
      lng: cached.fuzz_lng,
      geohash: cached.geohash,
      label: cached.fuzz_label,
    };
  }

  const result = fuzzSpot(spot, place, level);
  db.prepare(
    `INSERT INTO place_fuzz_cache (id, library_id, spot_id, fuzz_level, fuzz_lat, fuzz_lng, fuzz_label, geohash, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (spot_id, fuzz_level) DO UPDATE SET
       fuzz_lat = excluded.fuzz_lat, fuzz_lng = excluded.fuzz_lng,
       fuzz_label = excluded.fuzz_label, geohash = excluded.geohash, computed_at = excluded.computed_at`,
  ).run(
    newId(),
    spot.library_id,
    spot.id,
    level,
    result.lat,
    result.lng,
    result.label,
    result.geohash,
    nowIso(),
  );
  return result;
}

export function clearFuzzCache(spotId: string): void {
  getDb().prepare('DELETE FROM place_fuzz_cache WHERE spot_id = ?').run(spotId);
}

export function loadSpotRow(spotId: string): { spot: SpotRow; place: PlaceRow | null } | null {
  const db = getDb();
  const spot = db.prepare('SELECT * FROM spot WHERE id = ?').get(spotId) as SpotRow | undefined;
  if (!spot) return null;
  const place = db.prepare('SELECT * FROM place WHERE id = ?').get(spot.place_id) as PlaceRow | undefined;
  return { spot, place: place ?? null };
}

export function requireSpotInLibrary(spotId: string, libraryId: string): SpotRow {
  const found = loadSpotRow(spotId);
  if (!found) throw errors.notFound('机位');
  if (found.spot.library_id !== libraryId) throw errors.scopeDenied();
  return found.spot;
}
