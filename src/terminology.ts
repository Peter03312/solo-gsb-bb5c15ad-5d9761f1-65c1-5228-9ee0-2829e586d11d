/**
 * 术语一致性审查引擎（纯函数，不依赖数据库）：
 *  - nfcNormalize：按 Unicode NFC 规范化文本（统一组合记号 / 预组合字符等不同写法）；
 *  - buildNormalizedIndex：记录规范化文本与原文的码点边界对应关系，命中后可还原原文片段；
 *  - scanParagraph：以「规范化后字面量最长匹配」在段落中识别术语，
 *    同一段落内的重叠命中只保留最长的一条（长模式胜出；等长时按规则 / 类型稳定排序）。
 *
 * 说明：
 *  - 规范术语自身与允许写法（allowed）命中后给出合规记录（term / allowed）；
 *  - 禁用变体（forbidden）命中后给出违规记录，并回传建议写法；
 *  - 匹配不做分词、不使用正则，规范化后的子串即命中（最长匹配负责抑制短术语的嵌套命中）；
 *  - NFC 不折叠全角 / 半角等 NFKC 兼容差异，需要互相识别时把另一种写法登记为允许写法。
 */

export type TermMatchKind = 'term' | 'allowed' | 'forbidden';

export interface ScanPattern {
  ruleId: number;
  term: string;
  /** 该模式对应的规范化文本 */
  pattern: string;
  kind: TermMatchKind;
  /** term / allowed 时为命中文本自身；forbidden 时为建议采用的规范术语 */
  suggestion: string;
}

export interface PreparedRule {
  id: number;
  term: string;
  patterns: ScanPattern[];
}

/** NFC 规范化：把同一字符的不同 Unicode 表示（如 é 的单码点 / e+组合音符）统一 */
export function nfcNormalize(s: string): string {
  return s.normalize('NFC');
}

interface NormalizedIndex {
  normalized: string;
  /**
   * 规范化文本各码点 → 原文码点偏移（0 起始），数组长度 = 规范码点数：
   *   starts[k] = 规范化文本第 k 个码点在原文中的起始偏移
   *   ends[k]   = 规范化文本第 k 个码点在原文中的结束偏移（exclusive）
   * 组合（多原码点 → 一规范码点）时该码点区间覆盖其全部原码点。
   */
  starts: number[];
  ends: number[];
}

/**
 * 建立原文 → NFC 规范化文本的码点边界索引。
 *
 * 维护两条等长映射（长度 = 规范码点数，保存的都是「原文码点偏移」）：
 *  - starts[k]：规范文本第 k 个码点对应的原文起始偏移；
 *  - ends[k]：规范文本第 k 个码点对应的原文结束偏移（exclusive）。
 *
 * 逐个原码点求「NFC(前缀)」并与上一步比较：
 *  - 追加普通码点：规范化文本末尾新增码点，区间即 [i, i+1)；
 *  - 追加组合记号并与前一码点合成为单码点（如 e + U+0301 → é）：
 *    规范化文本长度不变、末码点被替换，扩展该码点的结束边界即可。
 * 码点级处理，避免 UTF-16 代理项把字符拦腰截断。
 */
export function buildNormalizedIndex(text: string): NormalizedIndex {
  const cps = Array.from(text);
  // starts[k] / ends[k]：规范文本第 k 个码点在原文中的起始 / 结束偏移，数组长度均为规范码点数
  const starts: number[] = [];
  const ends: number[] = [];
  let prev = '';
  let prevLen = 0;
  for (let i = 0; i < cps.length; i++) {
    const cur = (prev + cps[i]).normalize('NFC');
    const curLen = Array.from(cur).length;
    if (cur === prev) continue; // 防御：NFC 规范化不应吞掉码点
    if (cur.startsWith(prev) && curLen >= prevLen) {
      // 在末尾追加了一个或多个规范码点（NFC 通常恰好追加 1 个）
      for (let k = 0; k < curLen - prevLen; k++) {
        starts.push(k === 0 ? i : i + 1);
        ends.push(i + 1);
      }
    } else {
      // 组合情形：末位规范码点被合成结果替换，其原文区间向后扩展一个码点
      ends[ends.length - 1] = i + 1;
    }
    prev = cur;
    prevLen = curLen;
  }
  return { normalized: text.normalize('NFC'), starts, ends };
}

/** 把规范化文本上的命中区间 [normStart, normEnd) 还原为原文片段 */
export function sliceOriginal(
  text: string,
  idx: NormalizedIndex,
  normStart: number,
  normEnd: number
): string {
  const cps = Array.from(text);
  const s = idx.starts[normStart] ?? 0;
  const e = idx.ends[Math.min(Math.max(normEnd - 1, 0), idx.ends.length - 1)] ?? cps.length;
  return cps.slice(s, e).join('');
}

/** 上下文窗口（码点数）：命中前后各取若干字符，并对窗口做省略号裁剪 */
const CONTEXT_RADIUS = 24;

export interface TermHit {
  /** 段落序号（1 起始） */
  paragraph_ord: number;
  /** 命中的术语规则 id */
  rule_id: number;
  /** 规范术语 */
  term: string;
  /** 命中类型：term 规范术语 / allowed 允许写法 / forbidden 禁用变体 */
  kind: TermMatchKind;
  /** 段内命中的起始 / 结束码点偏移（基于原文，0 起始，end 为 exclusive） */
  start: number;
  end: number;
  /** 原文片段（未规范化，按命中边界从原段落截取） */
  snippet: string;
  /** 命中上下文（原文，带省略号），便于前端直接展示 */
  context: string;
  /** 命中模式的规范化文本 */
  matched: string;
  /** forbidden 时建议替换为的规范写法；term / allowed 时为命中文本自身 */
  suggestion: string;
}

/**
 * 收集某一规则在单段落规范化文本上的全部字面量出现（同段落可多次出现）。
 * 全程使用码点（Array.from），避免 emoji 等非 BMP 字符的 UTF-16 代理项导致索引错位。
 * 直接子串扫描；术语表与段落规模都很小，无需 Aho-Corasick。
 */
function findOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  const hay = Array.from(haystack);
  const ndl = Array.from(needle);
  outer: for (let i = 0; i + ndl.length <= hay.length; i++) {
    for (let k = 0; k < ndl.length; k++) {
      if (hay[i + k] !== ndl[k]) continue outer;
    }
    out.push(i);
    i += ndl.length - 1; // 允许重叠出现时由下一轮循环处理；非重叠匹配可直接跳过
  }
  return out;
}

/**
 * 同一段落的重叠命中按最长规则保留：
 * 对每个位置只允许存在一条命中——按模式长度降序贪心落位，
 * 长模式先占区间，与之重叠的短模式全部丢弃；等长时按规则 id / 类型稳定排序。
 */
export function selectLongestNonOverlapping(raw: TermHit[]): TermHit[] {
  const ordered = [...raw].sort((a, b) => {
    if (b.end - b.start !== a.end - a.start) return b.end - b.start - (a.end - a.start);
    if (a.rule_id !== b.rule_id) return a.rule_id - b.rule_id;
    const kindRank: Record<TermMatchKind, number> = { forbidden: 0, term: 1, allowed: 2 };
    if (kindRank[a.kind] !== kindRank[b.kind]) return kindRank[a.kind] - kindRank[b.kind];
    return a.start - b.start;
  });
  const kept: TermHit[] = [];
  for (const hit of ordered) {
    const overlap = kept.some((k) => hit.start < k.end && k.start < hit.end);
    if (!overlap) kept.push(hit);
  }
  kept.sort((a, b) => a.start - b.start || a.rule_id - b.rule_id);
  return kept;
}

function buildContext(text: string, startCp: number, endCp: number): string {
  const cps = Array.from(text);
  const s = Math.max(0, startCp - CONTEXT_RADIUS);
  const e = Math.min(cps.length, endCp + CONTEXT_RADIUS);
  const prefix = s > 0 ? '…' : '';
  const suffix = e < cps.length ? '…' : '';
  return prefix + cps.slice(s, e).join('') + suffix;
}

/**
 * 对一个段落执行术语扫描，返回重叠消解后的命中（按段内位置排序）。
 * @param paragraph 原文段落（未规范化）
 * @param ord 段落序号（1 起始）
 * @param rules 已准备好的术语规则（模式已 NFC 规范化、去重、按长度排序）
 */
export function scanParagraph(paragraph: string, ord: number, rules: PreparedRule[]): TermHit[] {
  const idx = buildNormalizedIndex(paragraph);
  const cps = Array.from(paragraph);
  const raw: TermHit[] = [];
  for (const rule of rules) {
    for (const p of rule.patterns) {
      const occurrences = findOccurrences(idx.normalized, p.pattern);
      for (const normStart of occurrences) {
        const normEnd = normStart + Array.from(p.pattern).length;
        const start = idx.starts[normStart] ?? 0;
        const endIdx = Math.min(Math.max(normEnd - 1, 0), idx.ends.length - 1);
        const end = idx.ends[endIdx] ?? cps.length;
        raw.push({
          paragraph_ord: ord,
          rule_id: rule.id,
          term: rule.term,
          kind: p.kind,
          start,
          end,
          snippet: cps.slice(start, end).join(''),
          context: buildContext(paragraph, start, end),
          matched: p.pattern,
          suggestion: p.suggestion,
        });
      }
    }
  }
  return selectLongestNonOverlapping(raw);
}

/** 逐段扫描（段落切分规则与版本导入 / 条款沿革保持一致，由调用方传入） */
export function scanParagraphsAll(paragraphs: string[], rules: PreparedRule[]): TermHit[] {
  if (rules.length === 0) return [];
  const hits: TermHit[] = [];
  paragraphs.forEach((para, i) => {
    hits.push(...scanParagraph(para, i + 1, rules));
  });
  return hits;
}

/** 同一规则内 / 规则间的规范化模式去重：等长冲突时 term > allowed > forbidden，长模式永远保留 */
export function prepareRules(
  input: Array<{
    id: number;
    term: string;
    allowed: string[];
    forbidden: string[];
  }>
): PreparedRule[] {
  return input.map((r) => {
    const termNfc = nfcNormalize(r.term);
    const seen = new Set<string>();
    const patterns: ScanPattern[] = [];
    const add = (raw: string, kind: TermMatchKind, suggestion: string) => {
      const pattern = nfcNormalize(raw);
      if (!pattern || seen.has(pattern)) return;
      seen.add(pattern);
      patterns.push({ ruleId: r.id, term: r.term, pattern, kind, suggestion });
    };
    add(r.term, 'term', termNfc);
    for (const a of r.allowed) add(a, 'allowed', termNfc);
    for (const f of r.forbidden) add(f, 'forbidden', termNfc);
    patterns.sort((a, b) => Array.from(b.pattern).length - Array.from(a.pattern).length);
    return { id: r.id, term: r.term, patterns };
  });
}
