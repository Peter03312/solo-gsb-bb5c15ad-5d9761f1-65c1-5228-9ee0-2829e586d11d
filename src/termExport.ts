import type { ScanReport } from './termService';

const KIND_LABEL: Record<string, string> = {
  term: '规范术语',
  allowed: '允许写法',
  forbidden: '禁用变体',
};

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * 术语扫描结果 CSV 导出（带 BOM，方便 Excel 直接打开中文）。
 * 每行一处命中：版本、段落序号、命中类型、规范术语、命中原文、建议写法、上下文。
 */
export function termScanToCsv(report: ScanReport): string {
  const header = [
    '版本序号',
    '版本标签',
    '段落序号',
    '命中类型',
    '规范术语',
    '命中原文',
    '建议写法',
    '段内起始位置',
    '上下文',
    '规则ID',
  ];
  const lines: string[] = [header.map(csvCell).join(',')];
  for (const v of report.versions) {
    for (const h of v.hits) {
      lines.push(
        [
          v.seq,
          v.label,
          h.paragraph_ord,
          KIND_LABEL[h.kind] ?? h.kind,
          h.term,
          h.snippet,
          h.suggestion,
          h.start,
          h.context,
          h.rule_id,
        ]
          .map(csvCell)
          .join(',')
      );
    }
  }
  return '\uFEFF' + lines.join('\r\n');
}
