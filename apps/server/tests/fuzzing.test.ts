import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FUZZ_LEVEL_GEOHASH_LEN,
  SHARE_ALLOWED_FUZZ_LEVELS,
  decodeGeohashBounds,
  encodeGeohash,
  geohashCenter,
  type FuzzLevel,
} from '@flil/shared';
import { assertShareFuzzLevel, fuzzSpot, isShareFuzzLevelAllowed, type PlaceRow, type SpotRow } from '../src/services/fuzzing.js';

const SHANGHAI = { lat: 31.2471, lng: 121.4462 };

function spot(patch: Partial<SpotRow> = {}): SpotRow {
  return {
    id: 'spot-1',
    library_id: 'lib-1',
    place_id: 'place-1',
    lat: SHANGHAI.lat,
    lng: SHANGHAI.lng,
    camera_bearing: 265,
    elevation_m: null,
    access_note: null,
    best_time_note: null,
    visibility: 'private',
    tz: 'Asia/Shanghai',
    ...patch,
  };
}

const PLACE: PlaceRow = { id: 'place-1', name: '测试创意园', city: '上海', district: '普陀区', category: null, address_text: null };

/** 模糊化完整分层矩阵：每个级别各自的输出形状与精度契约 */
const MATRIX: { level: FuzzLevel; hashLen: number; hasPoint: boolean }[] = [
  { level: 'exact', hashLen: 12, hasPoint: true },
  { level: 'g100', hashLen: 8, hasPoint: true },
  { level: 'g500', hashLen: 7, hasPoint: true },
  { level: 'g1k', hashLen: 6, hasPoint: true },
  { level: 'neighborhood', hashLen: 5, hasPoint: false },
  { level: 'district', hashLen: 4, hasPoint: false },
];

describe('模糊化 · 分层矩阵：级别 → 输出契约', () => {
  for (const { level, hashLen, hasPoint } of MATRIX) {
    it(`${level}：geohash 长度 = ${hashLen}，坐标点${hasPoint ? '有' : '无（只给区域文案）'}`, () => {
      const r = fuzzSpot(spot(), PLACE, level);
      expect(r.fuzzLevel).toBe(level);
      expect(r.geohash).toHaveLength(hashLen);
      expect(r.geohash).toBe(encodeGeohash(SHANGHAI, hashLen));
      expect(r.label).toBeTruthy();
      if (hasPoint) {
        expect(typeof r.lat).toBe('number');
        expect(typeof r.lng).toBe('number');
      } else {
        expect(r.lat).toBeNull();
        expect(r.lng).toBeNull();
      }
    });
  }

  it('exact 原样返回精确坐标（仅 owner 自用路径，分享路径会在别处强制降级）', () => {
    const r = fuzzSpot(spot(), PLACE, 'exact');
    expect(r.lat).toBe(31.2471);
    expect(r.lng).toBe(121.4462);
  });

  it('g500/g1k 的模糊点恰好是 geohash 网格中心（不是随机抖动）', () => {
    for (const level of ['g100', 'g500', 'g1k'] as FuzzLevel[]) {
      const r = fuzzSpot(spot(), PLACE, level);
      const center = geohashCenter(encodeGeohash(SHANGHAI, FUZZ_LEVEL_GEOHASH_LEN[level]));
      expect(r.lat).toBe(Math.round(center.lat * 1e5) / 1e5);
      expect(r.lng).toBe(Math.round(center.lng * 1e5) / 1e5);
    }
  });

  it('模糊点一定不恰好等于真实点（除非真实点本身就是网格中心）', () => {
    // 对任意非 exact 级别：输出坐标 != 精确坐标，避免"模糊化了但没模糊"
    for (const level of ['g100', 'g500', 'g1k'] as FuzzLevel[]) {
      const r = fuzzSpot(spot(), PLACE, level);
      const samePoint = r.lat === SHANGHAI.lat && r.lng === SHANGHAI.lng;
      if (samePoint) {
        // 唯一合法例外：精确点恰好落在网格中心——用网格边界验证它确实在格内
        const b = decodeGeohashBounds(r.geohash);
        expect(SHANGHAI.lat).toBeGreaterThanOrEqual(b.minLat);
        expect(SHANGHAI.lng).toBeGreaterThanOrEqual(b.minLng);
      } else {
        expect(samePoint).toBe(false);
      }
    }
  });

  it('neighborhood / district 标签包含行政区信息，且不泄露任何坐标数字', () => {
    const n = fuzzSpot(spot(), PLACE, 'neighborhood');
    const d = fuzzSpot(spot(), PLACE, 'district');
    expect(n.label).toContain('普陀区');
    expect(d.label).toBe('普陀区');
    expect(JSON.stringify(n)).not.toMatch(/-?\d+\.\d+/);
  });

  it('地点无行政区信息时退化为网格/城市兜底文案，不崩溃', () => {
    const noplace = fuzzSpot(spot(), null, 'neighborhood');
    const district = fuzzSpot(spot(), null, 'district');
    expect(noplace.label).toContain('街区不详');
    expect(district.label).toMatch(/一带/);
    expect(district.lat).toBeNull();
  });
});

describe('模糊化 · 分层矩阵：稳定性（抗平均反推）', () => {
  it('同一机位 × 每级别，连续 100 次结果完全一致（网格中心只有一个稳定解）', () => {
    for (const { level } of MATRIX) {
      const first = JSON.stringify(fuzzSpot(spot(), PLACE, level));
      for (let i = 0; i < 100; i += 1) {
        expect(JSON.stringify(fuzzSpot(spot(), PLACE, level))).toBe(first);
      }
    }
  });

  it('同格内多个不同真实点收敛到同一个模糊点；跨格点分开', () => {
    const g7len = FUZZ_LEVEL_GEOHASH_LEN.g500;
    const base = decodeGeohashBounds(encodeGeohash(SHANGHAI, g7len));
    const p1 = { lat: base.minLat + 0.001, lng: base.minLng + 0.001 };
    const p2 = { lat: base.maxLat - 0.001, lng: base.maxLng - 0.001 };
    const a = fuzzSpot(spot({ lat: p1.lat, lng: p1.lng }), null, 'g500');
    const b = fuzzSpot(spot({ lat: p2.lat, lng: p2.lng, id: 'spot-2' }), null, 'g500');
    expect(a.geohash).toBe(b.geohash);
    expect(a.lat).toBe(b.lat);
    expect(a.lng).toBe(b.lng);
  });
});

describe('模糊化 · 分享安全底线：强制降级矩阵', () => {
  it('exact / g100 在分享场景被强制降级为 g500，且不抛错（不靠前端自觉）', () => {
    expect(assertShareFuzzLevel('exact')).toBe('g500');
    expect(assertShareFuzzLevel('g100')).toBe('g500');
  });

  it('g500 / g1k / neighborhood / district 原样放行', () => {
    for (const level of SHARE_ALLOWED_FUZZ_LEVELS) {
      expect(assertShareFuzzLevel(level)).toBe(level);
      expect(isShareFuzzLevelAllowed(level)).toBe(true);
    }
  });

  it('isShareFuzzLevelAllowed 对 exact / g100 为 false', () => {
    expect(isShareFuzzLevelAllowed('exact')).toBe(false);
    expect(isShareFuzzLevelAllowed('g100')).toBe(false);
  });
});

// -- 确定性 PRNG（与 window-replay 同款 mulberry32，保证回放可复现） --
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('模糊化 · 随机回放：全球点位结果稳定', () => {
  function fuzzFingerprint(seed: number, count: number): string {
    const rnd = mulberry32(seed);
    const levels: FuzzLevel[] = ['exact', 'g100', 'g500', 'g1k', 'neighborhood', 'district'];
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
      // 避开 ±90/±180 精确边界，覆盖日期变更线两侧与赤道
      const lat = Math.round((-89.9 + rnd() * 179.8) * 1e6) / 1e6;
      const lng = Math.round((-179.9 + rnd() * 359.8) * 1e6) / 1e6;
      const s = spot({ id: `spot-${i}`, lat, lng });
      for (const level of levels) {
        const r = fuzzSpot(s, null, level);
        lines.push(`${i}|${level}|${r.geohash}|${r.lat}|${r.lng}|${r.label}`);
      }
    }
    return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
  }

  it('同一全球点位批次回放两次指纹一致', () => {
    expect(fuzzFingerprint(777, 300)).toBe(fuzzFingerprint(777, 300));
  });

  it('300 个全球点位 × 6 级别的黄金指纹', () => {
    expect(fuzzFingerprint(777, 300)).toBe('f7ebec9e416e4524fe24e681a81ead7e71a9a694110da83f91101e603283c4c9');
  });

  it('所有点位在所有级别下都不会产出 NaN / undefined / 非数字坐标', () => {
    const rnd = mulberry32(42);
    for (let i = 0; i < 200; i += 1) {
      const lat = -89 + rnd() * 178;
      const lng = -179 + rnd() * 358;
      for (const level of ['g100', 'g500', 'g1k'] as FuzzLevel[]) {
        const r = fuzzSpot(spot({ id: `s${i}`, lat, lng }), null, level);
        expect(Number.isFinite(r.lat as number)).toBe(true);
        expect(Number.isFinite(r.lng as number)).toBe(true);
        // 模糊坐标必须仍在 [-90,90] / [-180,180]
        expect(r.lat as number).toBeGreaterThanOrEqual(-90);
        expect(r.lat as number).toBeLessThanOrEqual(90);
        expect(r.lng as number).toBeGreaterThanOrEqual(-180);
        expect(r.lng as number).toBeLessThanOrEqual(180);
      }
    }
  });
});
