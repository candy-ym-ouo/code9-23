// L3 断网降级：必须最先导入，把 WEATHER_PROVIDER 固定为 off
import './helpers/setup-offline-env.js';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { migrate, closeDb } from '../src/db.js';
import { tmpDir } from './helpers/setup-offline-env.js';

let app: Express;
let token = '';
let cardId = '';
let spotId = '';

function call(method: 'get' | 'post' | 'put', url: string, body?: unknown) {
  let req = request(app)[method](url);
  if (token) req = req.set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

beforeAll(async () => {
  const { createApp } = await import('../src/app.js');
  migrate();
  app = createApp();

  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'offline@test.local', password: 'password123', displayName: '断网用户' });
  token = reg.body.token;

  const place = await call('post', '/api/places', { name: '断网地点', city: '上海' });
  const spot = await call('post', '/api/spots', {
    placeId: place.body.id,
    lat: 31.2471,
    lng: 121.4462,
    cameraBearing: 265,
  });
  spotId = spot.body.id;
  const card = await call('post', '/api/inspirations', { title: '断网窗口卡' });
  cardId = card.body.id;
  await call('post', `/api/inspirations/${cardId}/spot`, { spotId });
  await call('put', `/api/inspirations/${cardId}/timing`, {
    timeAnchor: 'sunset_minus',
    anchorOffsetMin: 40,
    elevationRange: [-4, 10],
    azimuthRange: null,
    azimuthTolerance: 15,
    windowToleranceMin: 12,
    weatherProfile: { precipProbPctMax: 20, cloudCoverPct: { min: 0, max: 30 } },
    seasonWindow: null,
    notes: null,
  });
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('窗口 · L3 断网降级（WEATHER_PROVIDER=off）', () => {
  it('健康检查明确报告天气源处于降级状态', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.weatherProvider).toBe('off');
    expect(res.body.weatherDegraded).toBe(true);
  });

  it('重算窗口全部标注 WEATHER_DEGRADED + weatherDegraded=true', async () => {
    const res = await call('post', `/api/inspirations/${cardId}/windows/recompute`, { days: 7 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(7);
    for (const w of res.body.items) {
      expect(w.weatherDegraded).toBe(true);
      expect(w.reasons.some((r: { code: string }) => r.code === 'WEATHER_DEGRADED')).toBe(true);
    }
  });

  it('降级后最高只能判到 marginal（天文完美也不会假装 good）', async () => {
    const res = await call('post', `/api/inspirations/${cardId}/windows/recompute`, { days: 7 });
    for (const w of res.body.items) {
      expect(['marginal', 'bad']).toContain(w.verdict);
      expect(w.verdict).not.toBe('good');
    }
  });

  it('降级理由明确写"未包含天气"，且没有一条天气项被判为通过/失败（全部缺席）', async () => {
    const res = await call('post', `/api/inspirations/${cardId}/windows/recompute`, { days: 3 });
    for (const w of res.body.items) {
      const degraded = w.reasons.find((r: { code: string }) => r.code === 'WEATHER_DEGRADED');
      expect(degraded.text).toMatch(/未包含天气|天气源不可用/);
      const codes = w.reasons.map((r: { code: string }) => r.code);
      expect(codes.some((c: string) => c.startsWith('PRECIP_') || c.startsWith('CLOUD_'))).toBe(false);
    }
  });

  it('断网结果对同一日期稳定复现（连算两次，判定与时刻一致）', async () => {
    const a = await call('post', `/api/inspirations/${cardId}/windows/recompute`, { days: 7 });
    const b = await call('post', `/api/inspirations/${cardId}/windows/recompute`, { days: 7 });
    const sig = (items: unknown[]) =>
      JSON.stringify(
        items.map((w) => ({
          v: (w as { verdict: string }).verdict,
          s: (w as { startAt: string }).startAt,
          c: (w as { reasons: { code: string }[] }).reasons.map((r) => r.code),
        })),
      );
    expect(sig(b.body.items)).toBe(sig(a.body.items));
  });
});
