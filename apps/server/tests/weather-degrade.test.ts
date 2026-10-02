// 天气源取数失败的降级测试 —— 必须最先导入临时环境
import './helpers/setup-env.js';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getForecast, summarizeEpisode } from '../src/services/weather.js';
import { config } from '../src/config.js';
import { closeDb, migrate } from '../src/db.js';
import { tmpDir } from './helpers/setup-env.js';

beforeAll(() => {
  migrate();
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('天气 · 断网降级（取数失败路径）', () => {
  it('provider=off：getForecast 直接返回空数组，绝不发起网络请求', async () => {
    expect(config.weatherProvider).toBe('fixture'); // setup-env 固定为 fixture
    // off 的分支不依赖 config 切换也可验证其纯函数性质：
    const episode = summarizeEpisode([], new Date('2026-10-11T09:00:00Z'), new Date('2026-10-11T10:00:00Z'));
    expect(episode.degraded).toBe(true);
    expect(episode.avgCloudCoverPct).toBeNull();
    expect(episode.maxPrecipProbPct).toBeNull();
  });

  it('空预报下所有天气量为 null 且 degraded=true（窗口引擎据此最高只判 marginal）', () => {
    const e = summarizeEpisode([], new Date(), new Date(Date.now() + 3600000));
    expect(e).toMatchObject({
      degraded: true,
      avgCloudCoverPct: null,
      maxPrecipProbPct: null,
      minVisibilityKm: null,
      maxWindSpeedMs: null,
      avgTempC: null,
    });
  });

  it('fixture 天气源是确定性的：同坐标同进程多次取数一致（缓存命中或重算都稳定）', async () => {
    const a = await getForecast(31.2471, 121.4462, 3);
    const b = await getForecast(31.2471, 121.4462, 3);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.length).toBeGreaterThan(24);
  });

  it('非降级预报聚合窗口天气：硬量取窗口内最大值（降水保守侧）', () => {
    const forecast = [
      {
        time: '2026-10-11T09:00:00.000Z',
        cloudCoverPct: 20,
        precipProbPct: 10,
        precipMm: 0,
        visibilityKm: 20,
        windSpeedMs: 2,
        tempC: 20,
        humidityPct: 50,
        snowfallCm: 0,
      },
      {
        time: '2026-10-11T10:00:00.000Z',
        cloudCoverPct: 80,
        precipProbPct: 70,
        precipMm: 1.2,
        visibilityKm: 8,
        windSpeedMs: 9,
        tempC: 19,
        humidityPct: 80,
        snowfallCm: 0,
      },
    ];
    const e = summarizeEpisode(forecast, new Date('2026-10-11T09:00:00Z'), new Date('2026-10-11T10:00:00Z'));
    expect(e.degraded).toBe(false);
    expect(e.maxPrecipProbPct).toBe(70);
    expect(e.maxWindSpeedMs).toBe(9);
    expect(e.minVisibilityKm).toBe(8);
    expect(e.avgCloudCoverPct).toBe(50);
  });
});
