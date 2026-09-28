/**
 * 条款交叉引用校验引擎（纯函数，不依赖数据库）：
 *  - 段落切分规则与版本导入 / 条款沿革 / 术语扫描完全一致（由调用方传入切好的段落）；
 *  - 以段落开头的「第十二条」「第12条」建立条款编号索引（支持一至九十九）；
 *  - 扫描正文中的同类条款引用：唯一匹配给出目标段落，编号缺失为失效，对应多段为歧义；
 *  - 段落开头的标题自身不算引用；同一段落内的多处引用按出现顺序分别列出。
 *
 * 编号写法：
 *  - 汉字数字：一～九十九（含「两」，如「第十二条」「第二十三条」「第九十九条」）；
 *  - 阿拉伯数字：1～99（如「第12条」）；
 *  - 「第一百条」「第100条」等超出范围的写法不匹配（百不是汉字数字位、
 *    两位数字后不允许再跟数字），不会产生编号为 1 的误命中。
 *
 * 所有段内偏移均以码点为单位（Array.from 口径），避免 emoji 等代理项截断字符。
 */

export type NumeralStyle = 'chinese' | 'arabic';
export type RefStatus = 'unique' | 'ambiguous' | 'invalid';
/** 编号索引状态：编号恰好对应一段为 unique，对应多段为 ambiguous */
export type IndexStatus = 'unique' | 'ambiguous';

export interface HeadingDef {
  /** 段落序号（1 起始） */
  paragraph_ord: number;
  /** 解析出的条款编号（1～99） */
  number: number;
  style: NumeralStyle;
  /** 标题原文，如「第十二条」「第12条」 */
  text: string;
  /** 段内码点偏移（0 起始，end 为 exclusive） */
  start: number;
  end: number;
}

export interface ClauseIndexEntry {
  number: number;
  /** 该编号对应的全部段落序号（1 起始，升序） */
  paragraph_ords: number[];
  status: IndexStatus;
  headings: Array<Pick<HeadingDef, 'paragraph_ord' | 'style' | 'text'>>;
}

export interface CrossReference {
  /** 来源段落序号（1 起始） */
  paragraph_ord: number;
  /** 同段第几处引用（1 起始，按出现位置排序） */
  ref_ord: number;
  /** 引用的条款编号 */
  number: number;
  style: NumeralStyle;
  /** 引用原文，如「第十二条」「第12条」 */
  text: string;
  /** 来源段内码点偏移（0 起始，end 为 exclusive；标题自身不占引用位置） */
  start: number;
  end: number;
  /** 引用上下文（命中前后各约 24 个码点，带省略号） */
  context: string;
  /** unique：唯一目标；ambiguous：编号对应多段；invalid：编号无对应段落 */
  status: RefStatus;
  /** 解析出的目标段落序号：唯一时 1 个、歧义时多个、失效时为空 */
  targets: number[];
  /** 引用编号与来源段落自身标题编号相同（仍按全局索引解析，不因此改变状态） */
  self_reference: boolean;
}

export interface ScannedParagraph {
  ord: number;
  text: string;
  heading: HeadingDef | null;
}

export interface CrossRefSummary {
  paragraph_count: number;
  /** 建立索引的编号种数（同一编号重复定义只算一种） */
  indexed_numbers: number;
  /** 引用总数 */
  total: number;
  unique: number;
  ambiguous: number;
  invalid: number;
}

export interface CrossRefReport {
  paragraphs: ScannedParagraph[];
  /** 编号索引，按编号升序 */
  index: ClauseIndexEntry[];
  /** 全部引用，按来源段落、段内位置排序 */
  references: CrossReference[];
  summary: CrossRefSummary;
}

/** 汉字数字位（含「两」）；「百 / 千 / 零 / 〇」不在其中，超范围写法天然不匹配 */
const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/**
 * 解析 1～99 的汉字数字写法：
 *  十 → 10；十二 → 12；二十 → 20；二十三 → 23；九十九 → 99。
 * 非法写法（空、多「十」、含其他字）返回 null。
 */
export function parseChineseNumeral(s: string): number | null {
  if (!s) return null;
  if (s === '十') return 10;
  if (s.startsWith('十')) {
    const ones = CN_DIGITS[s.slice(1)];
    return s.length === 2 && ones !== undefined && ones !== 10 ? 10 + ones : null;
  }
  if (s.endsWith('十')) {
    const tens = CN_DIGITS[s.slice(0, -1)];
    return s.length === 2 && tens !== undefined && tens !== 10 ? tens * 10 : null;
  }
  const shi = s.indexOf('十');
  if (shi >= 1 && s.length === 3) {
    const tens = CN_DIGITS[s[shi - 1]];
    const ones = CN_DIGITS[s[shi + 1]];
    if (tens !== undefined && tens !== 10 && ones !== undefined && ones !== 10) {
      return tens * 10 + ones;
    }
  }
  if (s.length === 1) {
    const n = CN_DIGITS[s];
    return n !== undefined && n !== 10 ? n : null;
  }
  return null;
}

/** 条款引用 / 标题的统一模式：汉字（1～3 位）或两位以内阿拉伯数字，首尾为「第…条」 */
const CLAUSE_PATTERN = /第(?:([一二两三四五六七八九十]{1,3})|([0-9]{1,2}))条/gu;

interface RawMatch {
  /** UTF-16 偏移 */
  index: number;
  text: string;
  number: number;
  style: NumeralStyle;
}

function findClauseMatches(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(CLAUSE_PATTERN)) {
    if (m.index == null) continue;
    let number: number | null = null;
    let style: NumeralStyle;
    if (m[1] !== undefined) {
      number = parseChineseNumeral(m[1]);
      style = 'chinese';
    } else {
      number = Number(m[2]);
      style = 'arabic';
    }
    // 汉字组理论上 1～99；仍统一做范围兜底（一至九十九）
    if (number == null || number < 1 || number > 99) continue;
    out.push({ index: m.index, text: m[0], number, style });
  }
  return out;
}

/**
 * 构造 UTF-16 索引 → 码点偏移的映射：
 * map[i] 为 UTF-16 位置 i 处对应的码点序号（高位代理计入、低位代理不重复计）。
 */
function utf16ToCodePointMap(text: string): number[] {
  const map = new Array<number>(text.length + 1).fill(0);
  let cp = 0;
  for (let i = 0; i < text.length; i++) {
    map[i] = cp;
    const code = text.charCodeAt(i);
    // 低位代理已随前一高位代理计为一个码点，不重复累加
    if (code < 0xdc00 || code > 0xdfff) cp++;
  }
  map[text.length] = cp;
  return map;
}

/** 上下文窗口（码点数）：引用前后各取若干字符，并对窗口做省略号裁剪 */
const CONTEXT_RADIUS = 24;

function buildContext(cps: string[], start: number, end: number): string {
  const s = Math.max(0, start - CONTEXT_RADIUS);
  const e = Math.min(cps.length, end + CONTEXT_RADIUS);
  const prefix = s > 0 ? '…' : '';
  const suffix = e < cps.length ? '…' : '';
  return prefix + cps.slice(s, e).join('') + suffix;
}

/**
 * 对选定版本的段落列表执行交叉引用校验。
 * @param paragraphTexts 与版本导入同一套规则切分的段落原文
 */
export function buildCrossRefReport(paragraphTexts: string[]): CrossRefReport {
  const paragraphs: ScannedParagraph[] = [];
  const headingsByNumber = new Map<number, HeadingDef[]>();

  for (let i = 0; i < paragraphTexts.length; i++) {
    const text = paragraphTexts[i];
    const ord = i + 1;
    const map16 = utf16ToCodePointMap(text);

    // 标题：仅认段落开头（允许前导空白）的第一个「第…条」
    let heading: HeadingDef | null = null;
    const lead = text.length - text.trimStart().length;
    const headMatch = findClauseMatches(text).find((m) => m.index === lead);
    if (headMatch) {
      const start = map16[headMatch.index];
      heading = {
        paragraph_ord: ord,
        number: headMatch.number,
        style: headMatch.style,
        text: headMatch.text,
        start,
        end: start + Array.from(headMatch.text).length,
      };
      const list = headingsByNumber.get(headMatch.number) ?? [];
      list.push(heading);
      headingsByNumber.set(headMatch.number, list);
    }
    paragraphs.push({ ord, text, heading });
  }

  // 编号索引（按编号升序；同编号多段即歧义定义）
  const index: ClauseIndexEntry[] = [...headingsByNumber.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, defs]) => ({
      number,
      paragraph_ords: defs.map((d) => d.paragraph_ord),
      status: defs.length === 1 ? 'unique' : 'ambiguous',
      headings: defs.map((d) => ({
        paragraph_ord: d.paragraph_ord,
        style: d.style,
        text: d.text,
      })),
    }));

  // 扫描正文引用：跳过段落开头的标题自身；同段多处分别列出
  const references: CrossReference[] = [];
  for (const p of paragraphs) {
    const cps = Array.from(p.text);
    const map16 = utf16ToCodePointMap(p.text);
    // 标题位于 trimStart 后的起始位置（若该段确有标题）
    const headingUtf16 = p.heading ? p.text.length - p.text.trimStart().length : -1;
    let refOrd = 0;
    for (const m of findClauseMatches(p.text)) {
      if (m.index === headingUtf16) continue;
      const start = map16[m.index];
      const end = start + Array.from(m.text).length;
      const defs = headingsByNumber.get(m.number) ?? [];
      const targets = defs.map((d) => d.paragraph_ord).sort((a, b) => a - b);
      const status: RefStatus =
        targets.length === 0 ? 'invalid' : targets.length === 1 ? 'unique' : 'ambiguous';
      refOrd++;
      references.push({
        paragraph_ord: p.ord,
        ref_ord: refOrd,
        number: m.number,
        style: m.style,
        text: m.text,
        start,
        end,
        context: buildContext(cps, start, end),
        status,
        targets,
        self_reference: p.heading?.number === m.number,
      });
    }
  }

  const summary: CrossRefSummary = {
    paragraph_count: paragraphs.length,
    indexed_numbers: index.length,
    total: references.length,
    unique: references.filter((r) => r.status === 'unique').length,
    ambiguous: references.filter((r) => r.status === 'ambiguous').length,
    invalid: references.filter((r) => r.status === 'invalid').length,
  };

  return { paragraphs, index, references, summary };
}
