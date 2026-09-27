import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDb } from '../db';
import { createProject, importVersion } from '../service';
import {
  createTermRule,
  updateTermRule,
  deleteTermRule,
  listTermRules,
  scanVersions,
  getTerminologyOverview,
} from '../termService';

/**
 * 术语审查服务测试：
 *  - 术语 / 写法按项目隔离，跨项目重复允许、项目内重复拒绝；
 *  - 扫描返回段落序号、原文片段与规则快照；
 *  - 未知版本（含其他项目的版本 id）返回 version_not_found（HTTP 层 404）；
 *  - 规则筛选与规则不存在语义。
 */

const P1_TEXT = ['第一条 应当在四十八小时内报告。', '第二条 不得收集个资。'].join('\n\n');
const P2_TEXT = ['第一条 应当在二十四小时内报告。'].join('\n\n');

function setup() {
  const db = openDb(':memory:');
  const pidA = createProject(db, '甲办法');
  const v1A = importVersion(db, pidA, 'v1', P1_TEXT);
  const pidB = createProject(db, '乙办法');
  const v1B = importVersion(db, pidB, 'v1', P2_TEXT);
  for (const r of [v1A, v1B]) assert.equal(r.status, 'ok');
  if (v1A.status !== 'ok' || v1B.status !== 'ok') throw new Error('夹具异常');
  return { db, pidA, pidB, vA: v1A.versionId, vB: v1B.versionId };
}

test('创建规则：术语与变体 NFC 规范化后入库', () => {
  const { db, pidA } = setup();
  const r = createTermRule(db, pidA, '二十四小时 ', ['24小时'], ['四十八小时']);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') throw new Error('创建失败');
  const rules = listTermRules(db, pidA)!;
  assert.equal(rules[0].term, '二十四小时');
  assert.deepEqual(rules[0].forbidden, ['四十八小时']);
});

test('项目内术语重复（含 NFC 等价写法）拒绝；跨项目允许', () => {
  const { db, pidA, pidB } = setup();
  assert.equal(createTermRule(db, pidA, 'café', [], []).status, 'ok');
  const dup = createTermRule(db, pidA, 'café', [], []);
  assert.equal(dup.status, 'duplicate_term');
  // 另一个项目可以登记同名术语
  assert.equal(createTermRule(db, pidB, 'café', [], []).status, 'ok');
});

test('写法不得与本项目其他规则的任何字面量重复', () => {
  const { db, pidA } = setup();
  assert.equal(createTermRule(db, pidA, '二十四小时', ['24小时'], ['48小时']).status, 'ok');
  const clash = createTermRule(db, pidA, '报告时限', [], ['24小时']);
  assert.equal(clash.status, 'duplicate_variant');
  if (clash.status === 'duplicate_variant') assert.ok(clash.rule_id > 0);
});

test('更新规则：全量替换允许 / 禁用写法，重复校验仍然生效', () => {
  const { db, pidA } = setup();
  const created = createTermRule(db, pidA, '二十四小时', ['24小时'], ['四十八小时']);
  assert.equal(created.status, 'ok');
  if (created.status !== 'ok') throw new Error('创建失败');
  const upd = updateTermRule(db, pidA, created.id, '二十四小时', ['24 小时'], ['48小时']);
  assert.equal(upd.status, 'ok');
  const rules = listTermRules(db, pidA)!;
  assert.deepEqual(rules[0].allowed, ['24 小时']);
  assert.deepEqual(rules[0].forbidden, ['48小时']);
});

test('更新 / 删除 / 查询均按项目隔离：他项目规则不可见', () => {
  const db = openDb(':memory:');
  const a = createProject(db, 'A');
  const b = createProject(db, 'B');
  const created = createTermRule(db, a, '术语X', [], []);
  assert.equal(created.status, 'ok');
  if (created.status !== 'ok') throw new Error('创建失败');
  assert.equal(updateTermRule(db, b, created.id, '术语Y', [], []).status, 'not_found');
  assert.equal(deleteTermRule(db, b, created.id), 'not_found');
  assert.equal(listTermRules(db, b)!.length, 0);
  assert.equal(deleteTermRule(db, a, created.id), 'ok');
  assert.equal(listTermRules(db, a)!.length, 0);
});

test('扫描：多版本命中返回段落序号、原文片段、上下文与规则快照', () => {
  const { db, pidA, vA } = setup();
  createTermRule(db, pidA, '二十四小时', ['24小时'], ['四十八小时', '48小时']);
  createTermRule(db, pidA, '个人信息', [], ['个资', '个人资料']);
  const r = scanVersions(db, pidA, [vA]);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') throw new Error('扫描失败');
  const { report } = r;
  assert.equal(report.versions.length, 1);
  assert.equal(report.summary.forbidden, 2);
  assert.equal(report.summary.total, 2);
  const [first, second] = report.versions[0].hits;
  assert.equal(first.paragraph_ord, 1);
  assert.equal(first.snippet, '四十八小时');
  assert.equal(first.kind, 'forbidden');
  assert.equal(first.suggestion, '二十四小时');
  assert.equal(second.paragraph_ord, 2);
  assert.equal(second.snippet, '个资');
  assert.ok(first.context.includes('四十八小时'));
  // 规则快照
  assert.equal(report.rules.length, 2);
});

test('扫描：未知版本与他项目版本一律 version_not_found（路由层映射 404）', () => {
  const { db, pidA, vB } = setup();
  const r1 = scanVersions(db, pidA, [99999]);
  assert.equal(r1.status, 'version_not_found');
  if (r1.status === 'version_not_found') assert.deepEqual(r1.version_ids, [99999]);
  // 用乙项目的版本 id 扫描甲项目：隔离，不返回任何他项目内容
  const r2 = scanVersions(db, pidA, [vB]);
  assert.equal(r2.status, 'version_not_found');
  if (r2.status === 'version_not_found') assert.deepEqual(r2.version_ids, [vB]);
});

test('扫描：空版本列表 / 非法 id 返回 invalid；项目不存在 project_not_found', () => {
  const { db, pidA, vA } = setup();
  assert.equal(scanVersions(db, pidA, []).status, 'invalid');
  assert.equal(scanVersions(db, 99999, [vA]).status, 'project_not_found');
});

test('扫描：按规则筛选，未知规则 rule_not_found', () => {
  const { db, pidA, vA } = setup();
  const c1 = createTermRule(db, pidA, '二十四小时', [], ['四十八小时']);
  createTermRule(db, pidA, '个人信息', [], ['个资']);
  assert.equal(c1.status, 'ok');
  if (c1.status !== 'ok') throw new Error('创建失败');
  const r = scanVersions(db, pidA, [vA], [c1.id]);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') throw new Error('扫描失败');
  assert.equal(r.report.summary.total, 1);
  assert.equal(r.report.versions[0].hits[0].term, '二十四小时');
  assert.equal(scanVersions(db, pidA, [vA], [99999]).status, 'rule_not_found');
});

test('概览接口：版本清单含段落数，未知项目返回 null', () => {
  const { db, pidA, vA } = setup();
  const overview = getTerminologyOverview(db, pidA)!;
  assert.equal(overview.project.id, pidA);
  assert.equal(overview.versions.length, 1);
  assert.equal(overview.versions[0].id, vA);
  assert.equal(overview.versions[0].paragraph_count, 2);
  assert.equal(getTerminologyOverview(db, 99999), null);
});

test('删除项目级联删除术语规则与变体', () => {
  const { db, pidA } = setup();
  createTermRule(db, pidA, '二十四小时', ['24小时'], ['四十八小时']);
  db.prepare('DELETE FROM projects WHERE id = ?').run(pidA);
  const rulesRow = db.prepare('SELECT COUNT(*) AS n FROM term_rules').get() as { n: number };
  assert.equal(rulesRow.n, 0);
  const row = db.prepare('SELECT COUNT(*) AS n FROM term_variants').get() as { n: number };
  assert.equal(row.n, 0);
});

/* ---------------- HTTP 集成：200 / 404 / 400 / 409 / 导出 ---------------- */

async function waitForHealth(port: number, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      /* 等待服务启动 */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('测试服务未在规定时间内启动');
}

test('HTTP：术语审查接口 200/404/400/409，扫描结果与 JSON/CSV 导出', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-http-'));
  const dbFile = path.join(tmpDir, 'test.db');
  const port = 43400 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  t.after(() => {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await waitForHealth(port);
  const base = `http://127.0.0.1:${port}`;
  const req = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.text()) as string, res };
  };
  const j = (r: string | { body: string }) => JSON.parse(typeof r === 'string' ? r : r.body);

  const p1 = j(await req('POST', '/api/projects', { name: '术语HTTP项目' }));
  const p2 = j(await req('POST', '/api/projects', { name: '其他项目' }));
  const v1 = j(
    await req('POST', `/api/projects/${p1.id}/versions`, {
      label: 'v1',
      content: '第一条 应当在四十八小时内报告。\n\n第二条 保护个人信息。',
    })
  );

  // 概览
  const overview = await req('GET', `/api/projects/${p1.id}/terminology`);
  assert.equal(overview.status, 200);
  assert.equal(j(overview).versions.length, 1);
  assert.equal(await req('GET', '/api/projects/999999/terminology').then((r) => r.status), 404);

  // 新建规则
  const created = await req('POST', `/api/projects/${p1.id}/term-rules`, {
    term: '二十四小时',
    allowed: ['24小时'],
    forbidden: ['四十八小时'],
  });
  assert.equal(created.status, 201);
  const ruleId = j(created).id as number;
  assert.equal(
    await req('POST', `/api/projects/${p1.id}/term-rules`, { term: '二十四小时' }).then((r) => r.status),
    409
  );
  assert.equal(
    await req('POST', `/api/projects/${p1.id}/term-rules`, { term: 'x', forbidden: ['24小时'] }).then(
      (r) => r.status
    ),
    409
  );
  assert.equal(
    await req('POST', `/api/projects/${p1.id}/term-rules`, { term: '  ' }).then((r) => r.status),
    400
  );

  // 跨项目改 / 删规则 → 404
  assert.equal(await req('PUT', `/api/projects/${p2.id}/term-rules/${ruleId}`, { term: 'y' }).then((r) => r.status), 404);
  assert.equal(await req('DELETE', `/api/projects/${p2.id}/term-rules/${ruleId}`).then((r) => r.status), 404);

  // 扫描 200
  const scan = await req('POST', `/api/projects/${p1.id}/terminology/scan`, {
    version_ids: [v1.versionId],
  });
  assert.equal(scan.status, 200);
  const report = j(scan.body);
  assert.equal(report.summary.forbidden, 1);
  // HTTP 项目仅登记了「二十四小时」规则：v1 中只有 1 处禁用变体，无规范术语命中
  assert.equal(report.summary.term, 0);
  assert.equal(report.summary.total, 1);
  const forbiddenHits = report.versions[0].hits.filter((h: { kind: string }) => h.kind === 'forbidden');
  assert.equal(forbiddenHits.length, 1);
  assert.equal(forbiddenHits[0].paragraph_ord, 1);
  assert.equal(forbiddenHits[0].snippet, '四十八小时');
  assert.equal(forbiddenHits[0].suggestion, '二十四小时');
  assert.match(forbiddenHits[0].context, /四十八小时/);

  // NFC 规范化识别：规则用预组合 café，版本正文用分解写法 e + U+0301，仍应命中并还原原文
  const decomposedCafe = 'café';
  const vNfc = j(
    await req('POST', `/api/projects/${p1.id}/versions`, {
      label: 'vNFC',
      content: `${decomposedCafe} corner`,
    })
  );
  await req('POST', `/api/projects/${p1.id}/term-rules`, { term: 'café' });
  const scanNfc = await req('POST', `/api/projects/${p1.id}/terminology/scan`, {
    version_ids: [vNfc.versionId],
  });
  assert.equal(scanNfc.status, 200);
  const nfcHits = j(scanNfc.body).versions[0].hits;
  assert.equal(nfcHits.length, 1);
  assert.equal(nfcHits[0].snippet, decomposedCafe);

  // 未知版本 / 他项目版本 → 404
  const rUnknown = await req('POST', `/api/projects/${p1.id}/terminology/scan`, { version_ids: [999999] });
  assert.equal(rUnknown.status, 404);
  assert.deepEqual(j(rUnknown.body).unknown_version_ids, [999999]);
  const rCross = await req('POST', `/api/projects/${p2.id}/terminology/scan`, {
    version_ids: [v1.versionId],
  });
  assert.equal(rCross.status, 404);

  // 非法请求体 → 400
  assert.equal(
    await req('POST', `/api/projects/${p1.id}/terminology/scan`, { version_ids: [] }).then((r) => r.status),
    400
  );
  assert.equal(
    await req('POST', `/api/projects/${p1.id}/terminology/scan`, { version_ids: ['x'] }).then((r) => r.status),
    400
  );

  // 未知规则 → 404
  assert.equal(
    await req('POST', `/api/projects/${p1.id}/terminology/scan`, {
      version_ids: [v1.versionId],
      rule_ids: [999999],
    }).then((r) => r.status),
    404
  );

  // JSON / CSV 导出
  const exportJson = await req(
    'GET',
    `/api/projects/${p1.id}/terminology/export?versions=${v1.versionId}&format=json`
  );
  assert.equal(exportJson.status, 200);
  assert.equal(j(exportJson.body).summary.forbidden, 1);
  const exportCsv = await fetch(
    `${base}/api/projects/${p1.id}/terminology/export?versions=${v1.versionId}&format=csv`
  );
  assert.equal(exportCsv.status, 200);
  assert.equal(exportCsv.headers.get('content-type'), 'text/csv; charset=utf-8');
  const csvBytes = new Uint8Array(await exportCsv.arrayBuffer());
  // fetch 的 .text() 会按 TextDecoder 默认行为剥掉开头 BOM，因此直接校验字节
  assert.deepEqual([...csvBytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const csvText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(csvBytes);
  assert.ok(csvText.startsWith('\uFEFF'));
  assert.match(csvText, /四十八小时/);
  assert.match(csvText, /禁用变体/);
  // 导出接口的 404 隔离
  assert.equal(
    await req('GET', `/api/projects/${p1.id}/terminology/export?versions=999999`).then((r) => r.status),
    404
  );
  assert.equal(
    await req('GET', `/api/projects/${p1.id}/terminology/export`).then((r) => r.status),
    400
  );

  // 更新与删除
  assert.equal(
    await req('PUT', `/api/projects/${p1.id}/term-rules/${ruleId}`, {
      term: '二十四小时',
      allowed: [],
      forbidden: ['四十八小时', '48小时'],
    }).then((r) => r.status),
    200
  );
  const afterUpdate = j(await req('GET', `/api/projects/${p1.id}/term-rules`));
  assert.deepEqual(afterUpdate.rules[0].forbidden, ['四十八小时', '48小时']);
  assert.equal(await req('DELETE', `/api/projects/${p1.id}/term-rules/${ruleId}`).then((r) => r.status), 204);

  assert.equal(stderr, '');
});
