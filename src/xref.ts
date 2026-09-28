/**
 * 条款交叉引用校验引擎（纯函数，不依赖数据库）：
 *  - 段落开头若形如「第十二条」或「第12条」，则该段以编号 12 建立条款标题索引；
 *  - 扫描段落正文中出现的同类引用「第N条」（中文数字或阿拉伯数字，支持一至九十九），
 *    标题自身不算引用；同一段落内的多处引用分别列出；
 *  - 引用编号在索引中：恰好对应一段 → unique（唯一匹配），
 *    对应多段 → ambiguous（歧义），找不到编号 → broken（失效）。
 *
 * 全程按码点（Array.from）计算偏移，避免非 BMP 字符的 UTF-16 代理项导致索引错位。
 */

export type XrefNumberStyle = 'cn' | 'arabic';
export type XrefStatus = 'unique' | 'ambiguous' | 'broken';

export interface XrefHeading {
  /** 段落序号（1 起始） */
  paragraph_ord: number;
  /** 条款编号（1～99） */
  number: number;
  /** 编号写法：中文数字 / 阿拉伯数字 */
  number_style: XrefNumberStyle;
  /** 标题原文，如「第十二条」「第12条」 */
  text: string;
}

export interface XrefReference {
  /** 来源段落序号（1 起始） */
  paragraph_ord: number;
  /** 同一段落内的出现次序（1 起始；标题自身不占次序） */
  occurrence: number;
  /** 引用的条款编号（1～99） */
  number: number;
  number_style: XrefNumberStyle;
  /** 引用原文，如「第十二条」「第12条」 */
  text: string;
  /** 段内起始码点偏移（0 起始，相对整个段落） */
  start: number;
  /** 段内结束码点偏移（exclusive） */
  end: number;
  /** 引用上下文（原文，带省略号） */
  context: string;
  /** 校验状态：unique 唯一匹配 / ambiguous 歧义 / broken 失效 */
  status: XrefStatus;
  /** 全部候选目标段落序号（标题编号相同的段落；失效为空数组） */
  targets: number[];
  /** 唯一匹配时的目标段落序号；歧义 / 失效为 null */
  target_paragraph_ord: number | null;
  /** 唯一匹配时的目标段落原文 */
  target_text: string | null;
}

export interface XrefReport {
  scanned_at: string;
  version: {
    version_id: number;
    seq: number;
    label: string;
    paragraph_count: number;
  };
  headings: XrefHeading[];
  references: XrefReference[];
  summary: {
    paragraphs: number;
    headings: number;
    total: number;
    unique: number;
    ambiguous: number;
    broken: number;
  };
}

interface NumberMatch {
  number: number;
  style: XrefNumberStyle;
}

const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/**
 * 解析中文数字（一～九十九）：
 *  一～九、十、十一～十九、二十～九十九（含「廿」之外的全部常规写法）。
 *  超出范围或非法组合（如「十十」「一一」）返回 null。
 */
export function parseCnClauseNumber(raw: string): number | null {
  const s = raw.trim();
  if (s === '十') return 10;
  const m = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(s);
  if (m) {
    const tens = m[1] ? CN_DIGITS[m[1]] : 1;
    const ones = m[2] ? CN_DIGITS[m[2]] : 0;
    return tens * 10 + ones;
  }
  if (s.length === 1 && CN_DIGITS[s] != null) return CN_DIGITS[s];
  return null;
}

/**
 * 「第N条」编号匹配：N 为一至九十九的中文数字或 1～99 的阿拉伯数字。
 * 阿拉伯数字要求右侧不接更多数字，因此「第100条」「第123条」不会被误匹配。
 */
const XREF_PATTERN = /第(?:([一二三四五六七八九十]+)|(\d{1,2}))(?!\d)条/g;

function interpretNumber(cn: string | undefined, arabic: string | undefined): NumberMatch | null {
  if (cn !== undefined) {
    const n = parseCnClauseNumber(cn);
    if (n == null || n < 1 || n > 99) return null;
    return { number: n, style: 'cn' };
  }
  if (arabic !== undefined) {
    const n = Number(arabic);
    if (!Number.isInteger(n) || n < 1 || n > 99) return null;
    return { number: n, style: 'arabic' };
  }
  return null;
}

/** UTF-16 偏移 → 码点偏移（本应用文本以中文 BMP 为主，仅在出现非 BMP 字符时二者不同） */
function utf16ToCpOffset(str: string, utf16Index: number): number {
  let cp = 0;
  for (let i = 0; i < utf16Index; ) {
    const code = str.charCodeAt(i);
    i += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    cp++;
  }
  return cp;
}

interface RawMatch extends NumberMatch {
  /** 码点起始偏移 */
  start: number;
  /** 码点结束偏移（exclusive） */
  end: number;
  text: string;
}

/** 收集段落中全部「第N条」出现（含段首标题，调用方负责区分） */
function findClauseMarks(paragraph: string): RawMatch[] {
  const out: RawMatch[] = [];
  XREF_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = XREF_PATTERN.exec(paragraph)) !== null) {
    const parsed = interpretNumber(m[1], m[2]);
    if (!parsed) continue;
    const start = utf16ToCpOffset(paragraph, m.index);
    const cpLen = Array.from(m[0]).length;
    out.push({ ...parsed, start, end: start + cpLen, text: m[0] });
    if (m[0].length === 0) XREF_PATTERN.lastIndex++; // 防御零宽匹配死循环
  }
  return out;
}

/** 段首标题：允许段首空白，必须锚定段落开头（「段落开头的第N条」） */
const HEADING_PATTERN = /^\s*第(?:([一二三四五六七八九十]+)|(\d{1,2}))(?!\d)条/;

/** 上下文窗口（码点数）：引用前后各取若干字符 */
const CONTEXT_RADIUS = 24;

function buildContext(cps: string[], startCp: number, endCp: number): string {
  const s = Math.max(0, startCp - CONTEXT_RADIUS);
  const e = Math.min(cps.length, endCp + CONTEXT_RADIUS);
  return (s > 0 ? '…' : '') + cps.slice(s, e).join('') + (e < cps.length ? '…' : '');
}

/**
 * 对单个版本的段落执行交叉引用校验：
 *  @param paragraphs 已按版本导入同一套规则切分好的段落
 *  @returns 标题索引、全部引用（同段多处分别列出）与统计
 */
export function scanCrossReferences(paragraphs: string[]): Omit<XrefReport, 'scanned_at' | 'version'> {
  const headings: XrefHeading[] = [];
  /** 编号 → 以该编号开头的段落序号列表（长度 0 失效 / 1 唯一 / >1 歧义） */
  const headingsByNumber = new Map<number, number[]>();

  // 第一段：建立编号索引（仅段首标题）
  paragraphs.forEach((paragraph, i) => {
    const ord = i + 1;
    const m = HEADING_PATTERN.exec(paragraph);
    if (!m) return;
    const parsed = interpretNumber(m[1], m[2]);
    if (!parsed) return;
    headings.push({
      paragraph_ord: ord,
      number: parsed.number,
      number_style: parsed.style,
      text: m[0].trim(),
    });
    const list = headingsByNumber.get(parsed.number);
    if (list) list.push(ord);
    else headingsByNumber.set(parsed.number, [ord]);
  });

  // 第二段：扫描正文中的引用（跳过段首标题自身）
  const references: XrefReference[] = [];
  paragraphs.forEach((paragraph, i) => {
    const ord = i + 1;
    const cps = Array.from(paragraph);
    const heading = HEADING_PATTERN.exec(paragraph);
    // 段首标题在码点序列中的结束位置（用于排除标题自身）
    const headingUtf16End = heading ? heading.index + heading[0].length : 0;
    const headingCpEnd = heading ? utf16ToCpOffset(paragraph, headingUtf16End) : 0;

    let occurrence = 0;
    for (const mark of findClauseMarks(paragraph)) {
      // 标题自身不算引用：与锚定段首的标题为同一处出现
      if (heading && mark.start < headingCpEnd) continue;
      occurrence++;
      const targets = headingsByNumber.get(mark.number) ?? [];
      let status: XrefStatus;
      if (targets.length === 0) status = 'broken';
      else if (targets.length === 1) status = 'unique';
      else status = 'ambiguous';
      references.push({
        paragraph_ord: ord,
        occurrence,
        number: mark.number,
        number_style: mark.style,
        text: mark.text,
        start: mark.start,
        end: mark.end,
        context: buildContext(cps, mark.start, mark.end),
        status,
        targets,
        target_paragraph_ord: status === 'unique' ? targets[0] : null,
        target_text: status === 'unique' ? paragraphs[targets[0] - 1] : null,
      });
    }
  });

  references.sort((a, b) =>
    a.paragraph_ord - b.paragraph_ord || a.occurrence - b.occurrence
  );

  return {
    headings,
    references,
    summary: {
      paragraphs: paragraphs.length,
      headings: headings.length,
      total: references.length,
      unique: references.filter((r) => r.status === 'unique').length,
      ambiguous: references.filter((r) => r.status === 'ambiguous').length,
      broken: references.filter((r) => r.status === 'broken').length,
    },
  };
}
