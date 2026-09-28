import type { DB } from './db';
import { splitParagraphs } from './diff';
import { scanCrossReferences, type XrefReport } from './xref';

/**
 * 条款交叉引用校验服务：
 *  - 在项目详情页选定一个版本，服务端只读取该版本、按同一套段落切分规则扫描；
 *  - 版本不存在或不属于该项目（含其他项目的版本 id）→ version_not_found（HTTP 404）；
 *  - 扫描结果与定位均不跨版本、不跨项目。
 */

export type XrefScanResult =
  | { status: 'ok'; report: XrefReport }
  | { status: 'project_not_found' }
  | { status: 'version_not_found' }
  | { status: 'invalid'; message: string };

/** 对项目内单个版本执行交叉引用校验；扫描只使用所选版本，绝不读取其他版本 */
export function scanVersionXref(
  db: DB,
  projectId: number,
  versionId: number
): XrefScanResult {
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return { status: 'invalid', message: '项目 id 不合法' };
  }
  if (!Number.isInteger(versionId) || versionId <= 0) {
    return { status: 'invalid', message: 'version_id 必须为正整数' };
  }
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return { status: 'project_not_found' };

  const version = db
    .prepare('SELECT id, seq, label, content FROM versions WHERE id = ? AND project_id = ?')
    .get(versionId, projectId) as
    | { id: number; seq: number; label: string; content: string }
    | undefined;
  if (!version) return { status: 'version_not_found' };

  const paragraphs = splitParagraphs(version.content);
  const scanned = scanCrossReferences(paragraphs);
  const report: XrefReport = {
    scanned_at: new Date().toISOString(),
    version: {
      version_id: version.id,
      seq: version.seq,
      label: version.label,
      paragraph_count: paragraphs.length,
    },
    ...scanned,
  };
  return { status: 'ok', report };
}

export interface XrefOverview {
  project: { id: number; name: string };
  versions: Array<{ id: number; seq: number; label: string; paragraph_count: number }>;
}

/** 交叉引用校验页初始化数据：项目信息与项目内版本清单（按 seq 排序） */
export function getXrefOverview(db: DB, projectId: number): XrefOverview | null {
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as
    | { id: number; name: string }
    | undefined;
  if (!project) return null;
  const rows = db
    .prepare('SELECT id, seq, label, content FROM versions WHERE project_id = ? ORDER BY seq')
    .all(projectId) as Array<{ id: number; seq: number; label: string; content: string }>;
  return {
    project,
    versions: rows.map((v) => ({
      id: v.id,
      seq: v.seq,
      label: v.label,
      paragraph_count: splitParagraphs(v.content).length,
    })),
  };
}
