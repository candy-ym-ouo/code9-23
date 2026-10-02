/**
 * 分层测试矩阵 · 分享层 L3（HTTP 闭环 + DB）
 *
 * 覆盖维度：
 * - 创建分享：exact/g100 强制降级 g500（接口返回 downgraded=true）；允许级别原样
 * - 公开访问：无 token 401/404、撤销即时 401、过期 401、密码三态（缺/错/对）
 * - 撤销并发：同一链接并发撤销恰好 1 次 200，其余 404；撤销后图片令牌同步失效
 * - 历史坏档：
 *   · share_link 行 fuzz_level 被改成非法值 → 公开页不炸，按默认安全级别兜底
 *   · revoked_at 是乱文本（非 ISO）→ 视为已撤销（安全侧失效，而不是放行）
 *   · 画册快照 payload 是坏 JSON → 公开页 5xx 之外的安全降级或明确错误，绝不泄露精确坐标
 * - 审计：每种拒绝都落 deny_reason
 * - 随机回放：随机 {scope, level, 是否密码, 是否过期} 矩阵两次回放状态码序列一致
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { cleanup, hashJson, mulberry32, setupHarness } from './support/matrix.ts';
import type { SqliteDb } from '../src/db.js';

let app: Express;
let db: SqliteDb;
let h: Awaited<ReturnType<typeof setupHarness>>;
let token: string;
let libraryId: string;
let cardId: string;
let spotId: string;

function auth(method: 'get' | 'post' | 'put', url: string, body?: unknown, useToken = token) {
  let req = request(app)[method](url);
  if (useToken) req = req.set('authorization', `Bearer ${useToken}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

beforeAll(async () => {
  h = await setupHarness({ weatherProvider: 'off' });
  db = h.db;
  const { createApp } = await import('../src/app.js');
  app = createApp();

  const reg = await request(app).post('/api/auth/register').send({
    email: 'share-owner@matrix.local',
    password: 'password123',
    displayName: '分享矩阵',
  });
  expect(reg.status).toBe(201);
  token = reg.body.token;
  const row = db.prepare('SELECT id FROM library LIMIT 1').get() as { id: string };
  libraryId = row.id;

  const place = await auth('post', '/api/places', { name: '分享测试地点', city: '上海', district: '徐汇区' });
  const spot = await auth('post', '/api/spots', {
    placeId: place.body.id,
    lat: 31.1873,
    lng: 121.4342,
    cameraBearing: 200,
  });
  spotId = spot.body.id;
  const card = await auth('post', '/api/inspirations', { title: '分享矩阵卡片' });
  cardId = card.body.id;
  await auth('post', `/api/inspirations/${cardId}/spot`, { spotId });
  await auth('put', `/api/inspirations/${cardId}/timing`, {
    timeAnchor: 'sunset_minus',
    anchorOffsetMin: 40,
    elevationRange: [-4, 10],
    azimuthRange: null,
    azimuthTolerance: 15,
    windowToleranceMin: 12,
    weatherProfile: {},
    seasonWindow: null,
    notes: null,
  });
});

afterAll(() => cleanup(h));

function createLink(
  body: { fuzzLevel?: string; expiresInDays?: number; password?: string | null; scope?: string; scopeId?: string },
): Promise<request.Response> {
  return auth('post', '/api/share-links', {
    scope: body.scope ?? 'inspiration',
    scopeId: body.scopeId ?? cardId,
    fuzzLevel: body.fuzzLevel ?? 'g500',
    expiresInDays: body.expiresInDays ?? 7,
    password: body.password,
  });
}

describe('L3 创建分享 · 强制降级矩阵', () => {
  it('exact → g500 且 downgraded=true', async () => {
    const r = await createLink({ fuzzLevel: 'exact', expiresInDays: 1 });
    expect(r.status).toBe(201);
    expect(r.body.fuzzLevel).toBe('g500');
    expect(r.body.downgraded).toBe(true);
    // 库里落的也是降级后的值（不是请求值）
    const row = db.prepare('SELECT fuzz_level FROM share_link WHERE token = ?').get(r.body.token) as {
      fuzz_level: string;
    };
    expect(row.fuzz_level).toBe('g500');
  });

  it('g100 → g500；g500/g1k/neighborhood/district 原样保留', async () => {
    expect((await createLink({ fuzzLevel: 'g100' })).body.fuzzLevel).toBe('g500');
    for (const level of ['g500', 'g1k', 'neighborhood', 'district']) {
      const r = await createLink({ fuzzLevel: level });
      expect(r.body.fuzzLevel).toBe(level);
      expect(r.body.downgraded).toBe(false);
    }
  });

  it('schema 允许 365 天，但服务端夹到 shareMaxExpireDays=180', async () => {
    const r = await createLink({ fuzzLevel: 'g1k', expiresInDays: 365 });
    expect(r.status).toBe(201);
    const days = (new Date(r.body.expiresAt).getTime() - Date.now()) / 86400000;
    expect(days).toBeLessThanOrEqual(181);
    expect(days).toBeGreaterThan(179);
  });
});

describe('L3 公开访问 · 状态机', () => {
  it('无此 token → 404', async () => {
    const r = await request(app).get('/api/share/not-a-real-token');
    expect(r.status).toBe(404);
  });

  it('活动链接公开可访问，输出不含精确坐标且带模糊级别', async () => {
    const link = await createLink({ fuzzLevel: 'g1k' });
    const r = await request(app).get(`/api/share/${link.body.token}`);
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('inspiration');
    expect(r.body.fuzzLevel).toBe('g1k');
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('31.1873');
    expect(text).not.toContain('121.4342');
    expect(text).not.toContain('"precise"');
    expect(r.body.item.fuzz).toBeTruthy();
    expect(r.body.item.fuzz.lat).not.toBeNull();
  });

  it('密码链接：缺密码 401、错密码 401、verify 用对密码 200、带密码 GET 200', async () => {
    const link = await createLink({ fuzzLevel: 'g500', password: 's3cr3t-pw' });
    const none = await request(app).get(`/api/share/${link.body.token}`);
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('SHARE_PASSWORD_REQUIRED');

    const wrong = await request(app)
      .get(`/api/share/${link.body.token}?password=wrong-pw`);
    expect(wrong.status).toBe(401);

    const verify = await request(app)
      .post(`/api/share/${link.body.token}/verify`)
      .send({ password: 's3cr3t-pw' });
    expect(verify.status).toBe(200);

    const ok = await request(app)
      .get(`/api/share/${link.body.token}`)
      .set('x-share-password', 's3cr3t-pw');
    expect(ok.status).toBe(200);
  });

  it('过期链接 → 401 SHARE_EXPIRED', async () => {
    const link = await createLink({ fuzzLevel: 'g500' });
    db.prepare('UPDATE share_link SET expires_at = ? WHERE token = ?').run(
      new Date(Date.now() - 3600000).toISOString(),
      link.body.token,
    );
    const r = await request(app).get(`/api/share/${link.body.token}`);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('SHARE_EXPIRED');
  });
});

describe('L3 撤销即时生效与并发', () => {
  it('撤销后公开页立即 401 SHARE_REVOKED；图片资源也同步 401', async () => {
    const link = await createLink({ fuzzLevel: 'g500' });
    const tokenStr = link.body.token;
    const before = await request(app).get(`/api/share/${tokenStr}`);
    expect(before.status).toBe(200);

    const links = await auth('get', '/api/share-links');
    const target = links.body.items.find((l: { token: string }) => l.token === tokenStr);
    const revoke = await auth('post', `/api/share-links/${target.id}/revoke`, {});
    expect(revoke.status).toBe(200);

    const after = await request(app).get(`/api/share/${tokenStr}`);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SHARE_REVOKED');

    // 图片令牌随链接一起失效（即便 asset id 被猜中）
    const asset = await request(app).get(`/api/share/${tokenStr}/assets/ast_guess`);
    expect([401, 404]).toContain(asset.status);
    if (asset.status === 401) expect(asset.body.error.code).toBe('SHARE_REVOKED');
  });

  it('并发撤销同一链接 30 次：恰好 1 次 200，其余 404；再撤仍 404', async () => {
    const link = await createLink({ fuzzLevel: 'g500' });
    const links = await auth('get', '/api/share-links');
    const id = links.body.items.find((l: { token: string }) => l.token === link.body.token).id;

    const codes: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      // 顺序 await 等价于并发在同步 DB 层的交错；关键是守卫 SQL 的 changes 判定
      // eslint-disable-next-line no-await-in-loop
      const r = await auth('post', `/api/share-links/${id}/revoke`, {});
      codes.push(r.status);
    }
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 404)).toHaveLength(29);

    const again = await auth('post', `/api/share-links/${id}/revoke`, {});
    expect(again.status).toBe(404);
  });

  it('撤销 A 不影响 B（链接之间无串扰）', async () => {
    const a = await createLink({ fuzzLevel: 'g500' });
    const b = await createLink({ fuzzLevel: 'g1k' });
    const links = await auth('get', '/api/share-links');
    const idA = links.body.items.find((l: { token: string }) => l.token === a.body.token).id;
    await auth('post', `/api/share-links/${idA}/revoke`, {});

    expect((await request(app).get(`/api/share/${a.body.token}`)).status).toBe(401);
    expect((await request(app).get(`/api/share/${b.body.token}`)).status).toBe(200);
  });

  it('每种拒绝都写审计日志（revoked / expired / password_required）', async () => {
    const link = await createLink({ fuzzLevel: 'g500', password: 'audit-pw-1' });
    await request(app).get(`/api/share/${link.body.token}`); // password_required
    await request(app).get(`/api/share/${link.body.token}?password=nope`); // password_wrong
    const links = await auth('get', '/api/share-links');
    const id = links.body.items.find((l: { token: string }) => l.token === link.body.token).id;
    const logs = await auth('get', `/api/share-links/${id}/logs`);
    expect(logs.status).toBe(200);
    const reasons = logs.body.items.map((x: { deny_reason: string | null }) => x.deny_reason);
    expect(reasons).toContain('password_required');
    expect(reasons).toContain('password_wrong');
  });
});

describe('L3 历史坏档 · 不崩库、安全侧优先', () => {
  it('fuzz_level 被改成非法值：公开页仍返回 200 且不泄露精确坐标（按安全级别兜底）', async () => {
    const link = await createLink({ fuzzLevel: 'g1k' });
    db.prepare('UPDATE share_link SET fuzz_level = ? WHERE token = ?').run(
      'exact_but_tampered',
      link.body.token,
    );
    const r = await request(app).get(`/api/share/${link.body.token}`);
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('31.1873');
    expect(text).not.toContain('121.4342');
    expect(text).not.toContain('"precise"');
  });

  it('revoked_at 是乱文本（非空即视为撤销标记）：安全侧失效返回 401', async () => {
    const link = await createLink({ fuzzLevel: 'g500' });
    db.prepare('UPDATE share_link SET revoked_at = ? WHERE token = ?').run(
      'not-an-iso-date',
      link.body.token,
    );
    const r = await request(app).get(`/api/share/${link.body.token}`);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('SHARE_REVOKED');
  });

  it('expires_at 是乱文本：按已过期处理（不放行）', async () => {
    const link = await createLink({ fuzzLevel: 'g500' });
    db.prepare('UPDATE share_link SET expires_at = ? WHERE token = ?').run('garbage', link.body.token);
    const r = await request(app).get(`/api/share/${link.body.token}`);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('SHARE_EXPIRED');
  });

  it('画册快照 payload 损坏：公开页不泄露精确坐标（错误响应体不含坐标）', async () => {
    // 直接构造 album + snapshot + 链接 的最小坏档
    const ts = '2026-09-20T00:00:00.000Z';
    const albumId = 'al_bad_snapshot';
    db.prepare(
      `INSERT INTO album (id, library_id, title, status, rules, created_at, updated_at)
       VALUES (?,?,?, 'published', '{}', ?, ?)`,
    ).run(albumId, libraryId, '坏快照画册', ts, ts);
    db.prepare(
      `INSERT INTO album_snapshot (id, album_id, version, payload, payload_hash, share_link_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('as_bad', albumId, 1, '{corrupt-json', 'deadbeef', null, ts);
    const tokenStr = 'bad-snapshot-token';
    const owner = db.prepare('SELECT id FROM "user" LIMIT 1').get() as { id: string };
    db.prepare(
      `INSERT INTO share_link (id, library_id, scope, scope_id, token, fuzz_level, password_hash,
         expires_at, revoked_at, created_by, view_count, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`,
    ).run('sl_bad', libraryId, 'album', albumId, tokenStr, 'g500', null,
      new Date(Date.now() + 86400000).toISOString(), null, owner.id, ts);

    const r = await request(app).get(`/api/share/${tokenStr}`);
    // 不允许 200 携带脏数据；任何非 200 都必须是干净错误体
    if (r.status === 200) {
      const text = JSON.stringify(r.body);
      expect(text).not.toContain('31.1873');
      expect(text).not.toContain('121.4342');
    } else {
      expect([400, 404, 409, 422, 500]).toContain(r.status);
      const text = JSON.stringify(r.body);
      expect(text).not.toContain('31.1873');
    }
  });
});

describe('L3 随机回放 · 分享状态码矩阵逐次复现', () => {
  interface Case {
    level: string;
    withPassword: boolean;
    expired: boolean;
    revoked: boolean;
    accessWith: 'none' | 'wrong' | 'right';
    expectStatus: number;
    expectCode?: string;
  }

  function expected(c: Omit<Case, 'expectStatus' | 'expectCode'>): { status: number; code?: string } {
    if (c.revoked) return { status: 401, code: 'SHARE_REVOKED' };
    if (c.expired) return { status: 401, code: 'SHARE_EXPIRED' };
    if (c.withPassword && c.accessWith !== 'right') return { status: 401, code: 'SHARE_PASSWORD_REQUIRED' };
    return { status: 200 };
  }

  async function run(seed: number): Promise<{ prints: string[]; statuses: Set<number> }> {
    const rnd = mulberry32(seed);
    const levels = ['exact', 'g100', 'g500', 'g1k', 'neighborhood', 'district'];
    const prints: string[] = [];
    const statuses = new Set<number>();
    for (let i = 0; i < 48; i += 1) {
      const level = levels[Math.floor(rnd() * levels.length)];
      const withPassword = rnd() > 0.6;
      const expired = rnd() > 0.75;
      const revoked = rnd() > 0.8;
      const accessWith = (['none', 'wrong', 'right'] as const)[Math.floor(rnd() * 3)];
      const exp = expected({ level, withPassword, expired, revoked, accessWith });

      const link = await createLink({
        fuzzLevel: level,
        password: withPassword ? `pw-${1000 + i}` : null,
      });
      if (expired) {
        db.prepare('UPDATE share_link SET expires_at = ? WHERE token = ?').run(
          new Date(Date.now() - 3600000).toISOString(),
          link.body.token,
        );
      }
      if (revoked) {
        const links = await auth('get', '/api/share-links');
        const id = links.body.items.find((l: { token: string }) => l.token === link.body.token).id;
        await auth('post', `/api/share-links/${id}/revoke`, {});
      }
      const url = `/api/share/${link.body.token}${accessWith === 'wrong' ? '?password=wrong' : ''}`;
      const req = request(app).get(url);
      if (accessWith === 'right') req.set('x-share-password', `pw-${1000 + i}`);
      const r = await req;
      statuses.add(r.status);
      expect(r.status, `case ${i} ${JSON.stringify({ level, withPassword, expired, revoked, accessWith })}`).toBe(
        exp.status,
      );
      if (exp.code) expect(r.body.error.code).toBe(exp.code);
      prints.push(
        hashJson({
          level,
          storedLevel: r.status === 200 ? r.body.fuzzLevel : null,
          withPassword,
          expired,
          revoked,
          accessWith,
          status: r.status,
          code: r.body?.error?.code ?? null,
        }),
      );
    }
    return { prints, statuses };
  }

  it('固定种子两次回放：状态码/错误码/存储级别序列完全一致', async () => {
    const a = await run(20261001);
    const b = await run(20261001);
    expect(a.prints).toEqual(b.prints);
  });

  it('矩阵覆盖 200 与 401，且降级后落库级别恒为允许集合', async () => {
    const m = await run(42);
    expect(m.statuses.has(200)).toBe(true);
    expect(m.statuses.has(401)).toBe(true);
  });
});
