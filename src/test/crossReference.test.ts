import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChineseNumeral, buildCrossRefReport } from '../crossReference';

/**
 * 条款交叉引用校验引擎测试：
 *  - 汉字 / 阿拉伯数字编号解析（一至九十九，含「两」、超范围不匹配）；
 *  - 段落开头标题建索引、标题自身不算引用；
 *  - 唯一 / 歧义 / 失效三类状态、同段多处引用分别列出、自引标记。
 */

test('汉字数字解析：一～九十九', () => {
  assert.equal(parseChineseNumeral('一'), 1);
  assert.equal(parseChineseNumeral('两'), 2);
  assert.equal(parseChineseNumeral('十'), 10);
  assert.equal(parseChineseNumeral('十二'), 12);
  assert.equal(parseChineseNumeral('二十'), 20);
  assert.equal(parseChineseNumeral('二十三'), 23);
  assert.equal(parseChineseNumeral('九十九'), 99);
  // 超范围 / 非法写法
  assert.equal(parseChineseNumeral('一百'), null);
  assert.equal(parseChineseNumeral('零'), null);
  assert.equal(parseChineseNumeral('百'), null);
  assert.equal(parseChineseNumeral(''), null);
});

test('标题建索引：段落开头的「第十二条」建索引，标题自身不算引用', () => {
  const paras = [
    '第一条 总则。',
    '第十二条 数据处理应当符合第十二条要求。',
  ];
  const r = buildCrossRefReport(paras);
  assert.equal(r.summary.indexed_numbers, 2);
  assert.deepEqual(r.index.map((e) => e.number), [1, 12]);
  // 第二段标题自身不计；正文中的「第十二条」为唯一自引
  assert.equal(r.references.length, 1);
  assert.equal(r.references[0].status, 'unique');
  assert.equal(r.references[0].number, 12);
  assert.equal(r.references[0].paragraph_ord, 2);
  assert.equal(r.references[0].self_reference, true);
  assert.deepEqual(r.references[0].targets, [2]);
});

test('阿拉伯数字标题「第12条」与汉字标题共用同一编号索引', () => {
  const paras = [
    '第3条 某要求。',
    '第三条 另一处写法，详见第3条。',
  ];
  const r = buildCrossRefReport(paras);
  // 编号 3 对应两段 → 歧义定义
  const entry = r.index.find((e) => e.number === 3)!;
  assert.equal(entry.status, 'ambiguous');
  assert.deepEqual(entry.paragraph_ords, [1, 2]);
  assert.deepEqual(
    entry.headings.map((h) => h.style),
    ['arabic', 'chinese']
  );
  // 正文引用「第3条」解析为歧义，两个目标都列出
  const ref = r.references.find((x) => x.paragraph_ord === 2)!;
  assert.equal(ref.status, 'ambiguous');
  assert.deepEqual(ref.targets, [1, 2]);
});

test('失效引用：编号无对应段落', () => {
  const paras = [
    '第一条 总则。',
    '第二条 参见第九十九条与第55条的规定。',
  ];
  const r = buildCrossRefReport(paras);
  const nums = r.references.map((x) => x.number).sort((a, b) => a - b);
  assert.deepEqual(nums, [55, 99]);
  for (const ref of r.references) {
    assert.equal(ref.status, 'invalid');
    assert.deepEqual(ref.targets, []);
  }
});

test('唯一匹配给出目标段落；同段多处引用分别列出并给出段内序号', () => {
  const paras = [
    '第一条 总则。',
    '第二条 义务。',
    '第三条 先依第一条，再依第二条；第一条另有规定的从其规定。',
  ];
  const r = buildCrossRefReport(paras);
  const p3 = r.references.filter((x) => x.paragraph_ord === 3);
  assert.equal(p3.length, 3);
  assert.deepEqual(
    p3.map((x) => [x.ref_ord, x.number, x.status, x.targets[0]]),
    [
      [1, 1, 'unique', 1],
      [2, 2, 'unique', 2],
      [3, 1, 'unique', 1],
    ]
  );
  // 段内位置严格递增
  for (let i = 1; i < p3.length; i++) assert.ok(p3[i].start > p3[i - 1].start);
  assert.equal(r.summary.unique, 3);
});

test('边界：第一百条 / 第100条超出支持范围不产生编号', () => {
  const paras = ['第一百条 超范围标题，正文引用第一百条和第100条。'];
  const r = buildCrossRefReport(paras);
  // 无标题索引（第一百不匹配），也无引用（100 两位后不允许第三位数字）
  assert.equal(r.index.length, 0);
  assert.equal(r.references.length, 0);
});

test('非段落开头的「第…条」不建标题索引，但正文中仍作为引用扫描', () => {
  const paras = ['前言：第五条另有规定。', '第五条 本体。'];
  const r = buildCrossRefReport(paras);
  // 仅第二段开头标题为编号 5 建索引
  assert.deepEqual(r.index.map((e) => e.number), [5]);
  assert.equal(r.index[0].paragraph_ords.length, 1);
  const ref = r.references.find((x) => x.paragraph_ord === 1)!;
  assert.equal(ref.status, 'unique');
  assert.deepEqual(ref.targets, [2]);
});

test('段落允许前导空白，偏移与上下文按码点计算', () => {
  const paras = ['  第七条 见第十二条。', '第十二条 本体。'];
  const r = buildCrossRefReport(paras);
  const ref = r.references[0];
  assert.equal(ref.paragraph_ord, 1);
  assert.equal(ref.text, '第十二条');
  // 前导两空格 + 第七条(3) + 空格 + 见 = 7 个码点
  assert.equal(ref.start, 7);
  assert.ok(ref.context.includes('第十二条'));
});
