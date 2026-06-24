"use strict";

/**
 * Concept Extractor — trích xuất danh sách "concept đã dạy" từ nội dung bài học.
 *
 * Mục đích: ngăn AI dạy lại cùng một khái niệm ở ngày khác.
 * Hỗ trợ cả chủ đề SQL kỹ thuật và các tài liệu học thuật/khoa học nói chung.
 */

// ─────────────────────────────────────────────
// KNOWN SQL CONCEPT PATTERNS
// ─────────────────────────────────────────────
const SQL_FUNCTION_PATTERNS = [
  // Date
  /\bDATEADD\b/gi, /\bDATEDIFF\b/gi, /\bGETDATE\b/gi, /\bSYSDATETIME\b/gi,
  /\bCURRENT_TIMESTAMP\b/gi, /\bEOMONTH\b/gi, /\bDATEFROMPARTS\b/gi,
  /\bYEAR\s*\(/gi, /\bMONTH\s*\(/gi, /\bDAY\s*\(/gi,

  // String
  /\bLEN\s*\(/gi, /\bLENGTH\s*\(/gi, /\bSUBSTRING\s*\(/gi, /\bCHARINDEX\s*\(/gi,
  /\bPATINDEX\s*\(/gi, /\bREPLACE\s*\(/gi, /\bSTUFF\s*\(/gi, /\bUPPER\s*\(/gi,
  /\bLOWER\s*\(/gi, /\bLTRIM\s*\(/gi, /\bRTRIM\s*\(/gi, /\bTRIM\s*\(/gi,
  /\bCONCAT\s*\(/gi, /\bCONCAT_WS\s*\(/gi, /\bSTRING_AGG\s*\(/gi,
  /\bSTRING_SPLIT\s*\(/gi, /\bFORMAT\s*\(/gi,

  // Math
  /\bABS\s*\(/gi, /\bROUND\s*\(/gi, /\bCEILING\s*\(/gi, /\bFLOOR\s*\(/gi,
  /\bPOWER\s*\(/gi, /\bSQRT\s*\(/gi,

  // Aggregate
  /\bSUM\s*\(/gi, /\bAVG\s*\(/gi, /\bCOUNT\s*\(/gi, /\bMIN\s*\(/gi, /\bMAX\s*\(/gi,

  // Conversion
  /\bCAST\s*\(/gi, /\bCONVERT\s*\(/gi, /\bTRY_CAST\s*\(/gi,
  /\bTRY_CONVERT\s*\(/gi, /\bPARSE\s*\(/gi, /\bTRY_PARSE\s*\(/gi,

  // Window
  /\bROW_NUMBER\s*\(/gi, /\bRANK\s*\(/gi, /\bDENSE_RANK\s*\(/gi,
  /\bNTILE\s*\(/gi, /\bLEAD\s*\(/gi, /\bLAG\s*\(/gi,
  /\bFIRST_VALUE\s*\(/gi, /\bLAST_VALUE\s*\(/gi,

  // Control flow
  /\bIF\s+EXISTS\b/gi, /\bWHILE\b/gi, /\bCASE\s+WHEN\b/gi,

  // Clause keywords
  /\bGROUP\s+BY\b/gi, /\bHAVING\b/gi, /\bORDER\s+BY\b/gi,
  /\bINNER\s+JOIN\b/gi, /\bLEFT\s+JOIN\b/gi, /\bRIGHT\s+JOIN\b/gi,
  /\bFULL\s+JOIN\b/gi, /\bCROSS\s+JOIN\b/gi,

  // DDL/DML
  /\bCREATE\s+TABLE\b/gi, /\bALTER\s+TABLE\b/gi,
  /\bCREATE\s+INDEX\b/gi, /\bCREATE\s+VIEW\b/gi,
  /\bCREATE\s+PROCEDURE\b/gi, /\bCREATE\s+TRIGGER\b/gi,

  // Transaction
  /\bBEGIN\s+TRAN(SACTION)?\b/gi, /\bCOMMIT\b/gi, /\bROLLBACK\b/gi,

  // Error handling
  /\bBEGIN\s+TRY\b/gi, /\bBEGIN\s+CATCH\b/gi, /\bTHROW\b/gi, /\bRAISERROR\b/gi,

  // Cursor
  /\bDECLARE\s+\w+\s+CURSOR\b/gi,
];

// Normalise a matched string → clean concept key
const normalizeConcept = (raw) =>
  raw
    .replace(/\s*\(.*$/, "")   // strip trailing "("
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

// ─────────────────────────────────────────────
// HEADING FILTER
// ─────────────────────────────────────────────

// Heading generic tiếng Việt / tiếng Anh — bỏ qua
const GENERIC_HEADING_RE = /^(kết\s*luận|tóm\s*tắt|ví\s*dụ(\s*thực\s*tế)?|tổng\s*kết|giới\s*thiệu|mục\s*tiêu|overview|summary|introduction|conclusion|examples?|notes?|lưu\s*ý|bài\s*tập|exercises?|quiz|câu\s*hỏi|bài\s*học|nội\s*dung|phần|chương|section|chapter|day\s*\d+|ngày\s*\d+|so\s*sánh|ứng\s*dụng|thực\s*hành|practice)/i;

// Heading có indicator SQL/kỹ thuật rõ ràng → giữ
const SQL_INDICATOR_RE = /\b[A-Z_]{2,}\s*\(|\bFUNCTION\b|\bPROCEDURE\b|\bTRIGGER\b|\bINDEX\b|\bVIEW\b|\bCURSOR\b|\bJOIN\b|\bTRANSACTION\b|\bSTATEMENT\b/;

/**
 * Kiểm tra heading có phải tên concept học thuật không.
 * Trả về true nếu nên giữ lại.
 */
const isConceptHeading = (heading) => {
  // Quá dài (> 10 từ) → thường là câu dài hoặc content lẫn vào, không phải concept ngắn
  if (heading.split(/\s+/).length > 10) return false;

  // Heading generic → bỏ
  if (GENERIC_HEADING_RE.test(heading)) return false;

  // Có indicator SQL rõ ràng → giữ
  if (SQL_INDICATOR_RE.test(heading)) return true;

  // Đối với tài liệu học thuật/khoa học nói chung, bất kỳ heading hợp lệ nào
  // không thuộc nhóm generic heading đều là một chủ đề/concept có thể dạy.
  const words = heading.split(/\s+/);
  if (words.length > 0) {
    return true;
  }

  return false;
};

// ─────────────────────────────────────────────
// HEADING EXTRACTOR
// ─────────────────────────────────────────────

const extractFromHeadings = (text) => {
  const concepts = [];

  for (const line of text.split("\n")) {
    const m = line.match(/^#{1,4}\s+(.+)/);
    if (!m) continue;

    const heading = m[1]
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .replace(/^\d+(\.\d+)*[\s.]\s*/, "") // bỏ "1.2 " hay "1." ở đầu
      .trim();

    if (isConceptHeading(heading)) {
      concepts.push(heading.toUpperCase());
    }
  }

  return concepts;
};

// ─────────────────────────────────────────────
// MAIN EXPORTS
// ─────────────────────────────────────────────

/**
 * Extract a deduplicated list of concepts taught in a lesson's content.
 *
 * @param {string} content  - lesson markdown content
 * @param {string} [title]  - lesson title (also scanned)
 * @returns {string[]}      - e.g. ["CAST", "CONVERT", "QUANG HỢP", "TẾ BÀO"]
 */
const extractConcepts = (content = "", title = "") => {
  const combined = `${title}\n${content}`;
  const found = new Set();

  // 1. Regex scan for SQL function / keyword names (nếu có)
  for (const pat of SQL_FUNCTION_PATTERNS) {
    const matches = combined.match(new RegExp(pat.source, "gi")) || [];
    for (const m of matches) {
      found.add(normalizeConcept(m));
    }
  }

  // 2. Heading scan — lấy tất cả headings đại diện cho các concept học thuật
  for (const h of extractFromHeadings(combined)) {
    found.add(h);
  }

  return [...found];
};

/**
 * Merge new concepts into an existing usedConcepts array (dedup, uppercase).
 *
 * @param {string[]} existing
 * @param {string[]} newConcepts
 * @returns {string[]}
 */
const mergeConcepts = (existing = [], newConcepts = []) => {
  const s = new Set(existing.map(c => c.toUpperCase()));
  for (const c of newConcepts) s.add(c.toUpperCase());
  return [...s];
};

/**
 * Build a short string to inject into the AI prompt.
 * E.g. "CAST, CONVERT, QUANG HỢP"
 *
 * @param {string[]} usedConcepts
 * @returns {string}
 */
const buildUsedConceptsBlock = (usedConcepts = []) => {
  if (!usedConcepts.length) return "";
  return usedConcepts.join(", ");
};

module.exports = { extractConcepts, mergeConcepts, buildUsedConceptsBlock };