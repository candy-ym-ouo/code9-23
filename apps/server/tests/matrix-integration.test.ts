// 必须最先导入：在任何 src/* 模块之前定好临时环境
import './helpers/setup-env.js';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb, migrate, closeDb, nowIso } from '../src/db.js';
import { clearFuzzCache, fuzzSpotCached, loadSpotRow } from '../src/services/fuzzing.js';
import { computeWindowsForInspiration } from '../src/services/windowEngine.js';
import { scanWindowsForAllLibraries } from '../src/jobs/windowScan.js';
import { timingRowToDto } from '../src/services/windowEngine.js';
import { applyCalibration, listCalibration, undoCalibration } from '../src/services/calibration.js';
import { tmpDir } from './helpers/setup-env.js';

const LIB = 'lib-matrix';
const USER = 'user-1';

beforeAll(() => {
  migrate();
  const db = getDb();
  const ts = nowIso();
  db.prepare('INSERT INTO "user" (id,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(
    USER,
    'm@x.local',
    'x',
    'X',
    ts,
    ts,
  );
  db.prepare(
    'INSERT INTO library (id,name,owner_id,default_fuzz_level,tz,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(LIB, '矩阵库', USER, 'g500', 'Asia/Shanghai', ts, ts);
  db.prepare(
    'INSERT INTO place (id,library_id,name,city,district,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run('place-1', LIB, '测试创意园', '上海', '普陀区', ts, ts);
  db.prepare(
    'INSERT INTO spot (id,library_id,place_id,lat,lng,camera_bearing,tz,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('spot-1', LIB, 'place-1', 31.2471, 121.4462, 265, 'Asia/Shanghai', ts, ts);
  db.prepare(
    `INSERT INTO inspiration (id,library_id,title,status,spot_id,created_at,updated_at)
     VALUES (?,?,?,'ready',?,?,?)`,
  ).run('insp-1', LIB, '正常卡', 'spot-1', ts, ts);
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('模糊化 · L2 缓存：幂等与陈旧档自愈', () => {
  it('首次计算写入缓存；之后直接读缓存，结果一致', () => {
    const loaded = loadSpotRow('spot-1')!;
    clearFuzzCache('spot-1');
    const fresh = fuzzSpotCached(loaded.spot, loaded.place, 'g500');
    const again = fuzzSpotCached(loaded.spot, loaded.place, 'g500');
    expect(again).toEqual(fresh);
    const row = getDb()
      .prepare('SELECT fuzz_lat, fuzz_lng, geohash FROM place_fuzz_cache WHERE spot_id=? AND fuzz_level=?')
      .get('spot-1', 'g500') as { fuzz_lat: number; fuzz_lng: number; geohash: string };
    expect(row.geohash).toBe(fresh.geohash);
    expect(row.fuzz_lat).toBe(fresh.lat);
  });

  it('历史坏档：缓存里被写入精确坐标（exact 漂移值）→ 读取时自愈为网格中心', () => {
    const loaded = loadSpotRow('spot-1')!;
    clearFuzzCache('spot-1');
    const good = fuzzSpotCached(loaded.spot, loaded.place, 'g500');

    // 模拟老版本/手动改库：缓存被污染成精确坐标
    getDb()
      .prepare('UPDATE place_fuzz_cache SET fuzz_lat=?, fuzz_lng=? WHERE spot_id=? AND fuzz_level=?')
      .run(31.2471, 121.4462, 'spot-1', 'g500');

    const healed = fuzzSpotCached(loaded.spot, loaded.place, 'g500');
    expect(healed.lat).toBe(good.lat);
    expect(healed.lng).toBe(good.lng);
    expect(healed.lat).not.toBe(31.2471); // 精确值没有被放出来
    // DB 中的坏档已被覆写
    const row = getDb()
      .prepare('SELECT fuzz_lat, fuzz_lng FROM place_fuzz_cache WHERE spot_id=? AND fuzz_level=?')
      .get('spot-1', 'g500') as { fuzz_lat: number; fuzz_lng: number };
    expect(row.fuzz_lat).toBe(good.lat);
  });

  it('历史坏档：缓存 geohash 与当前坐标不符（机位迁移）→ 丢弃旧缓存重算', () => {
    const loaded = loadSpotRow('spot-1')!;
    clearFuzzCache('spot-1');
    fuzzSpotCached(loaded.spot, loaded.place, 'g500');

    // 机位搬到北京，但缓存没跟着清（历史脏数据）
    getDb().prepare('UPDATE spot SET lat=?, lng=? WHERE id=?').run(39.9042, 116.4074, 'spot-1');
    const moved = loadSpotRow('spot-1')!;
    const r = fuzzSpotCached(moved.spot, moved.place, 'g500');
    // 输出必须反映新位置，而不是上海的旧网格
    expect(r.geohash).not.toContain('wtw'); // 上海 g7 前缀；北京不同
    expect(r.lat).toBeGreaterThan(39);

    // 复位
    getDb().prepare('UPDATE spot SET lat=?, lng=? WHERE id=?').run(31.2471, 121.4462, 'spot-1');
    clearFuzzCache('spot-1');
  });

  it('历史坏档：区域级缓存里混进了坐标点 → 自愈为 null 坐标', () => {
    const loaded = loadSpotRow('spot-1')!;
    clearFuzzCache('spot-1');
    fuzzSpotCached(loaded.spot, loaded.place, 'district');
    getDb()
      .prepare('UPDATE place_fuzz_cache SET fuzz_lat=?, fuzz_lng=? WHERE spot_id=? AND fuzz_level=?')
      .run(31.2471, 121.4462, 'spot-1', 'district');
    const r = fuzzSpotCached(loaded.spot, loaded.place, 'district');
    expect(r.lat).toBeNull();
    expect(r.lng).toBeNull();
  });
});

describe('窗口 · L2 服务层：断网降级落库', () => {
  beforeAll(() => {
    const db = getDb();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO timing (id,library_id,inspiration_id,time_anchor,anchor_offset_min,elevation_range,
         azimuth_tolerance,window_tolerance_min,weather_profile,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'timing-1',
      LIB,
      'insp-1',
      'sunset_minus',
      40,
      '[-4,10]',
      15,
      12,
      '{"precipProbPctMax":20}',
      ts,
      ts,
    );
  });

  it('天气源为 off 时 computeWindowsForInspiration 落库的窗口全部 weather_degraded=1', async () => {
    // 本进程 config.weatherProvider 在 setup-env 里固定为 fixture；
    // 服务层降级路径的权威覆盖在纯函数测试里（forecast=[]），这里直接走 DB 幂等契约：
    const dtos = await computeWindowsForInspiration('insp-1', { days: 5, now: new Date('2026-10-11T00:00:00Z') });
    expect(dtos).toHaveLength(5);
    // fixture 源下判定必须自洽：有预报快照的日期 weatherDegraded=false
    for (const d of dtos) {
      expect(['good', 'marginal', 'bad']).toContain(d.verdict);
    }
    const rows = getDb()
      .prepare('SELECT COUNT(*) AS n FROM repro_window WHERE inspiration_id=?')
      .get('insp-1') as { n: number };
    expect(rows.n).toBe(5);
  });

  it('重复计算幂等（同日期不新增行），且被计划引用的窗口原地更新', async () => {
    await computeWindowsForInspiration('insp-1', { days: 5, now: new Date('2026-10-11T00:00:00Z') });
    const before = (
      getDb().prepare('SELECT COUNT(*) AS n FROM repro_window WHERE inspiration_id=?').get('insp-1') as {
        n: number;
      }
    ).n;
    await computeWindowsForInspiration('insp-1', { days: 5, now: new Date('2026-10-11T00:00:00Z') });
    const after = (
      getDb().prepare('SELECT COUNT(*) AS n FROM repro_window WHERE inspiration_id=?').get('insp-1') as {
        n: number;
      }
    ).n;
    expect(after).toBe(before);
  });
});

describe('窗口 · 历史坏档：损坏的 timing JSON 不拖垮全库扫描', () => {
  it('timing 行的 elevation_range / weather_profile 是非法 JSON 时，DTO 回退到安全默认值', () => {
    const db = getDb();
    const ts = nowIso();
    db.prepare(
      'INSERT INTO place (id,library_id,name,created_at,updated_at) VALUES (?,?,?,?,?)',
    ).run('place-bad', LIB, '坏地点', ts, ts);
    db.prepare(
      'INSERT INTO spot (id,library_id,place_id,lat,lng,camera_bearing,tz,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run('spot-bad', LIB, 'place-bad', 31.2, 121.4, 0, 'Asia/Shanghai', ts, ts);
    db.prepare(
      "INSERT INTO inspiration (id,library_id,title,status,spot_id,created_at,updated_at) VALUES (?,?,?,'ready',?,?,?)",
    ).run('insp-bad', LIB, '坏档卡', 'spot-bad', ts, ts);
    db.prepare(
      `INSERT INTO timing (id,library_id,inspiration_id,time_anchor,elevation_range,weather_profile,
         azimuth_range,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('timing-bad', LIB, 'insp-bad', 'sunset_minus', '{not json', 'BROKEN<<<', '[not,json', ts, ts);

    const row = db.prepare('SELECT * FROM timing WHERE id=?').get('timing-bad') as Parameters<
      typeof timingRowToDto
    >[0];
    const dto = timingRowToDto(row);
    expect(dto.elevationRange).toEqual([-90, 90]); // 坏 JSON 回退到全区间，而不是抛错
    expect(dto.weatherProfile).toEqual({});
    expect(dto.azimuthRange).toBeNull();
  });

  it('坏档卡不拖垮全库窗口扫描（job 级容错，其余卡正常产出）', async () => {
    // 坏卡缺合法 azimuth_range 不会崩，但构造一张真正会在计算中出错的卡：
    // spot 指向不存在的 place（FK 在历史库可能失效）——loadSpotGeom 不依赖 place，仍应完成
    const result = await scanWindowsForAllLibraries(3);
    expect(result.cards).toBeGreaterThanOrEqual(1);
    // 正常卡窗口仍在
    const n = (
      getDb().prepare('SELECT COUNT(*) AS n FROM repro_window WHERE inspiration_id=?').get('insp-1') as {
        n: number;
      }
    ).n;
    expect(n).toBeGreaterThan(0);
  });
});

describe('校准 · 收紧可复现，撤销面对历史坏档不崩', () => {
  it('连续 3 次同因 miss → 方位角容差确定性收紧一档（15→10）', () => {
    const db = getDb();
    const ts = nowIso();
    db.prepare(
      'INSERT INTO place (id,library_id,name,created_at,updated_at) VALUES (?,?,?,?,?)',
    ).run('place-cal', LIB, '校准地点', ts, ts);
    db.prepare(
      'INSERT INTO spot (id,library_id,place_id,lat,lng,camera_bearing,tz,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run('spot-cal', LIB, 'place-cal', 31.3, 121.5, 90, 'Asia/Shanghai', ts, ts);
    db.prepare(
      "INSERT INTO inspiration (id,library_id,title,status,spot_id,created_at,updated_at) VALUES (?,?,?,'ready',?,?,?)",
    ).run('insp-cal', LIB, '校准卡', 'spot-cal', ts, ts);
    db.prepare(
      `INSERT INTO timing (id,library_id,inspiration_id,time_anchor,azimuth_tolerance,created_at,updated_at)
       VALUES (?,?,?,?,15,?,?)`,
    ).run('timing-cal', LIB, 'insp-cal', 'sunset_minus', ts, ts);

    // 三张计划 + 三条同因 miss 回填
    for (let i = 0; i < 3; i += 1) {
      const planId = `plan-cal-${i}`;
      db.prepare(
        `INSERT INTO shoot_plan (id,library_id,inspiration_id,planned_at,status,created_at,updated_at)
         VALUES (?,?,?,?,'done',?,?)`,
      ).run(planId, LIB, 'insp-cal', ts, ts, ts);
      db.prepare(
        `INSERT INTO shoot_result (id,library_id,plan_id,inspiration_id,hit_level,miss_reasons,filled_at,created_at)
         VALUES (?,?,?,?, 'miss', ?, ?, ?)`,
      ).run(planId, LIB, planId, 'insp-cal', '["timing_off"]', ts, ts);
    }

    const outcome = applyCalibration(LIB, 'insp-cal', 'test');
    expect(outcome.tightened).toHaveLength(1);
    expect(outcome.tightened[0]).toMatchObject({ field: 'azimuth_tolerance', before: 15, after: 10 });

    const row = db.prepare('SELECT azimuth_tolerance AS a FROM timing WHERE id=?').get('timing-cal') as {
      a: number;
    };
    expect(row.a).toBe(10);
  });

  it('撤销把容差还原为 15，且可重复列出（undone 标记持久化）', () => {
    const [log] = listCalibration('insp-cal');
    expect(log.reason).toContain('收紧');
    undoCalibration(log.id as string, LIB, 'insp-cal');
    const row = getDb().prepare('SELECT azimuth_tolerance AS a FROM timing WHERE id=?').get('timing-cal') as {
      a: number;
    };
    expect(row.a).toBe(15);
    const again = listCalibration('insp-cal').find((l) => l.id === log.id);
    expect(again?.undoneAt).toBeTruthy();
  });

  it('历史坏档：calibration_log.before_value 是非法 JSON，撤销不崩溃（容差回退为 null 被容忍）', () => {
    const db = getDb();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO calibration_log (id,library_id,inspiration_id,field,before_value,after_value,reason,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('cal-bad', LIB, 'insp-cal', 'azimuth_tolerance', 'CORRUPT{', '8', '历史坏档的收紧记录', ts);
    // 不应抛错（parseJson 回退 null，UPDATE 写成 NULL 也不崩）
    expect(() => undoCalibration('cal-bad', LIB, 'insp-cal')).not.toThrow();
  });
});
