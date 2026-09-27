import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nfcNormalize,
  buildNormalizedIndex,
  sliceOriginal,
  scanParagraph,
  scanParagraphsAll,
  prepareRules,
  selectLongestNonOverlapping,
  type TermHit,
} from '../terminology';

/**
 * 术语扫描引擎测试：
 *  - NFC 规范化识别（组合记号、全角 / 兼容字符）；
 *  - 原文片段还原（命中区间映射回未规范化文本）；
 *  - 同一段落重叠命中按最长规则保留；
 *  - 允许写法 / 禁用变体 / 规范术语三类命中与同段多次出现。
 */

function makeRules(
  defs: Array<{ id: number; term: string; allowed?: string[]; forbidden?: string[] }>
) {
  return prepareRules(
    defs.map((d) => ({ id: d.id, term: d.term, allowed: d.allowed ?? [], forbidden: d.forbidden ?? [] }))
  );
}

test('NFC 规范化：组合记号与预组合字符视为同一术语', () => {
  assert.equal(nfcNormalize('café'), nfcNormalize('café'));
  const rules = makeRules([{ id: 1, term: 'café' }]);
  const hits = scanParagraph('来一杯 café 谢谢', 1, rules);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'term');
  // 原文片段必须还原为分解写法，而不是规范化后的 café
  assert.equal(hits[0].snippet, 'café');
  assert.equal(hits[0].start, 4);
  assert.equal(hits[0].end, 9); // c a f e 组合记号 共 5 个码点
});

test('全文兼容字符：全角英数字与半角写法互相识别（NFKC 兼容场景的 NFC 边界）', () => {
  // NFC 不折叠全角/半角，因此全角写法需作为允许写法显式登记；
  // 登记后命中片段仍取原文（全角字符原样返回）。
  const rules = makeRules([{ id: 1, term: '24小时', allowed: ['２４小时'] }]);
  const hits = scanParagraph('应当在２４小时内报告', 1, rules);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'allowed');
  assert.equal(hits[0].snippet, '２４小时');
  assert.equal(hits[0].suggestion, '24小时');
});

test('最长匹配：长术语与短术语重叠时保留长规则', () => {
  const rules = makeRules([
    { id: 1, term: '数据' },
    { id: 2, term: '数据安全事件' },
  ]);
  const hits = scanParagraph('平台发生数据安全事件应当报告', 3, rules);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rule_id, 2);
  assert.equal(hits[0].snippet, '数据安全事件');
  assert.equal(hits[0].paragraph_ord, 3);
});

test('最长匹配：禁用短变体嵌套在合规长术语中时不报违规', () => {
  const rules = makeRules([
    { id: 1, term: '年度数据安全评估', forbidden: ['评估'] },
  ]);
  const hits = scanParagraph('平台应当每年开展年度数据安全评估并报送', 1, rules);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'term');
});

test('重叠消解：非重叠位置各自命中，重叠位置只留一条', () => {
  const raw: TermHit[] = [
    {
      paragraph_ord: 1, rule_id: 1, term: 'AB', kind: 'term',
      start: 0, end: 2, snippet: 'AB', context: 'AB', matched: 'AB', suggestion: 'AB',
    },
    {
      paragraph_ord: 1, rule_id: 2, term: 'ABC', kind: 'term',
      start: 0, end: 3, snippet: 'ABC', context: 'ABC', matched: 'ABC', suggestion: 'ABC',
    },
    {
      paragraph_ord: 1, rule_id: 3, term: 'XY', kind: 'forbidden',
      start: 5, end: 7, snippet: 'XY', context: 'XY', matched: 'XY', suggestion: 'XY',
    },
  ];
  const kept = selectLongestNonOverlapping(raw);
  assert.deepEqual(kept.map((h) => h.rule_id).sort(), [2, 3]);
});

test('同一段落多次出现全部记录', () => {
  const rules = makeRules([{ id: 1, term: '报告' }]);
  const hits = scanParagraph('先报告一次，再报告一次', 2, rules);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.start), [1, 7]);
  assert.ok(hits.every((h) => h.snippet === '报告'));
});

test('禁用变体命中携带建议写法；允许写法标记为 allowed', () => {
  const rules = makeRules([
    { id: 7, term: '二十四小时', allowed: ['24小时'], forbidden: ['四十八小时', '48小时'] },
  ]);
  const forbidden = scanParagraph('应当在四十八小时内报告', 1, rules);
  assert.equal(forbidden.length, 1);
  assert.equal(forbidden[0].kind, 'forbidden');
  assert.equal(forbidden[0].suggestion, '二十四小时');
  assert.match(forbidden[0].context, /四十八小时/);

  const allowed = scanParagraph('应当在24小时内报告', 1, rules);
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].kind, 'allowed');
});

test('上下文窗口：长段落命中上下文带省略号且包含命中片段', () => {
  const text = '前'.repeat(40) + '术语' + '后'.repeat(40);
  const rules = makeRules([{ id: 1, term: '术语' }]);
  const hits = scanParagraph(text, 1, rules);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].context.startsWith('…'));
  assert.ok(hits[0].context.endsWith('…'));
  assert.ok(hits[0].context.includes('术语'));
});

test('逐段扫描：段落序号 1 起始且按段内位置排序', () => {
  const rules = makeRules([{ id: 1, term: '数据' }]);
  const paras = ['无命中段落', '数据开头', '结尾是数据'];
  const hits = scanParagraphsAll(paras, rules);
  assert.deepEqual(hits.map((h) => h.paragraph_ord), [2, 3]);
});

test('规则内重复写法（含规范化后等价）只保留一份模式', () => {
  const rules = makeRules([
    { id: 1, term: 'café', allowed: ['café'] },
  ]);
  const hits = scanParagraph('café', 1, rules);
  assert.equal(hits.length, 1);
  // 等长冲突时 term 优先于 allowed
  assert.equal(hits[0].kind, 'term');
});

test('空规则 / 空段落安全返回空数组', () => {
  assert.deepEqual(scanParagraphsAll(['一段文本'], prepareRules([])), []);
  const rules = makeRules([{ id: 1, term: '术语' }]);
  assert.deepEqual(scanParagraphsAll([], rules), []);
});

test('边界索引：命中位于段落开头与结尾时原文片段正确', () => {
  const idx = buildNormalizedIndex('abc');
  assert.equal(sliceOriginal('abc', idx, 0, 1), 'a');
  assert.equal(sliceOriginal('abc', idx, 2, 3), 'c');
  // 组合记号扩展前一边界
  const idx2 = buildNormalizedIndex('aéb');
  assert.equal(sliceOriginal('aéb', idx2, 1, 2), 'é');
});

test('非 BMP 字符（emoji / 增补平面）不会使命中区间错位', () => {
  const rules = makeRules([{ id: 1, term: '术语' }]);
  const text = '😀开头有术语结尾😀';
  const hits = scanParagraph(text, 1, rules);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].snippet, '术语');
  const cps = Array.from(text);
  assert.equal(cps.slice(hits[0].start, hits[0].end).join(''), '术语');
});

test('重叠匹配：等长模式按稳定优先级（forbidden > term > allowed）仅保留一条', () => {
  const rules = prepareRules([
    { id: 2, term: 'KPI', allowed: [], forbidden: [] },
    { id: 1, term: '其他', allowed: [], forbidden: ['KPI'] },
  ]);
  const hits = scanParagraph('KPI 指标', 1, rules);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'forbidden');
});
