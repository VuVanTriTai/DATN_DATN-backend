// =========================================================================
// 👨‍🍳 FILE: src/controllers/planController.js - BỘ ĐIỀU PHỐI TẠO KHÓA HỌC (PLAN CONTROLLER)
// Tác dụng: Nhận yêu cầu tạo lộ trình học tập từ Frontend, gọi các dịch vụ AI và lưu kết quả.
// Luồng đi: FE → planRoutes → planController → planService (AI) → MongoDB
// =========================================================================

// 📦 IMPORT CÁC DỊCH VỤ & UTILITIES
const planService = require('../services/planService');    // Dịch vụ AI sinh bài giảng, phân tích tài liệu
const { normalizeLearningGoals } = require('../constants/learningGoals'); // Chuẩn hóa mục tiêu học
const { extractTextFromFile } = require('../utils/extractText'); // Trích xuất text từ file PDF/Word
const { saveDebugLessons } = require('../utils/debugLessons'); // Ghi log bài học ra file debug
const lessonReuseService = require('../services/lessonReuseService'); // Tái sử dụng bài giảng cũ
const { extractConcepts, mergeConcepts } = require('../utils/conceptExtractor'); // Trích khái niệm dạy được

// 🗄️ IMPORT CÁC MODEL MONGODB
const Plan = require('../models/Plan');           // Lộ trình học
const Lesson = require('../models/Lesson');       // Bài học từng ngày
const Chunk = require('../models/Chunk');         // Đoạn văn bản nhỏ (dùng cho RAG)
const Enrollment = require('../models/Enrollment'); // Liên kết học viên - giáo viên
const Document = require('../models/Document');   // Tài liệu gốc người dùng tải lên
const Assignment = require('../models/Assignment'); // Bài tập tự luận
const Progress = require('../models/Progress');   // Tiến độ học
const User = require('../models/User');           // Thông tin người dùng

// 🔐 Thư viện mã hóa của Node.js (dùng để tạo hash MD5 chống trùng lặp tài liệu)
// ✅ FIX: Đã chuyển require('crypto') từ trong function body lên đầu file theo chuẩn Node.js
const crypto = require('crypto');

// ⚠️ FIX đã xóa: Import GROQ_KEY_COUNT từ planService (biến này không được export từ planService)
// const { GROQ_KEY_COUNT } = require('../services/planService'); // ← điều này gây ra undefined!

// ────────────────────────────────────────────────────────────
// PARALLEL LESSON GENERATOR
// Sinh nhiều ngày học song song, mỗi key xử lý 1 batch để tránh RPM
// ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 🔄 HÀM SINH BÀI HỌC TUẦN TỰ CÓ BỘ NHỚ KHÁI NIỆM (generateLessonsParallel)
//
// Tên hàm là "Parallel" nhưng thực chất chạy TUẦN TỰ từng ngày.
// Lý do: Mỗi ngày học cần biết khái niệm đã dạy ở ngày trước (concept memory)
//        để AI không lặp lại kiến thức → buộc phải đợi ngày trước xong mới làm ngày sau.
//
// Tham số nhận vào:
//   - syllabus     : Mảng khung chương trình [{day, title, objective, ...}]
//   - plan         : Bản ghi Plan đã được lưu vào MongoDB
//   - learnerId    : ID học viên (để kiểm tra tái sử dụng bài học cũ)
//   - learningGoals: Mục tiêu học (lý thuyết/thực hành, cơ bản/nâng cao)
//   - duration     : Tổng số ngày học
// ─────────────────────────────────────────────────────────────────────────────
const generateLessonsParallel = async ({
  syllabus, plan, learnerId, learningGoals, duration
}) => {
  console.log(`📚 Lesson gen: SEQUENTIAL + Concept Memory | ${syllabus.length} ngày`);

  // Tạo danh sách tóm tắt toàn bộ chương trình để AI hiểu "bức tranh tổng thể" khi sinh từng ngày
  const syllabusContext = syllabus.map(item => ({
    day: item.dayNumber || item.day,
    title: item.title,
    summary: item.objective || "",
  }));

  // Danh sách "chữ ký" của các đoạn văn bản đã dùng (tránh AI lấy cùng 1 đoạn 2 lần)
  const usedChunkSignatures = [];

  // 🧠 BỘ NHỚ KHÁI NIỆM (Concept Memory): Tích lũy toàn bộ khái niệm đã dạy qua các ngày
  // Mục đích: Ngày 3 sẽ biết ngày 1 và 2 đã dạy gì → không giải thích lại từ đầu
  let usedConcepts = [];
  let reuseCount = 0;
  const results = [];

  // Vòng lặp tuần tự: xử lý từng ngày học một, theo đúng thứ tự
  for (const item of syllabus) {

    // Chuẩn hóa thông tin ngày học hiện tại (syllabus từ AI có thể dùng 'dayNumber' hoặc 'day')
    const currentItem = {
      day: item.dayNumber || item.day,
      topic: item.title,
      objective: item.objective || "",
      bloomLevel: item.bloomLevel || "",      // Mức độ tư duy (Bloom Taxonomy)
      coveredSections: item.coveredSections || [],  // Các phần tài liệu gốc cần bao quát
      totalDays: duration,
    };

    console.log(
      `> Day ${currentItem.day}: "${currentItem.topic}" | ` +
      `sections=${currentItem.coveredSections.length} | ` +
      `memory=${usedConcepts.length} concepts`
    );

    try {
      // ── KIỂM TRA TÁI SỬ DỤNG BÀI GIẢNG CŨ ─────────────────────────────
      // Tìm bài học tương tự đã từng tạo cho học viên này ở khóa học khác.
      // Nếu trùng khớp → nhân bản (clone) thay vì gọi AI → tiết kiệm thời gian & tiền API.
      let reused = null;
      try {
        reused = await lessonReuseService.findReusableLesson(
          learnerId, currentItem.topic, currentItem.objective,
          { currentPlanId: plan._id }
        );
      } catch (e) { console.warn("⚠️ Reuse check failed:", e.message); }

      // Trường hợp 1: Bài học giống hoàn toàn → Copy nguyên si, không cần sinh mới
      if (reused && reused.action === "REUSE_NGUYEN") {
        await lessonReuseService.cloneLesson(
          reused.lesson, plan._id, currentItem.day,
          { version: reused.lesson.version, missingCoverage: [] }
        );
        reuseCount++;
        // Vẫn phải cập nhật concept memory từ bài tái sử dụng để ngày tiếp theo biết
        const reusedConcepts = extractConcepts(reused.lesson.content || "", currentItem.topic);
        usedConcepts = mergeConcepts(usedConcepts, reusedConcepts);
        console.log(`♻️  REUSE NGUYÊN Day ${currentItem.day} | +${reusedConcepts.length} concepts`);
        results.push({ day: currentItem.day, title: currentItem.topic, summary: reused.lesson.summary || currentItem.objective, reused: true });
        continue; // Bỏ qua phần sinh mới bên dưới, qua ngày tiếp theo
      }

      // Trường hợp 2: Bài học gần giống, cần cập nhật thêm phần thiếu → Patch bổ sung
      if (reused && reused.action === "REUSE_UPDATE") {
        await lessonReuseService.patchLesson(
          reused.lesson, plan._id, currentItem.day,
          reused.diff.missingCoverage || [], reused.newContext, reused.lesson.version
        );
        reuseCount++;
        const reusedConcepts = extractConcepts(reused.lesson.content || "", currentItem.topic);
        usedConcepts = mergeConcepts(usedConcepts, reusedConcepts);
        console.log(`♻️  REUSE+UPDATE Day ${currentItem.day} | +${reusedConcepts.length} concepts`);
        results.push({ day: currentItem.day, title: currentItem.topic, summary: reused.lesson.summary || currentItem.objective, reused: true });
        continue;
      }

      // Trường hợp 3 (REWRITE hoặc không có bài cũ): Sinh bài học mới hoàn toàn bằng AI
      if (reused?.action === "REWRITE") console.log(`♻️  REWRITE: Day ${currentItem.day}`);

      // ── GỌI AI SINH BÀI GIẢNG MỚI (kết hợp RAG + Concept Memory) ────────
      // Truyền vào: planId, thông tin ngày, học viên, danh sách chunk đã dùng,
      //             mục tiêu học, tóm tắt các ngày trước, và bộ nhớ khái niệm
      const detail = await planService.generateScientificLesson(
        plan._id,
        currentItem,
        learnerId,
        [],                   // previousTopics (không dùng nữa, thay bằng previousSummaries)
        usedChunkSignatures,
        learningGoals,
        syllabusContext.filter(s => s.day < currentItem.day), // Chỉ truyền ngày đã qua
        usedConcepts          // Toàn bộ khái niệm đã dạy từ ngày 1 đến ngày hiện tại
      );

      // Cập nhật danh sách chunk đã sử dụng (để ngày sau tìm chunk mới, không bị trùng)
      if (Array.isArray(detail.usedChunkSignatures)) {
        for (const sig of detail.usedChunkSignatures) {
          if (!usedChunkSignatures.includes(sig)) usedChunkSignatures.push(sig);
        }
      }

      // Tích lũy thêm khái niệm mới vừa dạy trong ngày hôm nay vào bộ nhớ
      if (Array.isArray(detail.newConcepts) && detail.newConcepts.length) {
        const before = usedConcepts.length;
        usedConcepts = mergeConcepts(usedConcepts, detail.newConcepts);
        const added = usedConcepts.length - before;
        console.log(
          `🧠 Day ${currentItem.day}: taught [${detail.newConcepts.slice(0, 6).join(", ")}` +
          `${detail.newConcepts.length > 6 ? "..." : ""}] | +${added} new | total: ${usedConcepts.length}`
        );
      }

      // ── LƯU BÀI HỌC VÀO DATABASE ─────────────────────────────────────────
      // Ngày 1 mở khóa ngay (in-progress), các ngày sau khóa lại (locked)
      // Học viên phải hoàn thành ngày trước mới mở được ngày tiếp theo
      const newLesson = await Lesson.create({
        planId: plan._id,
        dayNumber: currentItem.day,
        title: currentItem.topic,
        content: detail.content,           // Nội dung Markdown đầy đủ
        summary: detail.summary,           // Tóm tắt ngắn gọn
        quiz: detail.quiz || [],           // Câu hỏi trắc nghiệm
        importantNotes: detail.importantNotes || [],
        status: currentItem.day === 1 ? "in-progress" : "locked",
      });

      await lessonReuseService.indexLesson(newLesson, plan).catch(() => { });
      console.log(`✅ Day ${currentItem.day} done`);

      results.push({
        day: currentItem.day,
        title: currentItem.topic,
        summary: detail.summary || currentItem.objective,
      });

      if (currentItem.day < duration) await new Promise(r => setTimeout(r, 3000));

    } catch (err) {
      console.error(`❌ Lesson ${currentItem.day} error:`, err.message);
      await Lesson.create({
        planId: plan._id,
        dayNumber: currentItem.day,
        title: currentItem.topic,
        content: `## ${currentItem.topic}\n\nNội dung bài học này đang gặp sự cố.\nBạn có thể thử lại hoặc chỉnh sửa thủ công.`,
        summary: "Lỗi hệ thống AI",
        quiz: [],
        importantNotes: [],
        status: "locked",
      });
      results.push({ day: currentItem.day, title: currentItem.topic, summary: currentItem.objective, error: err.message });
    }
  }

  console.log(`♻️  Reused: ${reuseCount}/${syllabus.length} | Final memory: ${usedConcepts.length} concepts`);
  return results;
};


const DAYS_MIN = 1;
const DAYS_MAX = 14;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// ─────────────────────────────────────────────
// UPLOAD & EXTRACT (HARDENED)
// ─────────────────────────────────────────────

const uploadAndExtract = async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: "Không có file được tải lên.",
      });
    }

    // ─────────────────────────────
    // FIX-1: VALIDATE FILE TYPE
    // ─────────────────────────────
    const allowedTypes = [
      "application/pdf",
      "text/plain",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({
        success: false,
        message: "Định dạng file không được hỗ trợ.",
      });
    }

    // ─────────────────────────────
    // FIX-2: LIMIT SIZE (safety)
    // ─────────────────────────────
    const MAX_SIZE_MB = 10;
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        message: `File vượt quá ${MAX_SIZE_MB}MB.`,
      });
    }

    console.log(`📁 Extracting: ${file.originalname}`);

    // ─────────────────────────────
    // FIX-3: SAFE EXTRACTION
    // ─────────────────────────────
    const result = await extractTextFromFile(file) || {};
    const text = (result.text || "").trim();
    const metadata = result.metadata || {};

    // ─────────────────────────────
    // FIX-4: TEXT VALIDATION (stronger)
    // ─────────────────────────────
    const wordCount = text.split(/\s+/).length;

    if (!text || wordCount < 30) {
      return res.status(400).json({
        success: false,
        message: "File không chứa đủ nội dung hợp lệ.",
      });
    }

    // detect text rác (optional nhưng rất hữu ích)
    const junkRatio = (text.match(/[^a-zA-Z0-9À-ỹ\s]/g) || []).length / text.length;
    if (junkRatio > 0.4) {
      console.warn("⚠️ Text có dấu hiệu OCR lỗi / rác");
    }

    // ─────────────────────────────
    // FIX-5: SAFE METADATA
    // ─────────────────────────────
    const safeMeta = {
      wordCount: metadata.wordCount || wordCount,
      tableCount: metadata.tableCount || 0,
      hasFormulas: metadata.hasFormulas || false,
      estimatedComplexity: metadata.estimatedComplexity || "unknown",
    };

    console.log(
      `✅ Extracted: ${safeMeta.wordCount} words | tables=${safeMeta.tableCount} | complexity=${safeMeta.estimatedComplexity}`
    );

    // ─────────────────────────────
    // FIX-6: LIMIT RESPONSE SIZE
    // ─────────────────────────────
    const MAX_RETURN_CHARS = 15000;

    return res.status(200).json({
      success: true,
      message: "Đã trích xuất nội dung thành công.",
      data: {
        textPreview: text.substring(0, MAX_RETURN_CHARS), // ⚠️ chỉ preview
        fullLength: text.length,
        metadata: safeMeta,
        fileUrl: file.path,
        originalName: file.originalname,
      },
    });

  } catch (error) {
    console.error("❌ Upload & Extract error:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể đọc file. Vui lòng thử lại.",
    });
  }
};// ─────────────────────────────────────────────
// PROCESS & ANALYZE (HARDENED)
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 🧠 PHÂN TÍCH TÀI LIỆU & ĐỊNH HƯỚNG MỤC TIÊU HỌC TẬP (PROCESS & ANALYZE)
// Luồng hoạt động: Frontend gửi text trích xuất -> validate độ dài -> gọi planService.analyzeDocument
// để phân tích độ phức tạp, chủ đề chính, và đề xuất lộ trình khung (previewPlan).
// ─────────────────────────────────────────────────────────────────────────────
const processAndAnalyze = async (req, res) => {
  try {
    let {
      text,
      learningGoals: rawGoals,
      days,
      metadata,
    } = req.body;

    // BƯỚC 1: Xác thực tính hợp lệ của văn bản gửi lên
    if (!text || typeof text !== "string") {
      return res.status(400).json({
        success: false,
        message: "Không nhận được nội dung văn bản hợp lệ.",
      });
    }

    text = text.trim();

    // Giới hạn độ dài tối đa để tránh quá tải token khi gọi LLM API (50,000 ký tự)
    const MAX_TEXT_LENGTH = 50000;
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.substring(0, MAX_TEXT_LENGTH);
      console.warn("⚠️ Text bị cắt do quá dài");
    }

    const wordCount = text.split(/\s+/).length;
    if (wordCount < 30) {
      return res.status(400).json({
        success: false,
        message: "Nội dung quá ngắn để phân tích.",
      });
    }

    // BƯỚC 2: Kiểm tra số ngày mong muốn học (Duration) - Giới hạn từ 1 đến 14 ngày
    const DAYS_MIN = 1;
    const DAYS_MAX = 14;

    let safeDays = parseInt(days) || 7;
    safeDays = Math.max(DAYS_MIN, Math.min(DAYS_MAX, safeDays));

    // BƯỚC 3: Thiết lập metadata an toàn
    const safeMetadata = {
      wordCount: metadata?.wordCount || wordCount,
      tableCount: metadata?.tableCount || 0,
      hasFormulas: metadata?.hasFormulas || false,
      estimatedComplexity: metadata?.estimatedComplexity || "unknown",
    };

    console.log(`🧠 Analyze: ${safeMetadata.wordCount} words | days=${safeDays}`);

    // BƯỚC 4: Gọi nghiệp vụ phân tích tài liệu bằng AI (planService.analyzeDocument)
    const result = await planService.analyzeDocument(
      text,
      rawGoals || {},
      safeDays,
      safeMetadata
    );

    // BƯỚC 5: Trả về kết quả phân tích sơ bộ cùng lộ trình khung cho người học xem trước
    return res.success(
      {
        textPreview: text.substring(0, 10000), // Chỉ trả về preview tránh nặng đường truyền
        textLength: text.length,
        analysis: result.analysis,
        previewPlan: result.previewPlan,
        metadata: safeMetadata,
      },
      "Phân tích tài liệu và thiết lập mục tiêu thành công."
    );

  } catch (error) {
    console.error("❌ ProcessAndAnalyze error:", error);
    return res.error(
      "AI gặp sự cố khi xử lý bối cảnh học tập.",
      500
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 🚀 XÁC NHẬN KHỞI TẠO KHÓA HỌC HOÀN CHỈNH (FINALIZE CREATE COURSE)
// Luồng hoạt động:
// 1. Kiểm tra chất lượng tài liệu học (docValidationService)
// 2. Hash MD5 tài liệu để chống trùng lặp, lưu trữ tài liệu gốc (Document)
// 3. Khởi tạo bản ghi lộ trình chính (Plan) và bản ghi theo học (Enrollment)
// 4. Chia nhỏ tài liệu thành từng phần (Chunking) và tính toán Vector Embedding (RAG)
// 5. Sinh Khung chương trình chi tiết (Syllabus)
// 6. Chạy vòng lặp sinh nội dung chi tiết bài giảng từng ngày (generateLessonsParallel)
// ─────────────────────────────────────────────────────────────────────────────
const finalizeCreateCourse = async (req, res) => {
  try {
    const {
      title,
      extractedText,
      numDays,
      instructorId,
      previewPlan,
      fileUrl,
      learningGoals: rawGoals,
      metadata
    } = req.body;

    const learnerId = req.user.id;
    // crypto đã được khai báo ở đầu file (không cần require lại)
    const learningGoals = normalizeLearningGoals(rawGoals || {});

    if (!extractedText) {
      return res.error("Thiếu nội dung tài liệu.", 400);
    }

    // BƯỚC 1: KIỂM TRA CHẤT LƯỢNG TÀI LIỆU (Validate quality, rác chữ, OCR lỗi)
    let validationWarnings = [];
    let depthGapWarning = null;
    try {
      const { validateDocument } = require('../services/docValidationService');
      const valResult = await validateDocument(extractedText, {
        focus: learningGoals.focus || 'theory',
        depth: learningGoals.depth || 'basic'
      });

      console.log('📋 Doc validation:', valResult.level, '| issues:', valResult.issues.length);

      if (!valResult.passed) {
        return res.status(400).json({
          success: false,
          message: valResult.issues[0] || 'Tài liệu không đạt yêu cầu chất lượng.',
          validationIssues: valResult.issues,
          validationLevel: valResult.level,
          metrics: valResult.metrics,
        });
      }

      validationWarnings = valResult.issues;
      depthGapWarning = valResult.depthGapWarning;
    } catch (valErr) {
      console.warn('⚠️ Doc validation service lỗi, bỏ qua:', valErr.message);
    }

    // BƯỚC 2: HASH MD5 TÀI LIỆU (Chống trùng lặp tài liệu gốc trong Database)
    const hash = crypto.createHash("md5").update(extractedText).digest("hex");

    let doc = await Document.findOne({ userId: learnerId, contentHash: hash });
    if (!doc) {
      doc = await Document.create({
        userId: learnerId,
        title: title || metadata?.fileName || "Tài liệu gốc",
        content: extractedText,
        fileUrl: fileUrl,
        contentHash: hash,
        metadata: metadata || {}
      });
      console.log("📄 Đã lưu tài liệu mới.");
    } else {
      console.log("📄 Tài liệu đã tồn tại, dùng lại ID:", doc._id);
      // Sửa/Nâng cấp fileUrl nếu bản ghi cũ chỉ có đường dẫn local và bản ghi mới có link online
      const isOldLocal = doc.fileUrl && (doc.fileUrl.startsWith('uploads') || doc.fileUrl.includes('uploads/') || doc.fileUrl.includes('uploads\\'));
      const isNewRemote = fileUrl && fileUrl.startsWith('http');
      if (!doc.fileUrl || (isOldLocal && isNewRemote)) {
        doc.fileUrl = fileUrl;
        await doc.save();
        console.log("✅ Đã cập nhật/nâng cấp fileUrl lên Cloudinary cho tài liệu gốc đã tồn tại.");
      }
    }

    if (metadata) {
      console.log(
        `📊 Document info: ${metadata?.wordCount || 0} words, ` +
        `${metadata?.tableCount || 0} table rows, ` +
        `formulas: ${metadata?.hasFormulas ? 'Yes' : 'No'}, ` +
        `complexity: ${metadata?.estimatedComplexity || 'unknown'}`
      );
    }

    // BƯỚC 3: CHUẨN HÓA SỐ NGÀY HỌC (DURATION NORMALIZE)
    let duration = parseInt(numDays);
    if (isNaN(duration)) {
      const match = String(numDays).match(/\d+/);
      duration = match ? parseInt(match[0]) : 7;
    }
    duration = Math.min(DAYS_MAX, Math.max(DAYS_MIN, duration));

    console.log("🚀 BẮT ĐẦU QUY TRÌNH TẠO LỘ TRÌNH RAG");

    // BƯỚC 4: KHỞI TẠO BẢN GHI LỘ TRÌNH CHÍNH (CREATE PLAN)
    // Lưu các cài đặt như cấp độ, mục tiêu thực hành/lý thuyết, người hướng dẫn được giao.
    const plan = await Plan.create({
      title: title || metadata?.fileName || "Khóa học AI",
      owner: learnerId,
      instructorId: instructorId || null,
      documentId: doc._id,
      duration,
      learningFocus: learningGoals?.focus || 'theory',
      learningDepth: learningGoals?.depth || 'basic',
      documentMetadata: {
        wordCount: metadata?.wordCount || 0,
        hasFormulas: metadata?.hasFormulas || false,
        complexity: metadata?.estimatedComplexity || 'medium'
      },
    });

    // BƯỚC 5: TẠO BẢN GHI THEO DÕI HỌC TẬP (ENROLLMENT)
    // Nếu khóa học này có giáo viên hướng dẫn, tự động tạo liên kết chờ xác nhận của GV.
    if (plan.instructorId) {
      await Enrollment.create({
        learnerId,
        instructorId: plan.instructorId,
        planId: plan._id,
        status: "pending"
      });
    }

    // BƯỚC 6: CẮT NHỎ VÀ EMBEDDING TÀI LIỆU (CHUNKING & VECTOR STORAGE)
    // Chia tài liệu thành các đoạn text ngắn (chunks), tạo mã vector cho từng đoạn qua OpenAI/HuggingFace
    // và lưu vào Vector Store để sau này truy vấn tìm kiến thức chính xác theo từng ngày (RAG).
    console.log("📦 Chunk + embedding...");
    await planService.processAndStoreDocument(plan._id, extractedText);

    console.log("⏳ Đợi index (5s)...");
    await sleep(5000);

    // BƯỚC 7: XÂY DỰNG KHUNG CHƯƠNG TRÌNH HỌC (GENERATE SYLLABUS)
    // Nếu người dùng chọn dùng luôn đề xuất ban đầu (previewPlan), hệ thống sẽ giữ nguyên.
    // Nếu không, AI sẽ dựa trên toàn bộ tài liệu để phân bổ khối lượng kiến thức đều ra số ngày học.
    const previewMatchesDuration =
      Array.isArray(previewPlan) && previewPlan.length === duration;

    const syllabus = previewMatchesDuration
      ? previewPlan
      : (await planService.generateSyllabus(extractedText, duration, learningGoals)).syllabus;

    if (!Array.isArray(syllabus) || syllabus.length === 0) {
      throw new Error("Syllabus generation failed hoặc rỗng.");
    }

    console.log(`📚 Tạo ${syllabus.length} bài học`);

    // BƯỚC 8: VÒNG LẶP SINH NỘI DUNG CHI TIẾT TỪNG NGÀY (LESSON GENERATION LOOP)
    // Hệ thống chạy tuần tự từng ngày học để chuyển tiếp "Bộ nhớ khái niệm đã học" (concept memory),
    // giúp bài học ngày thứ 2 không bị trùng lặp kiến thức của ngày 1 mà phát triển kế thừa.
    await generateLessonsParallel({ syllabus, plan, learnerId, learningGoals, duration });


    // ✅ DEBUG: Ghi nội dung các ngày học ra file phục vụ giám sát/gỡ lỗi
    try {
      const createdLessons = await Lesson.find({ planId: plan._id, isDeleted: false })
        .sort({ dayNumber: 1 })
        .lean();
      saveDebugLessons(plan, createdLessons);
    } catch (debugErr) {
      console.warn("⚠️ [debug] Không ghi được debug_lessons.txt:", debugErr.message);
    }

    return res.status(200).json({
      success: true,
      message: "Lộ trình học tập đã sẵn sàng!",
      data: {
        _id: plan._id,
        metadata,
        validationWarnings: validationWarnings || [],
        depthGapWarning: depthGapWarning || null,
      }
    });

  } catch (error) {
    console.error("🔥 Controller error:", error.stack);
    return res.status(500).json({
      success: false,
      message: "Không thể khởi tạo khóa học: " + error.message
    });
  }
};
/////////////////////////////////////////
// ───────────────────────────────────────────
// EXISTING FUNCTIONS — FIXED & HARDENED
// ───────────────────────────────────────────
const getMyPlans = async (req, res) => {
  try {
    const userId = req.user.id;

    const plans = await Plan.find({
      owner: userId,
      isDeleted: false,
      deletedByOwner: { $ne: true },
      status: { $ne: "teaching" } // Ẩn bản clone đang được giáo viên giữ
    }).lean();

    const plansWithProgress = await Promise.all(
      plans.map(async (plan) => {
        const totalLessons = Math.max(plan.duration || 1, 1);

        const completedCount = await Lesson.countDocuments({
          planId: plan._id,
          status: "completed",
        });

        const progressPercent = Math.min(
          100,
          Math.round((completedCount / totalLessons) * 100)
        );

        return {
          ...plan,
          progress: progressPercent,
          sourceType: plan.sourceType || "self",
        };
      })
    );

    return res.success(plansWithProgress);
  } catch (err) {
    console.error("getMyPlans error:", err);
    return res.error(err.message);
  }
};

const getPlanDetails = async (req, res) => {
  try {
    const plan = await Plan.findById(req.params.id)
    .populate("documentId")
    .populate("instructorId");
    const lessons = await Lesson.find({ planId: req.params.id, isDeleted: false }).sort({ dayNumber: 1 }).lean();

    const userId = req.user.id.toString();
    const instructorId = plan.instructorId?._id ? plan.instructorId._id.toString() : plan.instructorId?.toString();
    
    // Kiểm tra xem người đang xem có phải là Giảng viên không
    const isInstructor = userId === instructorId;

    const processedLessons = lessons.map(lesson => {
        // Mặc định lấy tiêu đề và nội dung chính thức
        let finalTitle = lesson.title;
        let finalContent = lesson.content;

        // Nếu là GIẢNG VIÊN và bài có nháp -> Lấy tiêu đề và nội dung nháp để hiển thị
        if (isInstructor && lesson.hasDraft) {
            finalTitle = lesson.instructorDraft.title || lesson.title;
            finalContent = lesson.instructorDraft.content || lesson.content;
        }

        const cleanLesson = { 
            ...lesson, 
            title: finalTitle, 
            content: finalContent 
        };

        // Bảo mật: Học viên không bao giờ được thấy Object instructorDraft
        if (!isInstructor) delete cleanLesson.instructorDraft;
        
        // Mở khóa Ngày 1
        if (cleanLesson.dayNumber === 1 && cleanLesson.status === 'locked') {
            cleanLesson.status = 'in-progress';
        }

        return cleanLesson;
    });

    const displayPlan = plan.toObject();
    // Tương tự cho tiêu đề khóa học
    if (isInstructor && plan.hasTitleDraft) {
        displayPlan.title = plan.instructorDraftTitle;
    }

    return res.success({ plan: displayPlan, lessons: processedLessons });
  } catch (error) { return res.error(error.message, 500); }
};
const getLessonDetail = async (req, res) => {
  try {
    const lesson = await Lesson.findOne({ planId: req.params.id, dayNumber: Number(req.params.dayNumber) }).lean();
    if (!lesson) return res.error("Không tìm thấy bài học", 404);

    const plan = await Plan.findById(req.params.id);
    const userId = req.user.id.toString();
    const instructorId = plan.instructorId?.toString();
    
    const isRealInstructor = (userId === instructorId) && (req.user.role === 'instructor');

    if (isRealInstructor && lesson.hasDraft) {
        return res.success({
            ...lesson,
            ...lesson.instructorDraft
        });
    }

    // Nếu là học viên -> Ẩn nháp
    const cleanLesson = { ...lesson };
    delete cleanLesson.instructorDraft;
    return res.success(cleanLesson);
  } catch (error) { return res.error(error.message, 500); }
};
const deletePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const plan = await Plan.findOne({
      _id: id,
      $or: [{ owner: userId }, { instructorId: userId }, { sharedWith: userId }]
    });
    if (!plan) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy lộ trình hoặc bạn không có quyền xóa.",
      });
    }

    const isOwner = plan.owner && plan.owner.toString() === userId;
    const isInstructor = plan.instructorId && plan.instructorId.toString() === userId;
    const isRecipient = plan.sharedWith && plan.sharedWith.includes(userId);

    // Xử lý nếu chỉ là người nhận chia sẻ
    if (!isOwner && !isInstructor && isRecipient) {
      plan.sharedWith = plan.sharedWith.filter(id => id.toString() !== userId);
      await plan.save();
      return res.status(200).json({
        success: true,
        message: "Đã xóa lộ trình khỏi hộp thư chia sẻ.",
      });
    }

    if (isOwner) {
      plan.deletedByOwner = true;
    }
    if (isInstructor) {
      plan.deletedByInstructor = true;
    }

    await plan.save();

    // Nếu không có giáo viên HOẶC cả 2 đều đã xóa thì mới xóa cứng (hard delete)
    const shouldHardDelete = plan.deletedByOwner && (!plan.instructorId || plan.deletedByInstructor);

    if (shouldHardDelete) {
      console.log(`🗑️ Cả 2 phía đã xóa, tiến hành xóa cứng lộ trình: ${id}`);
      await Promise.all([
        Lesson.deleteMany({ planId: id }),
        Chunk.deleteMany({ planId: id }),
        Enrollment.deleteMany({ planId: id }),
        Assignment.deleteMany({ planId: id }),
        Progress.deleteMany({ planId: id }),
      ]);
      await Plan.findByIdAndDelete(id);
      console.log("✅ Đã xóa cứng toàn bộ dữ liệu liên quan.");
    } else {
      console.log(`👁️ Ẩn lộ trình ${id} khỏi màn hình của user ${userId}`);
    }

    return res.status(200).json({
      success: true,
      message: "Đã xóa lộ trình khỏi danh sách của bạn.",
    });
  } catch (error) {
    console.error("🔥 deletePlan error:", error);
    return res.status(500).json({
      success: false,
      message: "Lỗi hệ thống: " + error.message,
    });
  }
};

const sharePlan = async (req, res) => {
  try {
    const plan = await Plan.findByIdAndUpdate(
      req.params.id,
      { isPublic: true },
      { new: true }
    );

    if (!plan) return res.error("Không tìm thấy lộ trình", 404);

    return res.success(plan, "Đã chia sẻ lộ trình.");
  } catch (error) {
    console.error("sharePlan error:", error);
    return res.error(error.message, 500);
  }
};
const shareToMarket = async (req, res) => {
  try {
    const { id: originalPlanId } = req.params;
    const { categories = [], level = "Medium", tags = [] } = req.body;
    const userId = req.user.id;

    // 1. CHỈ cho phép Chủ sở hữu (Owner) thực hiện
    const originalPlan = await Plan.findOne({ 
      _id: originalPlanId, 
      owner: userId, 
      isDeleted: false 
    });

    if (!originalPlan) {
      return res.error("Chỉ chủ sở hữu mới có quyền đưa khóa học lên Market.", 403);
    }

    // 2. Chống đăng trùng: Kiểm tra xem đã có bản công khai nào từ bản gốc này chưa
    // Nếu có rồi thì cập nhật bản đó thay vì tạo thêm clone rác
    let publicClone = await Plan.findOne({ 
      originalPlanId: originalPlanId, 
      isPublic: true 
    });

    const normalizedTags = tags.map((t) => String(t).toLowerCase().trim());

    if (publicClone) {
      // Nếu đã có bản trên Market, ta cập nhật thông tin Meta
      publicClone.categories = categories;
      publicClone.level = level;
      publicClone.tags = tags;
      publicClone.normalizedTags = normalizedTags;
      await publicClone.save();
      return res.success(publicClone, "Đã cập nhật thông tin khóa học trên Market.");
    }

    // 3. Nếu chưa có -> Tạo bản CLONE công khai
    const planData = originalPlan.toObject();
    delete planData._id;
    delete planData.createdAt;
    delete planData.updatedAt;

    const newPublicPlan = new Plan({
      ...planData,
      title: originalPlan.title, // Giữ nguyên tiêu đề
      owner: userId,
      instructorId: originalPlan.instructorId,
      originalPlanId: originalPlanId, // Lưu vết để biết clone từ đâu
      isPublic: true,                 // Bản này sẽ hiện trên Market
      sourceType: originalPlan.sourceType,
      categories,
      level,
      tags,
      normalizedTags,
      sharedWith: []                  // Bản công khai không cần sharedWith
    });
    await newPublicPlan.save();

    // 4. Clone toàn bộ Lessons sang bản công khai
    const lessons = await Lesson.find({ planId: originalPlanId, isDeleted: false });
    if (lessons.length > 0) {
      const publicLessons = lessons.map(lesson => {
        const lData = lesson.toObject();
        delete lData._id;
        lData.planId = newPublicPlan._id;
        // Bản công khai thì merge nháp của GV (nếu có) vào chính thức luôn để người mua nhận được bản tốt nhất
        if (lData.hasDraft && lData.instructorDraft) {
            lData.title = lData.instructorDraft.title || lData.title;
            lData.content = lData.instructorDraft.content || lData.content;
            lData.quizPool = lData.instructorDraft.quizPool || lData.quizPool;
        }
        lData.instructorDraft = {};
        lData.hasDraft = false;
        return lData;
      });
      await Lesson.insertMany(publicLessons);
    }

    return res.success(newPublicPlan, "Khóa học của bạn đã được niêm yết công khai trên Market!");
  } catch (error) {
    console.error("🔥 shareToMarket error:", error);
    return res.error(error.message, 500);
  }
};

const getPlanResults = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const progress = await Progress.findOne({ userId, planId: id });

    const lessons = await Lesson.find({
      planId: id,
      isDeleted: false,
    })
      .select("dayNumber title quiz")
      .sort({ dayNumber: 1 });

    if (!lessons.length)
      return res.error("Lộ trình chưa có bài học nào.", 404);

    const detailedResults = lessons.map((lesson) => {
      const knowledge = progress?.knowledgeMap?.find(
        (k) => k.topic === lesson.title
      );

      return {
        dayNumber: lesson.dayNumber,
        title: lesson.title,
        isCompleted:
          progress?.completedDays?.includes(lesson.dayNumber) || false,
        score: knowledge ? Math.round(knowledge.score) : 0,
        status: knowledge ? knowledge.status : "NOT_STARTED",
      };
    });

    const totalLessons = lessons.length;
    const completedCount = progress?.completedDays?.length || 0;

    const summary = {
      overallProgress: totalLessons
        ? Math.round((completedCount / totalLessons) * 100)
        : 0,
      averageScore: progress ? Math.round(progress.averageScore || 0) : 0,
      currentLevel: progress?.currentLevel || "BEGINNER",
      totalLessons,
      completedCount,
    };

    return res.success({ summary, detailedResults });
  } catch (error) {
    console.error("getPlanResults error:", error);
    return res.error(error.message, 500);
  }
};

const searchUser = async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.error("Thiếu email", 400);

    const user = await User.findOne({
      email: email.toLowerCase(),
    }).select("fullName email");

    if (!user) return res.error("Không tìm thấy người dùng", 404);

    return res.success(user);
  } catch (error) {
    console.error("searchUser error:", error);
    return res.error(error.message, 500);
  }
};

const sharePrivate = async (req, res) => {
  try {
    const { id } = req.params;
    const { targetUserId } = req.body;

    const plan = await Plan.findById(id);
    if (!plan || plan.owner.toString() !== req.user.id) {
      return res.error("Bạn không có quyền chia sẻ lộ trình này", 403);
    }

    if (!plan.sharedWith.includes(targetUserId)) {
      plan.sharedWith.push(targetUserId);
      await plan.save();
    }

    return res.success(null, "Đã chia sẻ thành công!");
  } catch (error) {
    console.error("sharePrivate error:", error);
    return res.error(error.message, 500);
  }
};

const getSharedWithMe = async (req, res) => {
  try {
    const userId = req.user.id;

    const plans = await Plan.find({
      sharedWith: userId,
      owner: { $ne: userId },
    })
      .populate("owner", "fullName email")
      .sort({ createdAt: -1 });

    console.log(`📋 Found ${plans.length} shared plans`);

    return res.success(plans);
  } catch (error) {
    console.error("getSharedWithMe error:", error);
    return res.error(error.message, 500);
  }
};

// ─────────────────────────────────────────────
// 🔄 TẠO LẠI NỘI DUNG BÀI HỌC BẰNG AI (REGENERATE LESSON)
// Route: POST /api/plan/:id/lesson/:dayNumber/regenerate
// Cho phép học viên yêu cầu AI viết lại hoàn toàn nội dung bài học đang mở,
// vẫn sử dụng RAG từ tài liệu gốc để đảm bảo độ chính xác.
// ─────────────────────────────────────────────
const regenerateLesson = async (req, res) => {
  try {
    const { id: planId, dayNumber } = req.params;
    const learnerId = req.user.id;

    // 1. Lấy thông tin plan & lesson hiện tại
    const plan = await Plan.findById(planId);
    if (!plan) return res.error('Không tìm thấy lộ trình', 404);
    if (plan.owner.toString() !== learnerId) return res.error('Bạn không có quyền thực hiện thao tác này', 403);

    const lesson = await Lesson.findOne({ planId, dayNumber: Number(dayNumber), isDeleted: false });
    if (!lesson) return res.error('Không tìm thấy bài học', 404);

    const learningGoals = normalizeLearningGoals({
      focus: plan.learningFocus || 'theory',
      depth: plan.learningDepth || 'basic',
    });

    // 2. Xây dựng item (cùng format với generateLessonsParallel)
    const item = {
      day: Number(dayNumber),
      topic: lesson.title,
      objective: lesson.summary || `Nắm vững nội dung ${lesson.title}`,
      coveredSections: lesson.coverage || [],
      bloomLevel: '',
      totalDays: plan.duration || 7,
    };

    console.log(`🔄 Regenerate Day ${dayNumber}: "${lesson.title}" | Plan: ${planId}`);

    // 3. Gọi AI sinh lại nội dung (không kiểm tra tái sử dụng)
    const detail = await planService.generateScientificLesson(
      planId,
      item,
      learnerId,
      [],
      [],
      learningGoals,
      [],
      []
    );

    // 4. Lưu lại nội dung mới vào DB
    await Lesson.findByIdAndUpdate(lesson._id, {
      content:        detail.content,
      summary:        detail.summary        || lesson.summary,
      importantNotes: detail.importantNotes || [],
      quiz:           detail.quiz           || [],
      // Xoá quizPool cũ để hệ thống sinh pool trắc nghiệm mới khi học viên vào tab Quiz
      quizPool: [],
    });

    console.log(`✅ Regenerate done: Day ${dayNumber} | Plan: ${planId}`);

    return res.success(
      { dayNumber: Number(dayNumber) },
      'Đã tạo lại nội dung bài học thành công!'
    );
  } catch (error) {
    console.error('🔥 regenerateLesson error:', error);
    return res.error('AI gặp sự cố khi tạo lại bài học: ' + error.message, 500);
  }
};
// ────────────────────────────────────────────────────────────
// 🎓 CẬP NHẬT GIÁO VIÊN HƯỚNG DẪN (Gửi lộ trình cho GV)
// ────────────────────────────────────────────────────────────
// src/controllers/planController.js

const updateInstructor = async (req, res) => {
  try {
    const { id } = req.params; // ID lộ trình gốc của học viên
    const { instructorId } = req.body;
    const learnerId = req.user.id;

    if (!instructorId) {
      await Plan.findByIdAndUpdate(id, { $unset: { instructorId: 1 } });
      await Enrollment.deleteMany({ learnerId, planId: id });
      return res.success(null, "Đã gỡ người hướng dẫn.");
    }

    // 1. TÌM BẢN CLONE ĐÃ TỒN TẠI (Quan trọng nhất)
    // Tìm bất kỳ bản clone nào được tạo từ originalPlanId này cho giảng viên này
    let clonedPlan = await Plan.findOne({
      originalPlanId: id,
      instructorId: instructorId,
      owner: learnerId // Chủ sở hữu vẫn là học viên
    });

    if (clonedPlan) {
      // Nếu đã có clone, chỉ cần cập nhật lại Enrollment nếu nó bị xóa nhầm
      await Enrollment.findOneAndUpdate(
        { learnerId, instructorId, planId: clonedPlan._id },
        { status: "active" },
        { upsert: true }
      );
      // Cập nhật lại ID giáo viên vào bản gốc của học viên
      await Plan.findByIdAndUpdate(id, { instructorId });
      
      console.log("♻️ Đã tìm thấy bản clone cũ, không tạo mới.");
      return res.success(clonedPlan, "Lộ trình đã được gửi trước đó.");
    }

    // 2. NẾU CHƯA CÓ THÌ MỚI TẠO MỚI
    console.log("🆕 Tạo bản clone mới cho giáo viên.");
    const originalPlan = await Plan.findById(id);
    const planData = originalPlan.toObject();
    delete planData._id;
    delete planData.createdAt;
    delete planData.updatedAt;

    clonedPlan = new Plan({
      ...planData,
      owner: learnerId,
      instructorId: instructorId,
      originalPlanId: id,
      status: "teaching",
      sourceType: "assigned", // Đánh dấu rõ nguồn gốc
    });
    await clonedPlan.save();

    // Clone bài học
    const originalLessons = await Lesson.find({ planId: id, isDeleted: false });
    if (originalLessons.length > 0) {
      const newLessons = originalLessons.map((l) => {
        const d = l.toObject();
        delete d._id;
        return { ...d, planId: clonedPlan._id };
      });
      await Lesson.insertMany(newLessons);
    }

    await Enrollment.create({ learnerId, instructorId, planId: clonedPlan._id, status: "active" });
    await Plan.findByIdAndUpdate(id, { instructorId });

    return res.success(clonedPlan, "Đã gửi lộ trình cho giáo viên.");
  } catch (error) {
    return res.error(error.message, 500);
  }
};
// Thêm vào src/controllers/planController.js (nếu chưa có)

const checkRecipientStatus = async (req, res) => {
  try {
    const { id: sourcePlanId, userId: recipientId } = req.params;

    // Tìm xem người nhận đã có bản clone nào từ originalPlanId này chưa
    const recipientPlan = await Plan.findOne({
      owner: recipientId,
      originalPlanId: sourcePlanId,
      isDeleted: false
    }).sort({ createdAt: -1 });

    if (!recipientPlan) {
      return res.success({ isShared: false, hasUpdates: false });
    }

    // Kiểm tra cập nhật: Nếu bản gốc sửa sau khi bản clone được tạo
    const sourcePlan = await Plan.findById(sourcePlanId);
    const hasUpdates = sourcePlan && sourcePlan.updatedAt > recipientPlan.createdAt;

    return res.success({
      isShared: true,
      hasUpdates: !!hasUpdates,
      lastSharedAt: recipientPlan.createdAt
    });
  } catch (error) {
    return res.error(error.message, 500);
  }
};


// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
module.exports = {
  // Upload + Analyze
  uploadAndExtract,
  processAndAnalyze,
  finalizeCreateCourse,

  // Plan
  getMyPlans,
  getPlanDetails,
  deletePlan,
  sharePlan,
  shareToMarket,

  // Lesson
  getLessonDetail,
  regenerateLesson,
  getPlanResults,

  // Instructor
  updateInstructor,
  checkRecipientStatus,

  // Sharing
  searchUser,
  sharePrivate,
  getSharedWithMe,
};