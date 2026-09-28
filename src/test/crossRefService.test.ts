import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db';
import { createProject, importVersion } from '../service';
import { scanVersionCrossRefs, getCrossRefOverview } from '../crossRefService';
import { crossRefsToCsv } from '../crossRefExport';

/**
 * 条款交叉引用服务测试：
 *  - 扫描只使用所选版本，编号索引与引用解析在该版本内闭环；
 *  - 其他项目的版本 id 返回 version_not_found（路由层映射 404）；
 *  - 状态筛选与 CSV 导出。
 */

const join = (...paras: string[]) => paras.join('\n\n');

function setup() {
  const db = openDb(':memory:');
  const pidA = createProject(db, '项目甲');
  const v1 = importVersion(
    db,
    pidA,
    'v1',
    join('第一条 总则。', '第二条 依第一条办理；第九十九条另定。')
  );
  // 制造歧义：项目甲第二个版本中编号 1 对应两段
  const v2 = importVersion(
    db,
    pidA,
    'v2',
    join('第一条 总则甲。', '第一条 总则乙。', '第三条 参见第一条与第5条。')
  );
  const pidB = createProject(db, '项目乙');
  const vB = importVersion(db, pidB, 'v1', join('第一条 乙项目的条款。'));
  for (const r of [v1, v2, vB]) assert.equal(r.status, 'ok');
  return {
    db,
    pidA,
    pidB,
    a1: (v1 as { status: 'ok'; versionId: number }).versionId,
    a2: (v2 as { status: 'ok'; versionId: number }).versionId,
    b1: (vB as { status: 'ok'; versionId: number }).versionId,
  };
}

test('扫描只使用所选版本：失效 / 唯一状态按版本内索引判定', () => {
  const { db, pidA, a1 } = setup();
  const r = scanVersionCrossRefs(db, pidA, a1);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  const refs = r.result.report.references;
  // 第二条中：第一条 → 唯一；第九十九条 → 失效
  assert.equal(refs.length, 2);
  assert.equal(refs[0].number, 1);
  assert.equal(refs[0].status, 'unique');
  assert.deepEqual(refs[0].targets, [1]);
  assert.equal(refs[1].number, 99);
  assert.equal(refs[1].status, 'invalid');
  assert.equal(r.result.report.summary.invalid, 1);
  assert.equal(r.result.report.summary.unique, 1);
});

test('同编号对应多段：引用解析为歧义并列出全部目标段落', () => {
  const { db, pidA, a2 } = setup();
  const r = scanVersionCrossRefs(db, pidA, a2);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  const refs = r.result.report.references;
  // 第三条：第一条（歧义，目标 [1,2]）、第5条（失效）
  const amb = refs.find((x) => x.number === 1)!;
  assert.equal(amb.status, 'ambiguous');
  assert.deepEqual(amb.targets, [1, 2]);
  const bad = refs.find((x) => x.number === 5)!;
  assert.equal(bad.status, 'invalid');
  assert.equal(r.result.report.index.find((e) => e.number === 1)?.status, 'ambiguous');
});

test('其他项目的版本 id 返回 version_not_found；项目不存在返回 project_not_found', () => {
  const { db, pidA, b1 } = setup();
  assert.equal(scanVersionCrossRefs(db, pidA, b1).status, 'version_not_found');
  assert.equal(scanVersionCrossRefs(db, 99999, b1).status, 'project_not_found');
  // 非法入参
  assert.equal(scanVersionCrossRefs(db, pidA, 0).status, 'invalid');
  const badFilter = scanVersionCrossRefs(db, pidA, b1, 'unknown' as never);
  assert.equal(badFilter.status, 'version_not_found'); // 版本隔离先于筛选判定
});

test('状态筛选只裁剪引用列表，索引与汇总保持完整', () => {
  const { db, pidA, a2 } = setup();
  const r = scanVersionCrossRefs(db, pidA, a2, 'ambiguous');
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.result.report.references.length, 1);
  assert.equal(r.result.report.references[0].status, 'ambiguous');
  // 汇总仍是完整扫描口径
  assert.equal(r.result.report.summary.total, 2);
  // 索引完整，可供页面定位
  assert.ok(r.result.report.index.length >= 2);
});

test('概览只列本项目版本（含段落数，按 seq 排序）', () => {
  const { db, pidA, pidB } = setup();
  const ovA = getCrossRefOverview(db, pidA)!;
  assert.equal(ovA.versions.length, 2);
  assert.deepEqual(ovA.versions.map((v) => v.seq), [1, 2]);
  assert.deepEqual(ovA.versions.map((v) => v.paragraph_count), [2, 3]);
  const ovB = getCrossRefOverview(db, pidB)!;
  assert.equal(ovB.versions.length, 1);
  assert.equal(getCrossRefOverview(db, 99999), null);
});

test('CSV 导出：表头为中文，每行一处引用并带 UTF-8 BOM', () => {
  const { db, pidA, a1 } = setup();
  const r = scanVersionCrossRefs(db, pidA, a1);
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  const csv = crossRefsToCsv(r.result);
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0].split(',').length, 12);
  assert.ok(lines[0].includes('校验状态'));
  // 两行引用：唯一 / 失效
  assert.equal(lines.length - 1, 2);
  assert.ok(lines.some((l) => l.includes('"失效"') && l.includes('第九十九条')));
  assert.ok(lines.some((l) => l.includes('"唯一"') && l.includes('第一条')));
});
