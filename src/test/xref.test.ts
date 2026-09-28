import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDb } from '../db';
import { createProject, importVersion } from '../service';
import { parseCnClauseNumber, scanCrossReferences } from '../xref';
import { scanVersionXref, getXrefOverview } from '../xrefService';

/**
 * 条款交叉引用校验测试：
 *  - 段首「第十二条 / 第12条」建立编号索引，标题自身不算引用；
 *  - 正文引用：唯一匹配 / 歧义 / 失效三态；同段多处引用分别列出；
 *  - 中文数字与阿拉伯数字按同一编号匹配，仅支持一至九十九；
 *  - 服务层版本隔离：未知版本 / 他项目版本返回 version_not_found（HTTP 404）；
 *  - CSV 导出带 BOM 且逐行列出引用。
 */

test('中文数字编号解析：一～九十九，越界与非法组合返回 null', () => {
  const cases: Array<[string, number | null]> = [
    ['一', 1],
    ['九', 9],
    ['十', 10],
    ['十一', 11],
    ['十九', 19],
    ['二十', 20],
    ['二十一', 21],
    ['九十', 90],
    ['九十九', 99],
    ['一百', null],
    ['零零', null],
    ['十十', null],
    ['一一', null],
    ['百', null],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(parseCnClauseNumber(raw), expected, raw);
  }
});

test('段首标题建索引：标题自身不算引用', () => {
  const paras = ['第一条 为了规范。', '第二条 适用范围。'];
  const r = scanCrossReferences(paras);
  assert.equal(r.headings.length, 2);
  assert.equal(r.summary.total, 0);
  assert.deepEqual(
    r.headings.map((h) => [h.paragraph_ord, h.number]),
    [
      [1, 1],
      [2, 2],
    ]
  );
});

test('唯一匹配：中文数字引用解析到唯一目标段落（含目标原文）', () => {
  const paras = ['第一条 总则。', '第二条 本办法依第一条制定。'];
  const r = scanCrossReferences(paras);
  assert.equal(r.summary.unique, 1);
  const ref = r.references[0];
  assert.equal(ref.status, 'unique');
  assert.equal(ref.number, 1);
  assert.equal(ref.number_style, 'cn');
  assert.equal(ref.target_paragraph_ord, 1);
  assert.equal(ref.target_text, '第一条 总则。');
  assert.equal(ref.occurrence, 1);
});

test('阿拉伯数字与中文数字按同一编号匹配；第12条 = 第十二条', () => {
  const paras = ['第十二条 本办法自发布之日起施行。', '第二十条 违反者按第12条处罚。'];
  const r = scanCrossReferences(paras);
  assert.equal(r.summary.unique, 1);
  const ref = r.references[0];
  assert.equal(ref.number, 12);
  assert.equal(ref.number_style, 'arabic');
  assert.equal(ref.target_paragraph_ord, 1);
  assert.equal(ref.text, '第12条');
});

test('失效：引用编号在本版本中找不到任何段落', () => {
  const paras = ['第一条 总则。', '第二条 术语见第十九条。'];
  const r = scanCrossReferences(paras);
  assert.equal(r.summary.broken, 1);
  const ref = r.references[0];
  assert.equal(ref.status, 'broken');
  assert.equal(ref.target_paragraph_ord, null);
  assert.deepEqual(ref.targets, []);
});

test('歧义：同一编号对应多个段落，候选全部返回', () => {
  const paras = [
    '第七条 罚款。',
    '第七条 数据出境。',
    '第二十条 按第七条执行。',
  ];
  const r = scanCrossReferences(paras);
  assert.equal(r.headings.length, 3);
  assert.equal(r.summary.ambiguous, 1);
  const ref = r.references[0];
  assert.equal(ref.status, 'ambiguous');
  assert.equal(ref.target_paragraph_ord, null);
  assert.deepEqual(ref.targets, [1, 2]);
});

test('自引用：段首编号对应多段时，段内引用自身仍计为引用（标题自身不计）', () => {
  // 两个「第十二条」段；第二段正文引用「第十二条」：是引用而非标题，且编号歧义
  const paras = ['第十二条 施行日期。', '第十二条 数据定义，参照第十二条解释。'];
  const r = scanCrossReferences(paras);
  assert.equal(r.summary.total, 1);
  const ref = r.references[0];
  assert.equal(ref.paragraph_ord, 2);
  assert.equal(ref.status, 'ambiguous');
  assert.deepEqual(ref.targets, [1, 2]);
});

test('同一段落多处引用分别列出（次序、偏移、状态各自独立）', () => {
  const paras = [
    '第一条 总则。',
    '第二条 适用范围。',
    '第三条 本条同时援引第一条、第十九条与第1条规定。',
  ];
  const r = scanCrossReferences(paras);
  assert.equal(r.summary.total, 3);
  const [a, b, c] = r.references;
  assert.equal(a.paragraph_ord, 3);
  assert.equal(a.occurrence, 1);
  assert.equal(a.text, '第一条');
  assert.equal(a.status, 'unique');
  assert.equal(b.occurrence, 2);
  assert.equal(b.text, '第十九条');
  assert.equal(b.status, 'broken');
  assert.equal(c.occurrence, 3);
  assert.equal(c.text, '第1条');
  assert.equal(c.status, 'unique');
  // 段内偏移严格递增
  assert.ok(a.start < a.end && a.end <= b.start && b.end <= c.start);
  // 上下文包含引用原文
  assert.ok(a.context.includes('第一条'));
});

test('编号仅支持一至九十九：「第一百条」「第100条」「第0条」均不视为引用', () => {
  const paras = ['第一百条 本办法相关事项。', '第二十条 见第一百条、第100条与第0条。'];
  const r = scanCrossReferences(paras);
  assert.equal(r.headings.length, 1); // 第一百条不建索引
  assert.equal(r.summary.total, 0);
});

test('非段首出现的「第N条」不作为标题，但正文中的同类写法仍是引用', () => {
  const paras = ['前言：本文件引用第三条。', '第三条 数据。'];
  const r = scanCrossReferences(paras);
  // 第一段开头不是标题，故只有第二段建索引；第一段正文中的「第三条」是引用且唯一
  assert.equal(r.headings.length, 1);
  assert.equal(r.summary.unique, 1);
  assert.equal(r.references[0].paragraph_ord, 1);
  assert.equal(r.references[0].target_paragraph_ord, 2);
});

test('码点偏移在非 BMP 字符下仍正确（按码点而非 UTF-16 计）', () => {
  const paras = ['第一条 总则。', '第二条 🐳🐳 按第一条处理。'];
  const r = scanCrossReferences(paras);
  const ref = r.references[0];
  const cps = Array.from(paras[1]);
  assert.equal(cps.slice(ref.start, ref.end).join(''), '第一条');
});

/* ---------------- 服务层：版本隔离与 404 语义 ---------------- */

function setup() {
  const db = openDb(':memory:');
  const pidA = createProject(db, '甲办法');
  const v1A = importVersion(
    db,
    pidA,
    'v1',
    ['第一条 总则。', '第二条 依第十九条与第一条执行。'].join('\n\n')
  );
  const pidB = createProject(db, '乙办法');
  const v1B = importVersion(db, pidB, 'v1', '第一条 乙办法总则。');
  for (const r of [v1A, v1B]) assert.equal(r.status, 'ok');
  if (v1A.status !== 'ok' || v1B.status !== 'ok') throw new Error('夹具异常');
  return { db, pidA, pidB, vA: v1A.versionId, vB: v1B.versionId };
}

test('服务层：扫描只使用所选版本，返回统计与三态结果', () => {
  const { db, pidA, vA } = setup();
  const r = scanVersionXref(db, pidA, vA);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') throw new Error('扫描失败');
  assert.equal(r.report.version.version_id, vA);
  assert.equal(r.report.version.paragraph_count, 2);
  assert.equal(r.report.summary.headings, 2);
  assert.equal(r.report.summary.total, 2);
  assert.equal(r.report.summary.broken, 1); // 第十九条
  assert.equal(r.report.summary.unique, 1); // 第一条
});

test('服务层：未知版本 / 他项目版本一律 version_not_found；项目不存在 project_not_found', () => {
  const { db, pidA, vB } = setup();
  assert.equal(scanVersionXref(db, pidA, 99999).status, 'version_not_found');
  assert.equal(scanVersionXref(db, pidA, vB).status, 'version_not_found');
  assert.equal(scanVersionXref(db, 99999, 1).status, 'project_not_found');
  assert.equal(scanVersionXref(db, pidA, 0).status, 'invalid');
});

test('服务层：概览返回版本清单（含段落数），未知项目返回 null', () => {
  const { db, pidA, vA } = setup();
  const overview = getXrefOverview(db, pidA)!;
  assert.equal(overview.versions.length, 1);
  assert.equal(overview.versions[0].id, vA);
  assert.equal(overview.versions[0].paragraph_count, 2);
  assert.equal(getXrefOverview(db, 99999), null);
});

/* ---------------- HTTP 集成：200 / 404 / 400 / CSV 导出 ---------------- */

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

test('HTTP：交叉引用接口 200/404/400，JSON/CSV 导出与跨项目隔离', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xref-http-'));
  const dbFile = path.join(tmpDir, 'test.db');
  const port = 43700 + Math.floor(Math.random() * 200);
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
    return { status: res.status, body: await res.text(), res };
  };
  const j = (s: string | { body: string }) => JSON.parse(typeof s === 'string' ? s : s.body);

  const p1 = j(await req('POST', '/api/projects', { name: '引用HTTP项目' }));
  const p2 = j(await req('POST', '/api/projects', { name: '其他项目' }));
  const v1 = j(
    await req('POST', `/api/projects/${p1.id}/versions`, {
      label: 'v1',
      content:
        '第十二条 施行日期。\n\n' +
        '第二十条 依第十二条与第十九条处理，再次违反仍按第12条处理。\n\n' +
        '第十二条 数据定义。',
    })
  );

  // 概览
  const overview = await req('GET', `/api/projects/${p1.id}/cross-references`);
  assert.equal(overview.status, 200);
  assert.equal(j(overview.body).versions.length, 1);
  assert.equal(await req('GET', '/api/projects/999999/cross-references').then((r) => r.status), 404);

  // 扫描 200：一处唯一（第十二条→第一段？实际两段都为第十二条，故为歧义）+ 一失效
  const scan = await req('GET', `/api/projects/${p1.id}/cross-references/scan?version_id=${v1.versionId}`);
  assert.equal(scan.status, 200);
  const report = j(scan.body);
  assert.equal(report.summary.headings, 3);
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.broken, 1); // 第十九条
  assert.equal(report.summary.ambiguous, 2); // 第十二条 / 第12条 均对应两段
  const byText = Object.fromEntries(report.references.map((r2: { text: string }) => [r2.text, r2])) as Record<
    string,
    { status: string; targets: number[] }
  >;
  assert.equal(byText['第十九条'].status, 'broken');
  assert.equal(byText['第十二条'].status, 'ambiguous');
  assert.deepEqual(byText['第十二条'].targets, [1, 3]);
  assert.equal(byText['第12条'].status, 'ambiguous');
  // 同段三处引用分别列出
  assert.equal(
    report.references.filter((r2: { paragraph_ord: number }) => r2.paragraph_ord === 2).length,
    3
  );

  // 缺参 / 非法参数 → 400
  assert.equal(
    await req('GET', `/api/projects/${p1.id}/cross-references/scan`).then((r) => r.status),
    400
  );
  assert.equal(
    await req('GET', `/api/projects/${p1.id}/cross-references/scan?version_id=abc`).then((r) => r.status),
    400
  );

  // 未知版本 / 他项目版本 → 404（附 unknown_version_ids）
  const rUnknown = await req('GET', `/api/projects/${p1.id}/cross-references/scan?version_id=999999`);
  assert.equal(rUnknown.status, 404);
  assert.deepEqual(j(rUnknown.body).unknown_version_ids, [999999]);
  const rCross = await req('GET', `/api/projects/${p2.id}/cross-references/scan?version_id=${v1.versionId}`);
  assert.equal(rCross.status, 404);

  // 定位所用段落接口同样按项目隔离 → 404
  assert.equal(
    await req('GET', `/api/projects/${p2.id}/versions/${v1.versionId}/paragraphs`).then((r) => r.status),
    404
  );

  // JSON 导出
  const exportJson = await req(
    'GET',
    `/api/projects/${p1.id}/cross-references/export?version_id=${v1.versionId}&format=json`
  );
  assert.equal(exportJson.status, 200);
  assert.equal(j(exportJson).summary.total, 3);
  assert.match(exportJson.res.headers.get('content-disposition') ?? '', /attachment/);

  // CSV 导出：BOM + 中文状态列
  const exportCsv = await fetch(
    `${base}/api/projects/${p1.id}/cross-references/export?version_id=${v1.versionId}&format=csv`
  );
  assert.equal(exportCsv.status, 200);
  assert.equal(exportCsv.headers.get('content-type'), 'text/csv; charset=utf-8');
  const csvBytes = new Uint8Array(await exportCsv.arrayBuffer());
  assert.deepEqual([...csvBytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const csvText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(csvBytes);
  assert.match(csvText, /来源段落序号/);
  assert.match(csvText, /失效/);
  assert.match(csvText, /歧义/);
  assert.match(csvText, /第十九条/);
  // 三处引用三行数据（连同表头共 4 行）
  assert.equal(csvText.trim().split(/\r\n/).length, 4);
  // 导出接口同样 404 / 400
  assert.equal(
    await req('GET', `/api/projects/${p1.id}/cross-references/export?version_id=999999`).then((r) => r.status),
    404
  );
  assert.equal(
    await req('GET', `/api/projects/${p1.id}/cross-references/export`).then((r) => r.status),
    400
  );
  assert.equal(
    await req('GET', `/api/projects/${p1.id}/cross-references/export?version_id=${v1.versionId}&format=xml`).then(
      (r) => r.status
    ),
    400
  );

  assert.equal(stderr, '');
});
