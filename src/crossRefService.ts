import type { DB } from './db';
import { splitParagraphs } from './diff';
import {
  buildCrossRefReport,
  type CrossRefReport,
  type CrossReference,
  type RefStatus,
} from './crossReference';

/**
 * 条款交叉引用校验服务：
 *  - 扫描与定位只读取用户选定的那一个项目版本（versions 行按 project_id 过滤）；
 *  - 版本不存在或属于其他项目时返回 version_not_found，由路由层映射为 404；
 *  - 状态筛选（unique / ambiguous / invalid）在服务端完成，
 *    保证页面 CSV 导出与当前筛选结果一致。
 */

export type CrossRefStatusFilter = RefStatus;

export interface CrossRefVersionResult {
  project: { id: number; name: string };
  version: {
    id: number;
    seq: number;
    label: string;
    paragraph_count: number;
  };
  scanned_at: string;
  report: CrossRefReport;
}

export type ScanVersionResult =
  | { status: 'ok'; result: CrossRefVersionResult }
  | { status: 'project_not_found' }
  | { status: 'version_not_found' }
  | { status: 'invalid'; message: string };

const VALID_STATUS = new Set<RefStatus>(['unique', 'ambiguous', 'invalid']);

/**
 * 对项目内单个版本执行条款交叉引用扫描。
 * 未知版本（含其他项目的版本 id）→ version_not_found（HTTP 404）。
 * @param statusFilter 仅保留指定状态的引用（索引与段落全文仍完整返回，供定位）
 */
export function scanVersionCrossRefs(
  db: DB,
  projectId: number,
  versionId: number,
  statusFilter?: RefStatus
): ScanVersionResult {
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return { status: 'invalid', message: '项目 id 不合法' };
  }
  if (!Number.isInteger(versionId) || versionId <= 0) {
    return { status: 'invalid', message: 'version_id 必须为正整数' };
  }

  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as
    | { id: number; name: string }
    | undefined;
  if (!project) return { status: 'project_not_found' };

  // 版本读取严格按 project_id 过滤：其他项目的版本 id 等同不存在
  const version = db
    .prepare('SELECT id, seq, label, content FROM versions WHERE id = ? AND project_id = ?')
    .get(versionId, projectId) as
    | { id: number; seq: number; label: string; content: string }
    | undefined;
  if (!version) return { status: 'version_not_found' };

  // 版本隔离先于筛选参数判定：跨项目版本即使附带非法筛选仍返回 404
  if (statusFilter !== undefined && !VALID_STATUS.has(statusFilter)) {
    return { status: 'invalid', message: '非法的引用状态筛选' };
  }

  const paragraphs = splitParagraphs(version.content);
  const full = buildCrossRefReport(paragraphs);

  const report: CrossRefReport =
    statusFilter === undefined
      ? full
      : {
          ...full,
          references: full.references.filter((r) => r.status === statusFilter),
          // 汇总始终反映完整扫描结果，避免筛选后数字含义不清
          summary: full.summary,
        };

  return {
    status: 'ok',
    result: {
      project: { id: project.id, name: project.name },
      version: {
        id: version.id,
        seq: version.seq,
        label: version.label,
        paragraph_count: paragraphs.length,
      },
      scanned_at: new Date().toISOString(),
      report,
    },
  };
}

/** 交叉引用校验页初始化：项目内版本清单（按 seq 升序，含段落数） */
export function getCrossRefOverview(
  db: DB,
  projectId: number
): { project: { id: number; name: string }; versions: Array<{ id: number; seq: number; label: string; paragraph_count: number }> } | null {
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

export type { CrossReference };
