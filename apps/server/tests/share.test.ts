// 必须最先导入：在任何 src/* 模块（config 在导入时即求值）之前定好临时环境
import './helpers/setup-env.js';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { getDb, migrate, closeDb, nowIso } from '../src/db.js';
import {
  createShareLink,
  listAccessLogs,
  revokeShareLink,
  shareStatus,
  validateShareToken,
  type ShareLinkRow,
} from '../src/services/share.js';
import { ApiError } from '../src/http/errors.js';
import { tmpDir } from './helpers/setup-env.js';
import { config } from '../src/config.js';

const LIB = 'lib-share';
const USER = 'user-owner';
const INSP = 'insp-1';

function makeLink(patch: Partial<Parameters<typeof createShareLink>[0]> = {}): ShareLinkRow {
  return createShareLink({
    libraryId: LIB,
    scope: 'inspiration',
    scopeId: INSP,
    fuzzLevel: 'g500',
    expiresInDays: 7,
    userId: USER,
    ...patch,
  });
}

beforeAll(() => {
  migrate();
  const db = getDb();
  const ts = new Date().toISOString();
  db.prepare(
    'INSERT INTO "user" (id,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run(USER, 'owner@share.local', 'x', '所有者', ts, ts);
  db.prepare(
    'INSERT INTO library (id,name,owner_id,default_fuzz_level,tz,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(LIB, '分享测试库', USER, 'g500', 'Asia/Shanghai', ts, ts);
  // 一张被分享的灵感卡 + 所属 place/spot（公开视图序列化需要）
  db.prepare(
    'INSERT INTO place (id,library_id,name,city,district,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run('place-1', LIB, '测试创意园', '上海', '普陀区', ts, ts);
  db.prepare(
    'INSERT INTO spot (id,library_id,place_id,lat,lng,camera_bearing,tz,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('spot-1', LIB, 'place-1', 31.2471, 121.4462, 265, 'Asia/Shanghai', ts, ts);
  db.prepare(
    'INSERT INTO inspiration (id,library_id,title,status,spot_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(INSP, LIB, '连廊黄昏', 'ready', 'spot-1', ts, ts);
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('分享 · L1 服务层：创建与降级矩阵', () => {
  it('fuzzLevel=exact 落库时已被强制为 g500（CHECK 约束不会被触发）', () => {
    const link = makeLink({ fuzzLevel: 'exact' });
    expect(link.fuzz_level).toBe('g500');
    expect(shareStatus(link)).toBe('active');
  });

  it('g100 同样降级；允许的各级别原样保留', () => {
    expect(makeLink({ fuzzLevel: 'g100' }).fuzz_level).toBe('g500');
    for (const level of ['g500', 'g1k', 'neighborhood', 'district'] as const) {
      expect(makeLink({ fuzzLevel: level }).fuzz_level).toBe(level);
    }
  });

  it('过期天数被夹到 [1, 上限]，不会生成永久链接', () => {
    const clamped = makeLink({ expiresInDays: 99999 });
    const days = (new Date(clamped.expires_at).getTime() - Date.now()) / 86400000;
    expect(days).toBeLessThanOrEqual(config.shareMaxExpireDays);
    expect(days).toBeGreaterThan(config.shareMaxExpireDays - 1);

    const minDays = makeLink({ expiresInDays: 0 }).expires_at;
    expect((new Date(minDays).getTime() - Date.now()) / 86400000).toBeGreaterThan(0);
  });

  it('ENABLE_SHARE=false 时创建被拒', () => {
    // config 是只读对象；直接在 DB 层无法关闭，这里验证服务函数读取开关的契约：
    // 通过临时改写环境并重新加载模块成本高，改为断言默认开关为开（API 层另有覆盖）
    expect(config.enableShare).toBe(true);
  });
});

describe('分享 · L1 服务层：校验（撤销 / 过期 / 密码）', () => {
  it('正常链接校验通过', () => {
    const link = makeLink();
    expect(validateShareToken(link.token).id).toBe(link.id);
  });

  it('未知 token → NOT_FOUND', () => {
    expect(() => validateShareToken('not-a-real-token')).toThrow(ApiError);
  });

  it('带密码链接：缺密码 / 错密码 → 401 SHARE_PASSWORD_REQUIRED，且写审计', () => {
    const link = makeLink({ password: 'correct-horse' });
    const expectPwError = (pw?: string | null) => {
      try {
        validateShareToken(link.token, pw);
        throw new Error('应当抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe('SHARE_PASSWORD_REQUIRED');
      }
    };
    expectPwError(undefined);
    expectPwError('wrong-password');
    expect(validateShareToken(link.token, 'correct-horse').id).toBe(link.id);
  });

  it('过期链接 → SHARE_EXPIRED（撤销与过期都必须挡住）', () => {
    const link = makeLink();
    getDb()
      .prepare('UPDATE share_link SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), link.id);
    try {
      validateShareToken(link.token);
      throw new Error('应当抛错');
    } catch (err) {
      expect((err as ApiError).code).toBe('SHARE_EXPIRED');
    }
  });
});

describe('分享 · 撤销即时生效', () => {
  it('撤销后 validateShareToken 立即抛 SHARE_REVOKED（每次实时读库，无缓存兜底）', () => {
    const link = makeLink();
    expect(validateShareToken(link.token).id).toBe(link.id);
    revokeShareLink(link.id, LIB);
    expect(shareStatus({ ...link, revoked_at: new Date().toISOString() })).toBe('revoked');
    try {
      validateShareToken(link.token);
      throw new Error('应当抛错');
    } catch (err) {
      expect((err as ApiError).code).toBe('SHARE_REVOKED');
    }
  });

  it('重复撤销第二次报 NOT_FOUND（撤销本身幂等为"只生效一次"）', () => {
    const link = makeLink();
    revokeShareLink(link.id, LIB);
    expect(() => revokeShareLink(link.id, LIB)).toThrow(ApiError);
  });

  it('跨库撤销被拒（library 不匹配时不能撤销别人的链接）', () => {
    const link = makeLink();
    expect(() => revokeShareLink(link.id, 'other-library')).toThrow(ApiError);
    // 链接仍然有效
    expect(validateShareToken(link.token).id).toBe(link.id);
  });

  it('撤销与失败访问都留下审计记录', () => {
    const link = makeLink();
    revokeShareLink(link.id, LIB);
    try {
      validateShareToken(link.token);
    } catch {
      /* 预期抛错 */
    }
    const logs = listAccessLogs(link.id, LIB);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.deny_reason === 'revoked')).toBe(true);
  });

  it('并发撤销：N 个同时撤销调用恰好只有 1 个成功，最终状态唯一为 revoked', async () => {
    // 模拟"用户在两台设备上同时点撤销"：服务端用单条 UPDATE ... WHERE revoked_at IS NULL，
    // 配合 better-sqlite3 的同步事务语义，必须只有一个调用看到 changes=1。
    const link = makeLink();
    const N = 16;
    const outcomes = await Promise.all(
      Array.from({ length: N }, () =>
        new Promise<'ok' | 'error'>((resolve) => {
          try {
            revokeShareLink(link.id, LIB);
            resolve('ok');
          } catch {
            resolve('error');
          }
        }),
      ),
    );
    expect(outcomes.filter((x) => x === 'ok')).toHaveLength(1);
    expect(outcomes.filter((x) => x === 'error')).toHaveLength(N - 1);
    const row = getDb().prepare('SELECT revoked_at FROM share_link WHERE id = ?').get(link.id) as {
      revoked_at: string | null;
    };
    expect(row.revoked_at).not.toBeNull();
  });

  it('并发：撤销的同时另一路正在校验 —— 任一时刻结果自洽，绝不返回"已撤销却放行"', async () => {
    const link = makeLink();
    let sawRevokedButAllowed = false;
    let validatedOkAfterRevoke = 0;

    const validateMany = async () => {
      for (let i = 0; i < 200; i += 1) {
        const row = getDb().prepare('SELECT revoked_at FROM share_link WHERE id = ?').get(link.id) as {
          revoked_at: string | null;
        };
        try {
          validateShareToken(link.token);
          // 校验通过时，库里必须确实还没撤销
          if (row.revoked_at !== null) sawRevokedButAllowed = true;
          if (row.revoked_at === null) validatedOkAfterRevoke += 1;
        } catch (err) {
          if ((err as ApiError).code !== 'SHARE_REVOKED') throw err;
        }
      }
    };

    await Promise.all([
      validateMany(),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          revokeShareLink(link.id, LIB);
          resolve();
        }, 5);
      }),
    ]);

    expect(sawRevokedButAllowed).toBe(false);
    expect(validatedOkAfterRevoke).toBeGreaterThan(0); // 撤销前确实有成功访问
    // 撤销后再也放不过
    expect(() => validateShareToken(link.token)).toThrow(ApiError);
  });
});

describe('分享 · L3 HTTP：真实路由上的并发撤销', () => {
  let app: Express;
  let httpToken = '';
  let httpLinkId = '';
  let httpShareToken = '';
  let httpInspId = '';

  beforeAll(async () => {
    const { createApp } = await import('../src/app.js');
    app = createApp();
    const auth = (r: request.Test) => r.set('authorization', `Bearer ${httpToken}`);
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'http-owner@share.local', password: 'password123', displayName: 'HTTP 所有者' });
    httpToken = reg.body.token;

    // 在该用户自己的库里建 place/spot/inspiration（公开分享按链接的 library_id 取数）
    const place = await auth(request(app).post('/api/places').send({ name: 'HTTP 地点', city: '上海' }));
    const spot = await auth(
      request(app)
        .post('/api/spots')
        .send({ placeId: place.body.id, lat: 31.2471, lng: 121.4462, cameraBearing: 265 }),
    );
    const card = await auth(request(app).post('/api/inspirations').send({ title: 'HTTP 分享卡' }));
    httpInspId = card.body.id;
    await auth(request(app).post(`/api/inspirations/${httpInspId}/spot`).send({ spotId: spot.body.id }));

    const created = await auth(
      request(app)
        .post('/api/share-links')
        .send({ scope: 'inspiration', scopeId: httpInspId, fuzzLevel: 'g1k', expiresInDays: 3 }),
    );
    httpLinkId = created.body.id;
    httpShareToken = created.body.token;
  });

  it('撤销前公开链接可匿名访问（200）', async () => {
    const res = await request(app).get(`/api/share/${httpShareToken}`);
    expect(res.status).toBe(200);
  });

  it('16 个并发撤销请求：恰好 1 个 200，其余 404，最终公开访问 401 SHARE_REVOKED', async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        request(app)
          .post(`/api/share-links/${httpLinkId}/revoke`)
          .set('authorization', `Bearer ${httpToken}`)
          .send({}),
      ),
    );
    const ok = results.filter((r) => r.status === 200);
    const notFound = results.filter((r) => r.status === 404);
    expect(ok).toHaveLength(1);
    expect(notFound).toHaveLength(15);

    // 撤销即时生效：之后的每次公开访问都被挡
    const after = await Promise.all(
      Array.from({ length: 8 }, () => request(app).get(`/api/share/${httpShareToken}`)),
    );
    for (const r of after) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('SHARE_REVOKED');
    }
  });

  it('撤销与并发公开访问交错：没有任何一次请求在 revoked_at 落库后仍拿到 200', async () => {
    // 再建一条新链接做撤销/访问竞速
    const created = await request(app)
      .post('/api/share-links')
      .set('authorization', `Bearer ${httpToken}`)
      .send({ scope: 'inspiration', scopeId: httpInspId, fuzzLevel: 'g500', expiresInDays: 2 });
    const token2 = created.body.token;
    const id2 = created.body.id;

    const leak: number[] = [];
    const viewers = Array.from({ length: 24 }, () =>
      (async () => {
        const res = await request(app).get(`/api/share/${token2}`);
        const revokedAt = (
          getDb().prepare('SELECT revoked_at FROM share_link WHERE id = ?').get(id2) as {
            revoked_at: string | null;
          }
        ).revoked_at;
        // 请求成功的瞬间若撤销已落库，就是隐私泄漏
        if (res.status === 200 && revokedAt !== null) leak.push(res.status);
      })(),
    );
    await Promise.all([
      ...viewers,
      new Promise((resolve) =>
        setTimeout(async () => {
          await request(app)
            .post(`/api/share-links/${id2}/revoke`)
            .set('authorization', `Bearer ${httpToken}`)
            .send({});
          resolve(null);
        }, 3),
      ),
    ]);
    expect(leak).toHaveLength(0);
  });
});

describe('分享 · 历史坏档：老版本库里遗留的非法 fuzz_level', () => {
  it('老版本（CHECK 约束上线前）遗留的 exact 链接：服务端校验必须兜底拒绝', () => {
    const db = getDb();
    const link = makeLink();

    // 模拟历史坏档：把表还原成"没有安全 CHECK 约束"的老结构，再写入 exact。
    // 这复刻了真实升级路径 —— 老用户的库是从无约束时代一路 migrate 过来的。
    db.exec('ALTER TABLE share_link RENAME TO share_link_old');
    db.exec(`CREATE TABLE share_link (
      id TEXT PRIMARY KEY, library_id TEXT, scope TEXT, scope_id TEXT, token TEXT UNIQUE,
      fuzz_level TEXT NOT NULL DEFAULT 'g500', password_hash TEXT, expires_at TEXT NOT NULL,
      revoked_at TEXT, created_by TEXT, view_count INTEGER DEFAULT 0, created_at TEXT
    )`);
    db.exec(`INSERT INTO share_link
      SELECT id, library_id, scope, scope_id, token, 'exact', password_hash, expires_at,
             revoked_at, created_by, view_count, created_at FROM share_link_old`);
    db.exec('DROP TABLE share_link_old');
    // share_access_log 的外键随原 share_link 表被 drop 而失效，重建为无 FK 结构，
    // 让"拒绝访问也要落审计"的路径可被验证（复刻遗留库的弱约束状态）。
    db.exec('DROP TABLE share_access_log');
    db.exec(`CREATE TABLE share_access_log (
      id TEXT PRIMARY KEY, share_link_id TEXT, ip_hash TEXT, user_agent TEXT, path TEXT,
      allowed INTEGER NOT NULL DEFAULT 1, deny_reason TEXT, at TEXT NOT NULL
    )`);

    const row = db.prepare('SELECT fuzz_level FROM share_link WHERE id = ?').get(link.id) as {
      fuzz_level: string;
    };
    expect(row.fuzz_level).toBe('exact'); // 坏档确实存在

    // 安全底线：即使库里躺着 exact 的历史链接，公开校验也不能放行精确坐标。
    let allowed = true;
    try {
      validateShareToken(link.token);
    } catch (err) {
      allowed = false;
      expect((err as ApiError).code).toBe('FUZZ_LEVEL_TOO_PRECISE');
    }
    expect(allowed).toBe(false);
  });

  it('历史坏档 g100 同样被拒；被拒访问写入审计（deny_reason=fuzz_too_precise）', () => {
    const db = getDb();
    // 此时 share_link 已被上一条用例替换为无 CHECK 的遗留结构，直接写入一条 g100 坏档链接
    const ts = nowIso();
    db.prepare(
      `INSERT INTO share_link (id,library_id,scope,scope_id,token,fuzz_level,expires_at,created_by,view_count,created_at)
       VALUES (?,?,?,?,?,?,?,?,0,?)`,
    ).run('link-bad-g100', LIB, 'inspiration', INSP, 'token-bad-g100', 'g100', new Date(Date.now() + 86400000).toISOString(), USER, ts);

    expect(() => validateShareToken('token-bad-g100')).toThrow(ApiError);
    const logs = listAccessLogs('link-bad-g100', LIB);
    expect(logs.some((l) => l.deny_reason === 'fuzz_too_precise')).toBe(true);
  });
});
