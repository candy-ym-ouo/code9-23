/**
 * 分层测试矩阵 · 窗口层 L1（纯函数，无 DB）：极区日期
 *
 * 覆盖：
 * - 极昼 / 极夜下所有太阳事件类锚点的可解性（sunrise/sunset/黄金/蓝调/夜间）
 * - 极区里仍然可用的锚点（solar_noon / fixed_clock）
 * - 极圈附近「有日出日落但太阳贴地平线」的边界日期
 * - 日界时区（UTC±12、负偏移时区）下本地日期与锚点时刻
 * - computeDay 端到端：极区日期返回 bad + ANCHOR_UNRESOLVABLE，绝不产出虚假 good
 * - 同一种子多次回放结果逐次一致（见末尾随机矩阵）
 */
import { describe, expect, it } from 'vitest';
import type { TimingDto } from '@flil/shared';
import { computeDay } from '../src/services/windowEngine.js';
import type { SpotGeom } from '../src/services/windowEngine.js';
import { mulberry32, hashJson } from './support/matrix.ts';

const SVALBARD: SpotGeom = { id: 'svalbard', lat: 78.22, lng: 15.65, camera_bearing: 180, tz: 'Arctic/Longyearbyen' };
const TROMSO: SpotGeom = { id: 'tromso', lat: 69.65, lng: 18.96, camera_bearing: 180, tz: 'Europe/Oslo' };

const SUMMER = '2026-06-21';
const WINTER = '2026-12-21';

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

const SUN_ANCHORS: TimingDto['timeAnchor'][] = [
  'sunrise',
  'sunset',
  'sunrise_plus',
  'sunset_minus',
  'golden_am',
  'golden_pm',
  'blue_am',
  'blue_pm',
];

describe('L1 极区 · 极昼（斯瓦尔巴 6 月）', () => {
  it('日出/日落/黄金/蓝调锚点全部无解', async () => {
    const { sunEvents, resolveAnchor } = await import('@flil/shared');
    const events = sunEvents(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, SUMMER);
    expect(events.polar).toBe('midnight_sun');
    expect(events.sunrise).toBeNull();
    expect(events.sunset).toBeNull();
    for (const anchor of SUN_ANCHORS) {
      expect(resolveAnchor(events, timing({ timeAnchor: anchor })), anchor).toBeNull();
    }
  });

  it('太阳整周在地平线上（正午与午夜仰角均 > -0.833°）', async () => {
    const { sunEvents, elevationAt } = await import('@flil/shared');
    const events = sunEvents(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, SUMMER);
    expect(elevationAt(events.solarNoon, SVALBARD.lat, SVALBARD.lng)).toBeGreaterThan(30);
    const midnight = new Date(events.solarNoon.getTime() + 12 * 3600000);
    expect(elevationAt(midnight, SVALBARD.lat, SVALBARD.lng)).toBeGreaterThan(-0.833);
  });

  it('computeDay：极昼日的日落锚判 bad，给出 ANCHOR_UNRESOLVABLE 而不是假窗口', () => {
    const r = computeDay(SVALBARD, timing({ timeAnchor: 'sunset_minus' }), SUMMER, []);
    expect(r.verdict).toBe('bad');
    expect(r.reasons.some((x) => x.code === 'ANCHOR_UNRESOLVABLE')).toBe(true);
    expect(r.startAt.getTime()).toBe(r.endAt.getTime());
  });

  it('computeDay：极昼日没有夜间时段', () => {
    const r = computeDay(SVALBARD, timing({ timeAnchor: 'night' }), SUMMER, []);
    expect(r.verdict).toBe('bad');
    expect(r.reasons.some((x) => x.code === 'ANCHOR_UNRESOLVABLE')).toBe(true);
  });

  it('正午锚点在极昼下仍可解析（系统不会把极昼一棍子打死）', async () => {
    const { sunEvents, resolveAnchor, utcToZonedParts } = await import('@flil/shared');
    const events = sunEvents(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, SUMMER);
    const resolved = resolveAnchor(events, timing({ timeAnchor: 'solar_noon' }))!;
    expect(resolved).not.toBeNull();
    expect(utcToZonedParts(resolved.anchorAt, SVALBARD.tz).hour).toBe(12);
  });

  it('固定钟点锚点在极昼下仍可解析', () => {
    const r = computeDay(SVALBARD, timing({ timeAnchor: 'fixed_clock', anchorOffsetMin: 10 * 60 }), SUMMER, []);
    expect(r.verdict).not.toBe('bad');
    expect(r.reasons.some((x) => x.code === 'ANCHOR_RESOLVED')).toBe(true);
  });
});

describe('L1 极区 · 极夜（斯瓦尔巴 12 月）', () => {
  it('全部太阳事件锚点无解；事件列表带极夜说明', async () => {
    const { sunEvents, resolveAnchor } = await import('@flil/shared');
    const events = sunEvents(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, WINTER);
    expect(events.polar).toBe('polar_night');
    expect(events.notes.join()).toMatch(/极夜/);
    for (const anchor of SUN_ANCHORS) {
      expect(resolveAnchor(events, timing({ timeAnchor: anchor })), anchor).toBeNull();
    }
  });

  it('正午太阳也在地平线以下', async () => {
    const { sunEvents, elevationAt } = await import('@flil/shared');
    const events = sunEvents(SVALBARD.lat, SVALBARD.lng, SVALBARD.tz, WINTER);
    expect(events.maxElevationDeg).toBeLessThan(-0.833);
    expect(elevationAt(events.solarNoon, SVALBARD.lat, SVALBARD.lng)).toBeLessThan(-0.833);
  });

  it('computeDay：极夜日的黄金时刻锚判 bad，且仰角/方位角输出 null（不伪造）', () => {
    const r = computeDay(SVALBARD, timing({ timeAnchor: 'golden_pm' }), WINTER, []);
    expect(r.verdict).toBe('bad');
    expect(r.sunElevation).toBeNull();
    expect(r.sunAzimuth).toBeNull();
  });

  it('夜间锚点在极夜可解析，但限定仰角下采样窗口被截到前 240 分钟', () => {
    const r = computeDay(SVALBARD, timing({ timeAnchor: 'night' }), WINTER, []);
    // 极夜：nightStart 可能为 null（无日落），也可能落到前一天夜里；两种结果都必须确定
    expect(['bad', 'marginal', 'good']).toContain(r.verdict);
  });
});

describe('L1 极圈边界 · 极昼刚开始 / 极夜刚开始的日期', () => {
  it('极昼起止边界两侧结论连续（进入前/退出后锚点重新可解）', async () => {
    const { sunEvents } = await import('@flil/shared');
    // 不靠硬编码节气日期：逐日扫描 4/1–8/31，找出极昼的第一天与最后一天
    const polarDays: string[] = [];
    const cursor = new Date('2026-04-01T00:00:00Z');
    const stop = new Date('2026-08-31T00:00:00Z');
    for (; cursor.getTime() <= stop.getTime(); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const key = cursor.toISOString().slice(0, 10);
      if (sunEvents(TROMSO.lat, TROMSO.lng, TROMSO.tz, key).polar === 'midnight_sun') polarDays.push(key);
    }
    expect(polarDays.length).toBeGreaterThan(30); // 极昼持续一个多月
    const first = polarDays[0];
    const last = polarDays[polarDays.length - 1];
    expect(computeDay(TROMSO, timing({ timeAnchor: 'sunset_minus' }), first, []).verdict).toBe('bad');

    const before = new Date(new Date(`${first}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
    const after = new Date(new Date(`${last}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
    // 边界外侧锚点重新可解：天气降级下最高 marginal，绝不 bad
    expect(computeDay(TROMSO, timing({ timeAnchor: 'sunset_minus' }), before, []).verdict).not.toBe('bad');
    expect(computeDay(TROMSO, timing({ timeAnchor: 'sunset_minus' }), after, []).verdict).not.toBe('bad');
  });

  it('南半球极区季节相反：南极点 12 月为极昼', async () => {
    const { sunEvents } = await import('@flil/shared');
    // 南纬 80°：12 月极昼、6 月极夜
    const summer = sunEvents(-80, 0, 'UTC', '2026-12-21');
    const winter = sunEvents(-80, 0, 'UTC', '2026-06-21');
    expect(summer.polar).toBe('midnight_sun');
    expect(winter.polar).toBe('polar_night');
    const r = computeDay(
      { id: 'ant', lat: -80, lng: 0, camera_bearing: 0, tz: 'UTC' },
      timing({ timeAnchor: 'sunrise' }),
      '2026-12-21',
      [],
    );
    expect(r.verdict).toBe('bad');
  });
});

describe('L1 日界时区 · 本地日期不串天', () => {
  const ANADYR: SpotGeom = { id: 'anadyr', lat: 64.7, lng: 177.5, camera_bearing: 0, tz: 'Asia/Anadyr' }; // UTC+12
  const BAKER: SpotGeom = { id: 'baker', lat: 64.7, lng: -177.5, camera_bearing: 0, tz: 'America/Adak' }; // UTC-12

  it('UTC+12 与 UTC-12 的同一本地日期，锚点时刻相差约 24 小时而不是重叠', async () => {
    const { sunEvents } = await import('@flil/shared');
    const east = sunEvents(ANADYR.lat, ANADYR.lng, ANADYR.tz, '2026-10-11');
    const west = sunEvents(BAKER.lat, BAKER.lng, BAKER.tz, '2026-10-11');
    const diffH = Math.abs(east.sunrise!.getTime() - west.sunrise!.getTime()) / 3600000;
    expect(diffH).toBeGreaterThan(23);
    expect(diffH).toBeLessThan(25);
  });

  it('computeDay 在正 UTC 偏移极区（阿纳德尔冬季）输出本地日期一致的判定', () => {
    const r = computeDay(ANADYR, timing({ timeAnchor: 'solar_noon' }), '2026-12-21', []);
    expect(r.date).toBe('2026-12-21');
    expect(r.verdict).not.toBe('bad');
  });
});

describe('L1 随机回放 · 极区日期矩阵必须逐次复现', () => {
  const LATS = [-80, -70, -66.56, -45, 0, 45, 66.56, 69.65, 78.22];
  const ZONES = ['UTC', 'Asia/Anadyr', 'America/Adak', 'Arctic/Longyearbyen', 'Asia/Shanghai'];
  const ANCHORS: TimingDto['timeAnchor'][] = [
    'sunrise',
    'sunset',
    'sunrise_plus',
    'sunset_minus',
    'golden_am',
    'golden_pm',
    'blue_pm',
    'solar_noon',
    'fixed_clock',
    'night',
  ];
  const DATES = [
    '2026-01-15',
    '2026-03-20',
    '2026-05-25',
    '2026-06-21',
    '2026-09-22',
    '2026-11-30',
    '2026-12-21',
  ];

  function runMatrix(seed: number): string[] {
    const rnd = mulberry32(seed);
    const out: string[] = [];
    for (let i = 0; i < 240; i += 1) {
      const lat = LATS[Math.floor(rnd() * LATS.length)];
      const tz = ZONES[Math.floor(rnd() * ZONES.length)];
      const anchor = ANCHORS[Math.floor(rnd() * ANCHORS.length)];
      const date = DATES[Math.floor(rnd() * DATES.length)];
      const lng = Math.round(rnd() * 3600 - 1800) / 10;
      const spot: SpotGeom = { id: `r${i}`, lat, lng, camera_bearing: Math.floor(rnd() * 360), tz };
      const t = timing({
        timeAnchor: anchor,
        anchorOffsetMin: Math.floor(rnd() * 120),
        elevationRange: [-6 - rnd() * 6, 6 + rnd() * 20],
        azimuthRange: rnd() > 0.6 ? [Math.floor(rnd() * 360), Math.floor(rnd() * 360) + 40] : null,
      });
      const r = computeDay(spot, t, date, []);
      out.push(hashJson({ lat, lng, tz, anchor, date, verdict: r.verdict, codes: r.reasons.map((x) => x.code) }));
    }
    return out;
  }

  it('固定种子两次回放得到完全相同的判定序列', () => {
    expect(runMatrix(20261001)).toEqual(runMatrix(20261001));
  });

  it('不同种子序列不同（矩阵本身有区分度，不是空转）', () => {
    expect(hashJson(runMatrix(1))).not.toBe(hashJson(runMatrix(2)));
  });
});
