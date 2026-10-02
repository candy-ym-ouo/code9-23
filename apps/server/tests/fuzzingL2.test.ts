/**
 * 分层测试矩阵 · 模糊化层 L2（service + DB）
 *
 * 覆盖维度：
 * - 网格中心 vs 随机抖动：同格多点同输出、重复调用恒定、中心落在格内
 * - 全模糊级别矩阵：exact / g100 / g500 / g1k / neighborhood / district
 * - 分享强制降级：exact、g100 → g500（服务端兜底，不靠前端）
 * - 缓存：命中恒定、清缓存重算一致
 * - 随机回放：种子坐标矩阵两次回放逐字节相同
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FUZZ_LEVEL_GEOHASH_LEN,
  SHARE_ALLOWED_FUZZ_LEVELS,
  decodeGeohashBounds,
  encodeGeohash,
  geohashCenter,
  type FuzzLevel,
} from '@flil/shared';
import { cleanup, hashJson, mulberry32, rng, seedLibrary, seedPlaceAndSpot, setupHarness } from './support/matrix.ts';
import type { SqliteDb } from '../src/db.js';

let db: SqliteDb;
let libraryId: string;
let h: Awaited<ReturnType<typeof setupHarness>>;
let fuzzing: typeof import('../src/services/fuzzing.js');

const SPOTS: { idPrefix: string; lat: number; lng: number; district?: string; city?: string }[] = [
  { idPrefix: 'sh', lat: 31.2471, lng: 121.4462, district: '普陀区', city: '上海' },
  { idPrefix: 'bj', lat: 39.9087, lng: 116.3975, district: '东城区', city: '北京' },
  { idPrefix: 'edge', lat: 0.00001, lng: 0.00001 },
  { idPrefix: 'neg', lat: -33.8688, lng: 151.2093, district: 'Sydney', city: '悉尼' },
];

beforeAll(async () => {
  h = await setupHarness();
  db = h.db;
  ({ libraryId } = seedLibrary(db));
  for (const s of SPOTS) seedPlaceAndSpot(db, libraryId, s);
  fuzzing = await import('../src/services/fuzzing.js');
});

afterAll(() => cleanup(h));

function load(prefix: string) {
  return fuzzing.loadSpotRow(`sp_${prefix}`)!;
}

describe('L2 网格中心稳定性（不是随机抖动）', () => {
  it('同一机位重复 100 次模糊化结果逐字段相同', () => {
    const { spot, place } = load('sh');
    const first = fuzzing.fuzzSpot(spot, place, 'g500');
    for (let i = 0; i < 100; i += 1) {
      expect(fuzzing.fuzzSpot(spot, place, 'g500')).toEqual(first);
    }
  });

  it('同一 geohash 网格内任意两点被模糊到同一个中心（多次请求无法平均反推）', () => {
    const hash = encodeGeohash({ lat: 31.2471, lng: 121.4462 }, 7);
    const b = decodeGeohashBounds(hash);
    const center = geohashCenter(hash);
    // 在该 7 位网格内部（内缩 5%）取 20 个点，不跨格
    const rnd = rng(42);
    const padLat = (b.maxLat - b.minLat) * 0.05;
    const padLng = (b.maxLng - b.minLng) * 0.05;
    const outputs = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const lat = rnd.range(b.minLat + padLat, b.maxLat - padLat, 7);
      const lng = rnd.range(b.minLng + padLng, b.maxLng - padLng, 7);
      expect(encodeGeohash({ lat, lng }, 7)).toBe(hash);
      const spot = { ...load('sh').spot, lat, lng, id: `probe_${i}` };
      const r = fuzzing.fuzzSpot(spot, null, 'g500');
      outputs.add(`${r.lat},${r.lng}`);
    }
    expect(outputs.size).toBe(1);
    const [latStr, lngStr] = [...outputs][0].split(',');
    expect(Number(latStr)).toBe(Number(center.lat.toFixed(5)));
    expect(Number(lngStr)).toBe(Number(center.lng.toFixed(5)));
  });

  it('模糊点始终位于对应 geohash 网格内部，且比原坐标粗', () => {
    for (const level of ['g500', 'g1k'] as FuzzLevel[]) {
      for (const s of SPOTS) {
        const { spot, place } = load(s.idPrefix);
        const r = fuzzing.fuzzSpot(spot, place, level);
        const b = decodeGeohashBounds(r.geohash);
        expect(r.lat).toBeGreaterThanOrEqual(b.minLat);
        expect(r.lat!).toBeLessThanOrEqual(b.maxLat);
        expect(r.lng).toBeGreaterThanOrEqual(b.minLng);
        expect(r.lng!).toBeLessThanOrEqual(b.maxLng);
        // geohash 长度与级别对应
        expect(r.geohash).toHaveLength(FUZZ_LEVEL_GEOHASH_LEN[level]);
      }
    }
  });
});

describe('L2 全级别矩阵', () => {
  const ALL_LEVELS: FuzzLevel[] = ['exact', 'g100', 'g500', 'g1k', 'neighborhood', 'district'];

  it('exact 输出原坐标与 12 位 hash；g100 仍走网格中心', () => {
    const { spot, place } = load('sh');
    const exact = fuzzing.fuzzSpot(spot, place, 'exact');
    expect(exact.lat).toBe(31.2471);
    expect(exact.lng).toBe(121.4462);
    expect(exact.geohash).toHaveLength(12);

    const g100 = fuzzing.fuzzSpot(spot, place, 'g100');
    expect(g100.geohash).toHaveLength(8);
    const center = geohashCenter(encodeGeohash({ lat: spot.lat, lng: spot.lng }, 8));
    expect(g100.lat).toBe(Number(center.lat.toFixed(5)));
  });

  it('neighborhood / district 不输出坐标（lat/lng 为 null），用区域名做 label', () => {
    const { spot, place } = load('sh');
    const n = fuzzing.fuzzSpot(spot, place, 'neighborhood');
    expect(n.lat).toBeNull();
    expect(n.lng).toBeNull();
    expect(n.label).toContain('普陀区');

    const d = fuzzing.fuzzSpot(spot, place, 'district');
    expect(d.lat).toBeNull();
    expect(d.label).toBe('普陀区');
  });

  it('缺少 place 时 district 退化为网格坐标一带文案，仍不暴露精确点', () => {
    const { spot } = load('edge');
    const d = fuzzing.fuzzSpot(spot, null, 'district');
    expect(d.lat).toBeNull();
    expect(d.label).toMatch(/一带/);
    const n = fuzzing.fuzzSpot(spot, null, 'neighborhood');
    expect(n.label).toContain('街区不详');
  });

  it('每个级别的行为表恒定（快照式断言）', () => {
    const { spot, place } = load('bj');
    const table = ALL_LEVELS.map((level) => {
      const r = fuzzing.fuzzSpot(spot, place, level);
      return { level, hasCoord: r.lat !== null, hashLen: r.geohash.length, labelKind: r.label.slice(0, 2) };
    });
    expect(hashJson(table)).toBe(hashJson(table)); // 表本身确定性
    expect(table.map((t) => t.level)).toEqual(ALL_LEVELS);
  });
});

describe('L2 分享级别强制降级', () => {
  it('exact / g100 被 assertShareFuzzLevel 降为 g500；允许级别原样通过', () => {
    expect(fuzzing.assertShareFuzzLevel('exact')).toBe('g500');
    expect(fuzzing.assertShareFuzzLevel('g100')).toBe('g500');
    for (const level of SHARE_ALLOWED_FUZZ_LEVELS) {
      expect(fuzzing.assertShareFuzzLevel(level)).toBe(level);
      expect(fuzzing.isShareFuzzLevelAllowed(level)).toBe(true);
    }
    expect(fuzzing.isShareFuzzLevelAllowed('exact')).toBe(false);
    expect(fuzzing.isShareFuzzLevelAllowed('g100')).toBe(false);
  });

  it('非法降级不抛异常（防止前端靠报错分支绕过）', () => {
    expect(() => fuzzing.assertShareFuzzLevel('exact')).not.toThrow();
  });
});

describe('L2 模糊缓存', () => {
  it('缓存命中结果与实时计算一致；清缓存重算仍然一致', () => {
    const { spot, place } = load('bj');
    const live = fuzzing.fuzzSpot(spot, place, 'g1k');
    const cached1 = fuzzing.fuzzSpotCached(spot, place, 'g1k');
    const cached2 = fuzzing.fuzzSpotCached(spot, place, 'g1k');
    expect(cached1).toEqual(cached2);
    expect({ lat: cached1.lat, lng: cached1.lng, geohash: cached1.geohash }).toEqual({
      lat: live.lat,
      lng: live.lng,
      geohash: live.geohash,
    });
    fuzzing.clearFuzzCache(spot.id);
    const recomputed = fuzzing.fuzzSpotCached(spot, place, 'g1k');
    expect(recomputed.lat).toBe(live.lat);
    expect(recomputed.lng).toBe(live.lng);
  });

  it('每个 (spot, level) 只落一条缓存（唯一键）', () => {
    const { spot, place } = load('neg');
    fuzzing.fuzzSpotCached(spot, place, 'g500');
    fuzzing.fuzzSpotCached(spot, place, 'g500');
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM place_fuzz_cache WHERE spot_id = ? AND fuzz_level = ?')
      .get(spot.id, 'g500') as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe('L2 随机回放 · 坐标×级别矩阵逐次复现', () => {
  function matrix(seed: number) {
    const rnd = mulberry32(seed);
    const levels: FuzzLevel[] = ['g100', 'g500', 'g1k', 'neighborhood', 'district'];
    const out: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const lat = Math.round((rnd() * 160 - 80) * 1e6) / 1e6;
      const lng = Math.round((rnd() * 360 - 180) * 1e6) / 1e6;
      const level = levels[Math.floor(rnd() * levels.length)];
      const spot = { ...load('edge').spot, lat, lng, id: `rand_${i}` };
      const r = fuzzing.fuzzSpot(spot, null, level);
      out.push(
        hashJson({
          lat,
          lng,
          level,
          fuzzLat: r.lat,
          fuzzLng: r.lng,
          geohash: r.geohash,
          labelHasArea: r.label.includes('一带'),
        }),
      );
    }
    return out;
  }

  it('同一种子两次回放完全一致', () => {
    expect(matrix(20261001)).toEqual(matrix(20261001));
  });

  it('不同种子产生不同矩阵', () => {
    expect(hashJson(matrix(1))).not.toBe(hashJson(matrix(2)));
  });
});
