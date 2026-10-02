/**
 * 分层测试矩阵 · 断网降级层 L2（weather + windowEngine + DB）
 *
 * 覆盖维度：
 * - WEATHER_PROVIDER=off：getForecast 直接空数组（不碰网、不落缓存）
 * - 空预报 → summarizeEpisode 全 null + degraded
 * - 降级判定：天文好的一天最高 marginal 且标注「未含天气」；
 *   天文本身不成立的一天仍然 bad（降级不能救命）
 * - fixture 源：有预报、不降级；缓存命中与首次内容一致
 * - 随机回放：随机条件 × {降级, 有预报} 矩阵两次回放逐项一致
 */
import { describe, expect, it } from 'vitest';
import type { TimingDto } from '@flil/shared';
import { cleanup, hashJson, mulberry32, setupHarness, windowFingerprint } from './support/matrix.ts';
import { computeDay } from '../src/services/windowEngine.js';
import type { SpotGeom } from '../src/services/windowEngine.js';
import type { HourlyForecast } from '../src/services/weather.js';

const SPOT: SpotGeom = { id: 'spot1', lat: 31.2471, lng: 121.4462, camera_bearing: 265, tz: 'Asia/Shanghai' };
const DATE = '2026-10-11';

function timing(patch: Partial<TimingDto> = {}): TimingDto {
  return {
    timeAnchor: 'sunset_minus',
    anchorOffsetMin: 40,
    elevationRange: [-4, 10],
    azimuthRange: null,
    azimuthTolerance: 15,
    windowToleranceMin: 12,
    weatherProfile: {},
    seasonWindow: null,
    notes: null,
    ...patch,
  };
}

function forecast(overrides: Partial<HourlyForecast> = {}): HourlyForecast[] {
  return Array.from({ length: 48 }, (_, i) => ({
    time: new Date(new Date('2026-10-11T00:00:00Z').getTime() + i * 3600000).toISOString(),
    cloudCoverPct: 30,
    precipProbPct: 5,
    precipMm: 0,
    visibilityKm: 20,
    windSpeedMs: 3,
    tempC: 20,
    humidityPct: 55,
    snowfallCm: 0,
    ...overrides,
  }));
}

type WeatherMod = typeof import('../src/services/weather.js');
type H = Awaited<ReturnType<typeof setupHarness>>;

/** 每个用例用独立的临时库与 provider 配置（resetModules 保证 config 重新读取 env）。 */
async function withProvider<T>(
  provider: 'off' | 'fixture',
  fn: (h: H, weather: WeatherMod) => Promise<T> | T,
): Promise<T> {
  const h = await setupHarness({ weatherProvider: provider });
  try {
    const weather = (await import('../src/services/weather.js')) as WeatherMod;
    return await fn(h, weather);
  } finally {
    cleanup(h);
  }
}

describe('L2 断网降级 · provider=off', () => {
  it('getForecast 直接返回空数组且不落缓存', async () => {
    await withProvider('off', async (h, weather) => {
      const got = await weather.getForecast(31.24, 121.44, 7);
      expect(got).toEqual([]);
      const rows = h.db.prepare('SELECT COUNT(*) AS n FROM weather_cache').get() as { n: number };
      expect(rows.n).toBe(0);
    });
  });

  it('summarizeEpisode 空预报：degraded=true 且所有指标为 null', () =>
    withProvider('off', (_h, weather) => {
      const ep = weather.summarizeEpisode([], new Date('2026-10-11T09:00:00Z'), new Date('2026-10-11T10:00:00Z'));
      expect(ep.degraded).toBe(true);
      expect(ep.provider).toBe('off');
      expect(ep.avgCloudCoverPct).toBeNull();
      expect(ep.maxPrecipProbPct).toBeNull();
      expect(ep.maxWindSpeedMs).toBeNull();
      expect(ep.minVisibilityKm).toBeNull();
    }));

  it('天文条件成立 → 降级日最高 marginal，并明确标注未含天气', () =>
    withProvider('off', () => {
      const r = computeDay(SPOT, timing(), DATE, []);
      expect(r.verdict).toBe('marginal');
      expect(r.reasons.some((x) => x.code === 'WEATHER_DEGRADED')).toBe(true);
      expect(r.episode?.degraded).toBe(true);
      expect(r.reasons.some((x) => x.code === 'PRECIP_FAIL')).toBe(false);
    }));

  it('降级不能救命：天文本身不成立（仰角越界）时仍判 bad，且理由先于降级给出', () =>
    withProvider('off', () => {
      const r = computeDay(SPOT, timing({ elevationRange: [60, 70] }), DATE, []);
      expect(r.verdict).toBe('bad');
      expect(r.reasons.some((x) => x.code === 'ELEVATION_MISS')).toBe(true);
      // 提前返回路径上不会有天气理由（没有伪造 episode）
      expect(r.episode).toBeNull();
    }));

  it('降级日硬性降水规则被跳过：不出现 PRECIP_FAIL，绝不把雨天风险伪装成 bad 之外的好结果', () =>
    withProvider('off', () => {
      const r = computeDay(
        SPOT,
        timing({ weatherProfile: { precipProbPctMax: 20, hardRequirements: ['precipProbPctMax'] } }),
        DATE,
        [],
      );
      expect(r.verdict).toBe('marginal');
      const codes = r.reasons.map((x) => x.code);
      expect(codes).not.toContain('PRECIP_FAIL');
      expect(codes).toContain('WEATHER_DEGRADED');
    }));
});

describe('L2 断网恢复 · provider=fixture', () => {
  it('有预报：episode 不降级，指标非空', () =>
    withProvider('fixture', async (_h, weather) => {
      const got = await weather.getForecast(31.24, 121.44, 3);
      expect(got.length).toBeGreaterThan(24);
      const ep = weather.summarizeEpisode(
        got,
        new Date('2026-10-11T09:00:00Z'),
        new Date('2026-10-11T10:00:00Z'),
      );
      expect(ep.degraded).toBe(false);
      expect(ep.avgCloudCoverPct).not.toBeNull();
    }));

  it('同一坐标连续取数结果一致（缓存命中与首次内容相同）', () =>
    withProvider('fixture', async (_h, weather) => {
      const first = await weather.getForecast(31.24, 121.44, 3);
      const second = await weather.getForecast(31.24, 121.44, 3);
      expect(second).toEqual(first);
    }));

  it('恢复网络后雨天硬性项重新生效（同一条件：降级 marginal，有预报且暴雨 → bad）', () =>
    withProvider('fixture', () => {
      // 直接构造覆盖窗口当日 UTC 的预报（不经过 fixture 源，避免依赖系统当天日期）
      const rainy = forecast().map((f) => {
        const h = new Date(f.time).getUTCHours();
        return h >= 8 && h <= 12 ? { ...f, precipProbPct: 95, precipMm: 3 } : f;
      });
      const t = timing({ weatherProfile: { precipProbPctMax: 20 } });
      const online = computeDay(SPOT, t, DATE, rainy);
      expect(online.verdict).toBe('bad');
      expect(online.reasons.some((x) => x.code === 'PRECIP_FAIL')).toBe(true);

      const offline = computeDay(SPOT, t, DATE, []);
      expect(offline.verdict).toBe('marginal');
    }));
});

describe('L2 随机回放 · 降级/在线双模式判定矩阵逐次复现', () => {
  function matrix(seed: number): { prints: string[]; verdicts: Set<string>; degradedRows: number } {
    const rnd = mulberry32(seed);
    const profiles: TimingDto['weatherProfile'][] = [
      {},
      { precipProbPctMax: 20 },
      { cloudCoverPct: { min: 10, max: 50 } },
      { precipProbPctMax: 30, windSpeedMax: 6, visibilityKmMin: 10, hardRequirements: ['precipProbPctMax'] },
    ];
    const prints: string[] = [];
    const verdicts = new Set<string>();
    let degradedRows = 0;
    for (let i = 0; i < 160; i += 1) {
      const degraded = rnd() > 0.5;
      if (degraded) degradedRows += 1;
      const t = timing({
        windowToleranceMin: 5 + Math.floor(rnd() * 30),
        elevationRange: [-10 - rnd() * 10, 5 + rnd() * 30],
        azimuthRange: rnd() > 0.7 ? [Math.floor(rnd() * 300), 40 + Math.floor(rnd() * 20)] : null,
        weatherProfile: profiles[Math.floor(rnd() * profiles.length)],
      });
      const fc = degraded
        ? []
        : forecast({ precipProbPct: Math.floor(rnd() * 100), cloudCoverPct: Math.floor(rnd() * 100) });
      const r = computeDay(SPOT, t, DATE, fc);
      verdicts.add(r.verdict);
      prints.push(windowFingerprint(r));
    }
    return { prints, verdicts, degradedRows };
  }

  it('固定种子两次回放完全一致', () => {
    expect(matrix(20261001).prints).toEqual(matrix(20261001).prints);
  });

  it('矩阵同时覆盖 good/marginal/bad 三种结论与两种天气状态', () => {
    const m = matrix(7);
    expect(m.verdicts).toEqual(new Set(['bad', 'marginal', 'good']));
    expect(m.degradedRows).toBeGreaterThan(0);
    expect(m.degradedRows).toBeLessThan(160);
    expect(new Set(m.prints).size).toBeGreaterThan(8);
    expect(hashJson(m.prints)).toBe(hashJson(matrix(7).prints));
  });
});
