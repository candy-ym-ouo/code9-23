import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TimingDto } from '@flil/shared';
import { computeDay } from '../src/services/windowEngine.js';
import type { HourlyForecast } from '../src/services/weather.js';

/**
 * 随机回放（deterministic replay）：
 * 用固定种子的 mulberry32 PRNG 生成"随机"输入（坐标 / 日期 / 锚点 / 容差 / 预报），
 * 对完整判定结果取 SHA-256 指纹。两次回放（同一进程 / 任何机器 / 任何日期执行）
 * 指纹必须完全一致 —— 这直接钉死"判定结果只能由输入决定"这一性质，
 * 任何悄悄混入 Date.now()、Math.random() 或非确定性迭代顺序的改动都会让测试变红。
 */

// -- 确定性 PRNG（不使用 Math.random，种子固定） --
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

const ANCHORS: TimingDto['timeAnchor'][] = [
  'sunrise',
  'sunset',
  'sunrise_plus',
  'sunset_minus',
  'golden_am',
  'golden_pm',
  'blue_am',
  'blue_pm',
  'solar_noon',
  'night',
  'fixed_clock',
];

const TZS = ['Asia/Shanghai', 'UTC', 'Europe/Oslo', 'America/Los_Angeles', 'Australia/Sydney'];
const DATES = [
  '2026-01-15',
  '2026-03-20',
  '2026-06-21',
  '2026-09-23',
  '2026-10-11',
  '2026-12-21',
  '2026-12-31',
];

interface Case {
  lat: number;
  lng: number;
  tz: string;
  date: string;
  timing: TimingDto;
  forecast: HourlyForecast[];
}

function makeCases(seed: number, count: number): Case[] {
  const rnd = mulberry32(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  const cases: Case[] = [];

  for (let i = 0; i < count; i += 1) {
    // 覆盖从南极到北极的纬度（含极区），经度跨 ±180°
    const lat = Math.round((-80 + rnd() * 160) * 1000) / 1000;
    const lng = Math.round((-180 + rnd() * 360) * 1000) / 1000;
    const tz = pick(TZS);
    const date = pick(DATES);
    const anchor = pick(ANCHORS);

    const timing: TimingDto = {
      timeAnchor: anchor,
      anchorOffsetMin: Math.floor(rnd() * 90),
      elevationRange: [Math.round((-10 + rnd() * 10) * 10) / 10, Math.round((20 + rnd() * 30) * 10) / 10],
      azimuthRange: rnd() < 0.5 ? null : [Math.floor(rnd() * 360), Math.floor(rnd() * 360)],
      azimuthTolerance: [5, 10, 15, 20, 30][Math.floor(rnd() * 5)],
      windowToleranceMin: [1, 5, 10, 12, 20, 30][Math.floor(rnd() * 6)],
      weatherProfile:
        rnd() < 0.5
          ? {}
          : {
              precipProbPctMax: [20, 50, 80][Math.floor(rnd() * 3)],
              ...(rnd() < 0.5 ? { cloudCoverPct: { min: 0, max: [20, 50, 80][Math.floor(rnd() * 3)] } } : {}),
              ...(rnd() < 0.2 ? { hardRequirements: ['precipProbPctMax', 'cloudCoverPct'] } : {}),
            },
      seasonWindow: rnd() < 0.2 ? { fromMonth: pick([1, 6, 11]), toMonth: pick([2, 8, 12]) } : null,
      notes: null,
    };

    // 一半场景给完整预报，一半断网（[]），把降级路径也纳入回放
    let forecast: HourlyForecast[] = [];
    if (rnd() >= 0.5) {
      forecast = [];
      const start = new Date(`${date}T00:00:00Z`);
      for (let h = 0; h < 48; h += 1) {
        forecast.push({
          time: new Date(start.getTime() + h * 3600000).toISOString(),
          cloudCoverPct: Math.floor(rnd() * 100),
          precipProbPct: Math.floor(rnd() * 100),
          precipMm: Math.round(rnd() * 3 * 10) / 10,
          visibilityKm: Math.round((1 + rnd() * 29) * 10) / 10,
          windSpeedMs: Math.round(rnd() * 12 * 10) / 10,
          tempC: Math.round((-10 + rnd() * 35) * 10) / 10,
          humidityPct: Math.floor(rnd() * 100),
          snowfallCm: rnd() < 0.05 ? Math.floor(rnd() * 5) : 0,
        });
      }
    }

    cases.push({ lat, lng, tz, date, timing, forecast });
  }
  return cases;
}

/** 只摘判定结果中"由输入决定"的字段（不碰 id / computedAt 等环境量） */
function fingerprintOf(cases: Case[]): string {
  const lines = cases.map((c, i) => {
    const r = computeDay(
      { id: `spot${i}`, lat: c.lat, lng: c.lng, camera_bearing: 0, tz: c.tz },
      c.timing,
      c.date,
      c.forecast,
    );
    return JSON.stringify({
      date: r.date,
      verdict: r.verdict,
      start: r.startAt.toISOString(),
      end: r.endAt.toISOString(),
      anchor: r.anchorAt.toISOString(),
      elev: r.sunElevation === null ? null : Math.round(r.sunElevation * 1e6) / 1e6,
      azim: r.sunAzimuth === null ? null : Math.round(r.sunAzimuth * 1e6) / 1e6,
      reasonCodes: r.reasons.map((x) => x.code),
      reasonTexts: r.reasons.map((x) => x.text),
      degraded: r.episode?.degraded ?? null,
    });
  });
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

const SEED = 20261002;
const N = 240;

describe('窗口 · 随机回放：结果必须稳定复现', () => {
  it('同一批种子输入回放两次，完整判定指纹逐字节一致', () => {
    const runA = makeCases(SEED, N);
    const runB = makeCases(SEED, N);
    // 先确认输入生成本身可复现（PRNG 不漂移）
    expect(JSON.stringify(runB)).toBe(JSON.stringify(runA));
    expect(fingerprintOf(runB)).toBe(fingerprintOf(runA));
  });

  it('240 组随机输入的黄金指纹（改动判定算法时需要人工确认变化再更新）', () => {
    const fingerprint = fingerprintOf(makeCases(SEED, N));
    expect(fingerprint).toBe('84757ee919cf9c3b29eeebda7b1004983619cecf2919f9524740be07934d0e66');
  });

  it('回放同时覆盖三类输出：正常判定 / 极区无解 / 断网降级', () => {
    const cases = makeCases(SEED, N);
    const verdicts = new Set<string>();
    let polarUnresolved = 0;
    let degraded = 0;
    cases.forEach((c, i) => {
      const r = computeDay(
        { id: `spot${i}`, lat: c.lat, lng: c.lng, camera_bearing: 0, tz: c.tz },
        c.timing,
        c.date,
        c.forecast,
      );
      verdicts.add(r.verdict);
      if (r.reasons.some((x) => x.code === 'ANCHOR_UNRESOLVABLE')) polarUnresolved += 1;
      if (r.episode?.degraded) degraded += 1;
    });
    expect(verdicts).toEqual(new Set(['good', 'marginal', 'bad']));
    expect(polarUnresolved).toBeGreaterThan(0);
    expect(degraded).toBeGreaterThan(0);
  });

  it('不同种子产出不同输入且判定结果随之不同（证明指纹确实在检验内容，而非空转）', () => {
    const fp1 = fingerprintOf(makeCases(SEED, 120));
    const fp2 = fingerprintOf(makeCases(SEED + 1, 120));
    expect(fp2).not.toBe(fp1);
  });
});
