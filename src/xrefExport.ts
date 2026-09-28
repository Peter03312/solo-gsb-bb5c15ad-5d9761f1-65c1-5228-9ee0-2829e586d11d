import type { XrefReport } from './xref';

const STATUS_LABEL: Record<string, string> = {
  unique: '唯一匹配',
  ambiguous: '歧义',
  broken: '失效',
};

const STYLE_LABEL: Record<string, string> = {
  cn: '中文数字',
  arabic: '阿拉伯数字',
};

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * 交叉引用校验结果 CSV 导出（带 BOM，方便 Excel 直接打开中文）。
 * 每行一处引用（同段多处引用分别成行）：
 * 版本、来源段落、编号、引用原文、状态、目标段落、目标段落原文、段内起始位置、上下文。
 */
export function xrefReportToCsv(report: XrefReport): string {
  const header = [
    '版本序号',
    '版本标签',
    '来源段落序号',
    '引用编号',
    '编号写法',
    '引用原文',
    '校验状态',
    '目标段落序号',
    '候选段落序号',
    '目标段落原文',
    '段内起始位置',
    '上下文',
  ];
  const lines: string[] = [header.map(csvCell).join(',')];
  const v = report.version;
  for (const r of report.references) {
    lines.push(
      [
        v.seq,
        v.label,
        r.paragraph_ord,
        r.number,
        STYLE_LABEL[r.number_style] ?? r.number_style,
        r.text,
        STATUS_LABEL[r.status] ?? r.status,
        r.target_paragraph_ord ?? '',
        r.targets.join(' '),
        r.target_text ?? '',
        r.start,
        r.context,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return '﻿' + lines.join('\r\n');
}
