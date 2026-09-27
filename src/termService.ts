import type { DB } from './db';
import { splitParagraphs } from './diff';
import {
  nfcNormalize,
  prepareRules,
  scanParagraphsAll,
  type TermHit,
  type TermMatchKind,
} from './terminology';

/**
 * 术语一致性审查服务：
 *  - 术语表按项目隔离（term_rules.project_id），跨项目互不可见；
 *  - 每条规则维护一个规范术语、若干允许写法与禁用变体；
 *  - 扫描时按 Unicode NFC 规范化 + 最长匹配识别段落中的术语；
 *  - 所有版本读取均按 project_id 过滤，未知版本（含其他项目的版本 id）返回 not_found。
 */

export interface TermRuleRow {
  id: number;
  project_id: number;
  term: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface TermVariantRow {
  id: number;
  rule_id: number;
  project_id: number;
  kind: 'allowed' | 'forbidden';
  variant: string;
}

export interface TermRuleDetail extends TermRuleRow {
  allowed: string[];
  forbidden: string[];
}

export type TermWriteResult =
  | { status: 'ok'; id: number }
  | { status: 'not_found' }
  | { status: 'duplicate_term'; term: string }
  | { status: 'duplicate_variant'; variant: string; rule_id: number }
  | { status: 'invalid'; message: string };

export const TERM_MAX_LENGTH = 100;
export const VARIANT_MAX_LENGTH = 100;
export const NOTE_MAX_LENGTH = 500;

/** 规整用户提交的术语 / 变体输入：NFC 规范化、去空白、去空项与项目内重复项 */
function cleanList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const s = nfcNormalize(String(v ?? '').trim());
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function cleanScalar(raw: unknown): string {
  return nfcNormalize(String(raw ?? '').trim());
}

/** 列出项目的全部术语规则（含允许写法 / 禁用变体），按 id 排序 */
export function listTermRules(db: DB, projectId: number): TermRuleDetail[] | null {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;
  const rules = db
    .prepare('SELECT * FROM term_rules WHERE project_id = ? ORDER BY id')
    .all(projectId) as TermRuleRow[];
  const variants = db
    .prepare('SELECT * FROM term_variants WHERE project_id = ? ORDER BY id')
    .all(projectId) as TermVariantRow[];
  return rules.map((r) => ({
    ...r,
    allowed: variants.filter((v) => v.rule_id === r.id && v.kind === 'allowed').map((v) => v.variant),
    forbidden: variants
      .filter((v) => v.rule_id === r.id && v.kind === 'forbidden')
      .map((v) => v.variant),
  }));
}

export function getTermRule(db: DB, projectId: number, ruleId: number): TermRuleDetail | null {
  const rule = db
    .prepare('SELECT * FROM term_rules WHERE id = ? AND project_id = ?')
    .get(ruleId, projectId) as TermRuleRow | undefined;
  if (!rule) return null;
  const variants = db
    .prepare('SELECT * FROM term_variants WHERE rule_id = ? ORDER BY id')
    .all(ruleId) as TermVariantRow[];
  return {
    ...rule,
    allowed: variants.filter((v) => v.kind === 'allowed').map((v) => v.variant),
    forbidden: variants.filter((v) => v.kind === 'forbidden').map((v) => v.variant),
  };
}

/**
 * 新建术语规则（事务）：
 *  - 规范术语必填；同一项目内规范化后的术语文本唯一；
 *  - 任一写法（术语 / 允许 / 禁用）不得与本项目其他规则的写法重复，
 *    避免同一文本对应互相矛盾的命中结论。
 */
export function createTermRule(
  db: DB,
  projectId: number,
  termRaw: unknown,
  allowedRaw: unknown,
  forbiddenRaw: unknown,
  noteRaw?: unknown
): TermWriteResult {
  const term = cleanScalar(termRaw);
  if (!term) return { status: 'invalid', message: '规范术语必填' };
  if (term.length > TERM_MAX_LENGTH) {
    return { status: 'invalid', message: `规范术语过长（最多 ${TERM_MAX_LENGTH} 字）` };
  }
  const allowed = cleanList(allowedRaw);
  const forbidden = cleanList(forbiddenRaw);
  if (allowed.some((v) => v.length > VARIANT_MAX_LENGTH)) {
    return { status: 'invalid', message: `允许写法过长（最多 ${VARIANT_MAX_LENGTH} 字）` };
  }
  if (forbidden.some((v) => v.length > VARIANT_MAX_LENGTH)) {
    return { status: 'invalid', message: `禁用变体过长（最多 ${VARIANT_MAX_LENGTH} 字）` };
  }
  const note = noteRaw === undefined || noteRaw === null ? null : String(noteRaw).trim();
  if (note !== null && note.length > NOTE_MAX_LENGTH) {
    return { status: 'invalid', message: `备注过长（最多 ${NOTE_MAX_LENGTH} 字）` };
  }

  const tx = db.transaction((): TermWriteResult => {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return { status: 'not_found' };

    if (db.prepare('SELECT id FROM term_rules WHERE project_id = ? AND term = ?').get(projectId, term)) {
      return { status: 'duplicate_term', term };
    }

    const clash = findVariantClash(db, projectId, [term, ...allowed, ...forbidden], null);
    if (clash) return { status: 'duplicate_variant', variant: clash.variant, rule_id: clash.ruleId };

    const ruleId = Number(
      db
        .prepare('INSERT INTO term_rules (project_id, term, note) VALUES (?, ?, ?)')
        .run(projectId, term, note).lastInsertRowid
    );
    insertVariants(db, projectId, ruleId, allowed, forbidden);
    return { status: 'ok', id: ruleId };
  });
  return tx();
}

/** 全量更新术语规则（术语文本、允许写法、禁用变体、备注整体替换） */
export function updateTermRule(
  db: DB,
  projectId: number,
  ruleId: number,
  termRaw: unknown,
  allowedRaw: unknown,
  forbiddenRaw: unknown,
  noteRaw?: unknown
): TermWriteResult {
  const term = cleanScalar(termRaw);
  if (!term) return { status: 'invalid', message: '规范术语必填' };
  if (term.length > TERM_MAX_LENGTH) {
    return { status: 'invalid', message: `规范术语过长（最多 ${TERM_MAX_LENGTH} 字）` };
  }
  const allowed = cleanList(allowedRaw);
  const forbidden = cleanList(forbiddenRaw);
  if (allowed.some((v) => v.length > VARIANT_MAX_LENGTH)) {
    return { status: 'invalid', message: `允许写法过长（最多 ${VARIANT_MAX_LENGTH} 字）` };
  }
  if (forbidden.some((v) => v.length > VARIANT_MAX_LENGTH)) {
    return { status: 'invalid', message: `禁用变体过长（最多 ${VARIANT_MAX_LENGTH} 字）` };
  }
  const note = noteRaw === undefined || noteRaw === null ? null : String(noteRaw).trim();
  if (note !== null && note.length > NOTE_MAX_LENGTH) {
    return { status: 'invalid', message: `备注过长（最多 ${NOTE_MAX_LENGTH} 字）` };
  }

  const tx = db.transaction((): TermWriteResult => {
    const rule = db
      .prepare('SELECT id FROM term_rules WHERE id = ? AND project_id = ?')
      .get(ruleId, projectId);
    if (!rule) return { status: 'not_found' };

    const dup = db
      .prepare('SELECT id FROM term_rules WHERE project_id = ? AND term = ? AND id <> ?')
      .get(projectId, term, ruleId);
    if (dup) return { status: 'duplicate_term', term };

    const clash = findVariantClash(db, projectId, [term, ...allowed, ...forbidden], ruleId);
    if (clash) return { status: 'duplicate_variant', variant: clash.variant, rule_id: clash.ruleId };

    db.prepare(
      `UPDATE term_rules SET term = ?, note = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`
    ).run(term, note, ruleId);
    db.prepare('DELETE FROM term_variants WHERE rule_id = ?').run(ruleId);
    insertVariants(db, projectId, ruleId, allowed, forbidden);
    return { status: 'ok', id: ruleId };
  });
  return tx();
}

/** 删除术语规则（变体随之外键级联删除） */
export function deleteTermRule(
  db: DB,
  projectId: number,
  ruleId: number
): 'ok' | 'not_found' {
  const info = db
    .prepare('DELETE FROM term_rules WHERE id = ? AND project_id = ?')
    .run(ruleId, projectId);
  return info.changes === 0 ? 'not_found' : 'ok';
}

function insertVariants(
  db: DB,
  projectId: number,
  ruleId: number,
  allowed: string[],
  forbidden: string[]
): void {
  const stmt = db.prepare(
    'INSERT INTO term_variants (rule_id, project_id, kind, variant) VALUES (?, ?, ?, ?)'
  );
  for (const v of allowed) stmt.run(ruleId, projectId, 'allowed', v);
  for (const v of forbidden) stmt.run(ruleId, projectId, 'forbidden', v);
}

/** 检查写法是否与本项目其他规则（excludeRuleId 之外）的任一字面量重复 */
function findVariantClash(
  db: DB,
  projectId: number,
  literals: string[],
  excludeRuleId: number | null
): { variant: string; ruleId: number } | null {
  const rules = db
    .prepare('SELECT id, term FROM term_rules WHERE project_id = ?')
    .all(projectId) as Array<{ id: number; term: string }>;
  const variants = db
    .prepare('SELECT rule_id, variant FROM term_variants WHERE project_id = ?')
    .all(projectId) as Array<{ rule_id: number; variant: string }>;
  for (const literal of literals) {
    for (const r of rules) {
      if (excludeRuleId != null && r.id === excludeRuleId) continue;
      if (r.term === literal) return { variant: literal, ruleId: r.id };
    }
    for (const v of variants) {
      if (excludeRuleId != null && v.rule_id === excludeRuleId) continue;
      if (v.variant === literal) return { variant: literal, ruleId: v.rule_id };
    }
  }
  return null;
}

export interface ScanVersion {
  version_id: number;
  seq: number;
  label: string;
  paragraph_count: number;
  hits: TermHit[];
}

export interface ScanReport {
  project_id: number;
  scanned_at: string;
  versions: ScanVersion[];
  /** 本次扫描实际使用的规则快照（含允许 / 禁用写法） */
  rules: TermRuleDetail[];
  summary: {
    versions: number;
    paragraphs: number;
    total: number;
    forbidden: number;
    allowed: number;
    term: number;
  };
}

export type ScanResult =
  | { status: 'ok'; report: ScanReport }
  | { status: 'project_not_found' }
  | { status: 'version_not_found'; version_ids: number[] }
  | { status: 'rule_not_found'; rule_ids: number[] }
  | { status: 'invalid'; message: string };

/**
 * 对一个项目内的一个或多个版本执行术语扫描：
 *  - 版本必须全部存在且属于该项目，否则整体返回 version_not_found（未知版本 → HTTP 404）；
 *  - 命中记录返回段落序号、原文片段、上下文与命中规则；
 *  - ruleFilter 非空时只使用指定规则（且必须属于本项目，否则按 404 交由路由层处理）。
 */
export function scanVersions(
  db: DB,
  projectId: number,
  versionIds: number[],
  ruleFilter?: number[]
): ScanResult {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return { status: 'project_not_found' };
  if (!Array.isArray(versionIds) || versionIds.length === 0) {
    return { status: 'invalid', message: '请至少选择一个版本' };
  }
  const ids = [...new Set(versionIds)];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    return { status: 'invalid', message: '版本 id 不合法' };
  }

  const versions = db
    .prepare(
      `SELECT id, label, seq, content FROM versions
        WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')})`
    )
    .all(projectId, ...ids) as Array<{ id: number; label: string; seq: number; content: string }>;

  const foundIds = new Set(versions.map((v) => v.id));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) return { status: 'version_not_found', version_ids: missing };

  const allRules = listTermRules(db, projectId);
  if (!allRules) return { status: 'project_not_found' };
  let rules = allRules;
  if (ruleFilter && ruleFilter.length > 0) {
    if (ruleFilter.some((id) => !Number.isInteger(id) || id <= 0)) {
      return { status: 'invalid', message: '术语规则 id 不合法' };
    }
    const filterSet = new Set(ruleFilter);
    const missingRules = ruleFilter.filter((id) => !allRules.some((r) => r.id === id));
    if (missingRules.length > 0) {
      return { status: 'rule_not_found', rule_ids: missingRules };
    }
    rules = allRules.filter((r) => filterSet.has(r.id));
  }

  const preparedRules = prepareRules(
    rules.map((r) => ({ id: r.id, term: r.term, allowed: r.allowed, forbidden: r.forbidden }))
  );

  const scanVersions: ScanVersion[] = [];
  let totalParas = 0;
  // 按版本 seq、其次 id 排序，输出顺序稳定
  versions.sort((a, b) => a.seq - b.seq || a.id - b.id);
  for (const v of versions) {
    const paragraphs = splitParagraphs(v.content);
    totalParas += paragraphs.length;
    scanVersions.push({
      version_id: v.id,
      seq: v.seq,
      label: v.label,
      paragraph_count: paragraphs.length,
      hits: scanParagraphsAll(paragraphs, preparedRules),
    });
  }

  const allHits = scanVersions.flatMap((sv) => sv.hits);
  const countBy = (kind: TermMatchKind) => allHits.filter((h) => h.kind === kind).length;
  return {
    status: 'ok',
    report: {
      project_id: projectId,
      scanned_at: new Date().toISOString(),
      versions: scanVersions,
      rules,
      summary: {
        versions: scanVersions.length,
        paragraphs: totalParas,
        total: allHits.length,
        forbidden: countBy('forbidden'),
        allowed: countBy('allowed'),
        term: countBy('term'),
      },
    },
  };
}

export interface VersionBrief {
  id: number;
  seq: number;
  label: string;
  paragraph_count: number;
}

/** 扫描页初始化数据：项目内版本清单（按 seq 排序）与术语规则，一次拉齐 */
export function getTerminologyOverview(
  db: DB,
  projectId: number
): { project: { id: number; name: string }; versions: VersionBrief[]; rules: TermRuleDetail[] } | null {
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as
    | { id: number; name: string }
    | undefined;
  if (!project) return null;
  const rows = db
    .prepare('SELECT id, seq, label, content FROM versions WHERE project_id = ? ORDER BY seq')
    .all(projectId) as Array<{ id: number; seq: number; label: string; content: string }>;
  const versions: VersionBrief[] = rows.map((v) => ({
    id: v.id,
    seq: v.seq,
    label: v.label,
    paragraph_count: splitParagraphs(v.content).length,
  }));
  const rules = listTermRules(db, projectId) ?? [];
  return { project, versions, rules };
}
