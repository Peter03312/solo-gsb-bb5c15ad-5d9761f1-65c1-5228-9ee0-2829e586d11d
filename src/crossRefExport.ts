import type { CrossRefVersionResult } from './crossRefService';

const STATUS_LABEL: Record<string, string> = {
  unique: '唯一',
  ambiguous: '歧义',
  invalid: '失效',
};

const STYLE_LABEL: Record<string, string> = {
  chinese: '汉字数字',
  arabic: '阿拉伯数字',
};

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * 条款交叉引用校验结果 CSV 导出（带 BOM，方便 Excel 直接打开中文）。
 * 每行一处引用：来源段落、段内序号、引用写法、编号、状态、目标段落、是否自引、上下文。
 * 引用列表按调用方给定的筛选条件生成，因此导出内容与页面当前筛选严格一致。
 */
export function crossRefsToCsv(result: CrossRefVersionResult): string {
  const header = [
    '版本序号',
    '版本标签',
    '来源段落',
    '段内引用序号',
    '引用写法',
    '编号写法',
    '条款编号',
    '校验状态',
    '目标段落',
    '是否标题自引',
    '段内起始位置',
    '上下文',
  ];
  const lines: string[] = [header.map(csvCell).join(',')];
  const { version, report } = result;
  for (const r of report.references) {
    lines.push(
      [
        version.seq,
        version.label,
        r.paragraph_ord,
        r.ref_ord,
        r.text,
        STYLE_LABEL[r.style] ?? r.style,
        r.number,
        STATUS_LABEL[r.status] ?? r.status,
        r.targets.join(' '),
        r.self_reference ? '是' : '否',
        r.start,
        r.context,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return '\uFEFF' + lines.join('\r\n');
}
