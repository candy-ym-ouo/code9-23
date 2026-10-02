import { describe, expect, it } from 'vitest';
import type { TimingDto } from '@flil/shared';
import { computeDay } from '../src/services/windowEngine.js';
import type { HourlyForecast } from '../src/services/weather.js';

// 两处真实极区坐标：
// - 朗伊尔城（斯瓦尔巴，78.22N / 15.65E，Europe/Oslo 时区）：
//     夏至前后极昼、冬至前后极夜，是"太阳事件整天不存在"的典型场景。
// - 中山站（南极，69.37S / 76.37E）：季节与北半球相反，验证南半球极区与跨年日期。
const LONGYEAR = { id: 'svalbard', lat: 78.22, lng: 15.65, camera_bearing: 180, tz: 'Europe/Oslo' };
const ZHONGSHAN = { id: 'antarctic', lat: -69.37, lng: 76.37, camera_bearing: 0, tz: 'UTC' };

function timing(patch: Partial<TimingDto> = {}): TimingDto {
  return {
    timeAnchor: 'sunset_minus',
    anchorOffsetMin: 40,
    elevationRange: [-90, 90],
    azimuthRange: null,
    azimuthTolerance: 15,
    windowToleranceMin: 12,
    weatherProfile: {},
    seasonWindow: null,
    notes: null,
    ...patch,
  };
}

/** 确定性空/晴好预报：极区测试只关心天文项，预报取值必须恒定、不依赖外网 */
function sunnyForecast(): HourlyForecast[] {
  const out: HourlyForecast[] = [];
  const start = new Date('2026-06-20T00:00:00Z');
  for (let i = 0; i < 96; i += 1) {
    out.push({
      time: new Date(start.getTime() + i * 3600000).toISOString(),
      cloudCoverPct: 10,
      precipProbPct: 0,
      precipMm: 0,
      visibilityKm: 30,
      windSpeedMs: 2,
      tempC: -5,
      humidityPct: 50,
      snowfallCm: 0,
    });
  }
  return out;
}

describe('窗口 · 极区日期：极昼', () => {
  it('朗伊尔城 2026-06-21 极昼：日落类锚点解析失败 → bad + ANCHOR_UNRESOLVABLE，而不是产出错误时刻', () => {
    const r = computeDay(LONGYEAR, timing({ timeAnchor: 'sunset_minus' }), '2026-06-21', sunnyForecast());
    expect(r.verdict).toBe('bad');
    expect(r.reasons.some((x) => x.code === 'ANCHOR_UNRESOLVABLE')).toBe(true);
    expect(r.reasons.some((x) => x.text.includes('极昼'))).toBe(true);
  });

  it('极昼日日出锚点同样无解（sunrise / sunrise_plus 都不能假装有日出）', () => {
    for (const anchor of ['sunrise', 'sunrise_plus'] as const) {
      const r = computeDay(LONGYEAR, timing({ timeAnchor: anchor }), '2026-06-21', sunnyForecast());
      expect(r.verdict).toBe('bad');
      expect(r.reasons.some((x) => x.code === 'ANCHOR_UNRESOLVABLE')).toBe(true);
    }
  });

  it('极昼日黄金/蓝调/夜间锚点均无解', () => {
    for (const anchor of ['golden_am', 'golden_pm', 'blue_am', 'blue_pm', 'night'] as const) {
      const r = computeDay(LONGYEAR, timing({ timeAnchor: anchor }), '2026-06-21', sunnyForecast());
      expect(r.verdict).toBe('bad');
      expect(r.reasons.some((x) => x.code === 'ANCHOR_UNRESOLVABLE')).toBe(true);
    }
  });

  it('极昼日固定钟点/正午锚点仍可解析（不依赖日出日落事件）', () => {
    for (const anchor of ['fixed_clock', 'solar_noon'] as const) {
      const r = computeDay(
        LONGYEAR,
        timing({ timeAnchor: anchor, anchorOffsetMin: 12 * 60, elevationRange: [-90, 90] }),
        '2026-06-21',
        sunnyForecast(),
      );
      expect(r.verdict).not.toBe('bad');
      expect(r.reasons.some((x) => x.code === 'ANCHOR_RESOLVED')).toBe(true);
    }
  });

  it('极昼判定结果对同一日期稳定复现（连算两次，时刻与理由逐项一致）', () => {
    const a = computeDay(LONGYEAR, timing({ timeAnchor: 'sunset' }), '2026-06-21', sunnyForecast());
    const b = computeDay(LONGYEAR, timing({ timeAnchor: 'sunset' }), '2026-06-21', sunnyForecast());
    expect(JSON.stringify({ v: a.verdict, r: a.reasons, t: a.anchorAt.toISOString() })).toBe(
      JSON.stringify({ v: b.verdict, r: b.reasons, t: b.anchorAt.toISOString() }),
    );
  });
});

describe('窗口 · 极区日期：极夜', () => {
  it('朗伊尔城 2026-12-21 极夜：日落锚点无解 → bad', () => {
    const r = computeDay(LONGYEAR, timing({ timeAnchor: 'sunset_minus' }), '2026-12-21', []);
    expect(r.verdict).toBe('bad');
    expect(r.reasons.some((x) => x.code === 'ANCHOR_UNRESOLVABLE')).toBe(true);
    expect(r.reasons.some((x) => x.text.includes('极夜'))).toBe(true);
  });

  it('极夜日即使给了完美晴好预报，也不能被天气项"救回"（天文项先判死）', () => {
    const r = computeDay(
      LONGYEAR,
      timing({
        timeAnchor: 'golden_pm',
        weatherProfile: { cloudCoverPct: { min: 0, max: 100 }, precipProbPctMax: 100 },
      }),
      '2026-12-21',
      sunnyForecast(),
    );
    expect(r.verdict).toBe('bad');
    expect(r.reasons[0]?.code).not.toBe('WEATHER_DEGRADED');
  });

  it('极夜日固定钟点可解析，但仰角区间要求日照时判 bad（ELEVATION_MISS 给出实测值）', () => {
    const r = computeDay(
      LONGYEAR,
      timing({ timeAnchor: 'fixed_clock', anchorOffsetMin: 12 * 60, elevationRange: [10, 30] }),
      '2026-12-21',
      [],
    );
    expect(r.verdict).toBe('bad');
    const miss = r.reasons.find((x) => x.code === 'ELEVATION_MISS');
    expect(miss).toBeTruthy();
    expect(miss?.text).toMatch(/实测/);
    // 正午太阳也在地平线以下
    expect(r.sunElevation).not.toBeNull();
    expect(r.sunElevation!).toBeLessThan(-0.833);
  });
});

describe('窗口 · 极区日期：南半球与跨年', () => {
  it('南极中山站 12 月为极昼（与斯瓦尔巴季节相反）', () => {
    const r = computeDay(ZHONGSHAN, timing({ timeAnchor: 'sunset' }), '2026-12-21', []);
    expect(r.verdict).toBe('bad');
    expect(r.reasons.some((x) => x.code === 'ANCHOR_UNRESOLVABLE')).toBe(true);
  });

  it('南极中山站 6 月为极夜', () => {
    const r = computeDay(ZHONGSHAN, timing({ timeAnchor: 'sunrise' }), '2026-06-21', []);
    expect(r.verdict).toBe('bad');
    expect(r.reasons.some((x) => x.code === 'ANCHOR_UNRESOLVABLE')).toBe(true);
  });

  it('极区跨年日期（2026-12-31 → 2027-01-01）极昼判定一致，不被日界切断', () => {
    const endOfYear = computeDay(ZHONGSHAN, timing({ timeAnchor: 'sunset' }), '2026-12-31', []);
    const newYear = computeDay(ZHONGSHAN, timing({ timeAnchor: 'sunset' }), '2027-01-01', []);
    expect(endOfYear.verdict).toBe('bad');
    expect(newYear.verdict).toBe('bad');
    expect(endOfYear.reasons.some((x) => x.code === 'ANCHOR_UNRESOLVABLE')).toBe(true);
    expect(newYear.reasons.some((x) => x.code === 'ANCHOR_UNRESOLVABLE')).toBe(true);
  });

  it('极昼/极夜边界附近（春秋分前后）锚点恢复可解析，不会永久卡在极区分支', () => {
    // 2026-03-20 春分前后，朗伊尔城刚结束极夜，应有日出
    const r = computeDay(LONGYEAR, timing({ timeAnchor: 'sunrise', elevationRange: [-90, 90] }), '2026-04-01', []);
    expect(r.reasons.some((x) => x.code === 'ANCHOR_RESOLVED')).toBe(true);
  });
});

describe('窗口 · 极区日期：季节窗口与极区叠加', () => {
  it('季节窗口外的极昼日优先报 OUT_OF_SEASON（短路顺序稳定）', () => {
    const r = computeDay(
      LONGYEAR,
      timing({ timeAnchor: 'sunset', seasonWindow: { fromMonth: 1, toMonth: 2 } }),
      '2026-06-21',
      [],
    );
    expect(r.verdict).toBe('bad');
    // sunEvents 的极昼提示（info）先入列，随后季节短路；关键是 OUT_OF_SEASON 先于一切锚点判定
    const codes = r.reasons.map((x) => x.code);
    expect(codes).toContain('OUT_OF_SEASON');
    expect(codes).not.toContain('ANCHOR_UNRESOLVABLE');
    expect(codes).not.toContain('ANCHOR_RESOLVED');
  });

  it('跨年季节窗口（11–2 月）在极夜的 12 月仍能进入锚点解析并报极夜无解', () => {
    const r = computeDay(
      LONGYEAR,
      timing({ timeAnchor: 'sunset', seasonWindow: { fromMonth: 11, toMonth: 2 } }),
      '2026-12-21',
      [],
    );
    expect(r.verdict).toBe('bad');
    expect(r.reasons.some((x) => x.code === 'ANCHOR_UNRESOLVABLE')).toBe(true);
  });
});
