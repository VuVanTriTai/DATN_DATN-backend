// src/controllers/instructorController.js
const Enrollment = require("../models/Enrollment");
const Progress = require("../models/Progress");
const Plan = require("../models/Plan");
const Lesson = require("../models/Lesson");
const Assignment = require("../models/Assignment");
const lessonQuizService = require("../services/lessonQuizService");

// ── LẤY DANH SÁCH KHÓA HỌC ─────────────────────────────────────────
// src/controllers/instructorController.js
function mergeDraftIntoLesson(lessonDoc) {
  const l = lessonDoc.toObject ? lessonDoc.toObject() : lessonDoc;
  if (l.hasDraft && l.instructorDraft) {
    return {
      ...l,
      title: l.instructorDraft.title || l.title,
      content: l.instructorDraft.content || l.content,
      summary: l.instructorDraft.summary || l.summary,
      importantNotes: l.instructorDraft.importantNotes ?? l.importantNotes,
      quizPool: l.instructorDraft.quizPool ?? l.quizPool,
      videoUrl: l.instructorDraft.videoUrl ?? l.videoUrl,
      assignmentUrl: l.instructorDraft.assignmentUrl ?? l.assignmentUrl,
      solutionUrl: l.instructorDraft.solutionUrl ?? l.solutionUrl,
      _hasDraft: true,
    };
  }
  return { ...l, _hasDraft: false };
}

const getMyCourses = async (req, res) => {
  try {
    const instructorId = req.user.id;

    const courses = await Plan.find({
      $or: [
        { instructorId: instructorId, deletedByInstructor: { $ne: true } },
        { owner: instructorId, deletedByOwner: { $ne: true } }
      ],
      isDeleted: false
    }).populate("owner", "fullName email").lean();

    const coursesWithStats = await Promise.all(courses.map(async (course) => {
      const studentCount = await Enrollment.countDocuments({ planId: course._id, status: 'active' });
      
      // LOGIC: Nếu đang có tên nháp và người xem là Instructor, hãy lấy tên nháp để hiển thị
      if (course.hasTitleDraft && (course.instructorId?.toString() === instructorId || course.owner?.toString() === instructorId)) {
          course.title = course.instructorDraftTitle || course.title;
      }

      return { ...course, studentCount };
    }));

    return res.success(coursesWithStats);
  } catch (error) { return res.error(error.message, 500); }
};


// ── THỐNG KÊ DASHBOARD ──────────────────────────────────────────────
const getCourseDashboardStats = async (req, res) => {
    try {
        const { planId } = req.params;
        const instructorId = req.user.id;
        const plan = await Plan.findOne({ _id: planId, $or: [{ instructorId: instructorId }, { owner: instructorId }] })
                               .populate("owner", "fullName email")
                               .populate("documentId", "fileUrl content");

        if (!plan) return res.status(404).json({ success: false, message: "Không quyền truy cập." });

        const lessons = await Lesson.find({ planId, isDeleted: false }).sort({ dayNumber: 1 });
        
        const enrollments = await Enrollment.find({ planId, status: 'active' }).populate("learnerId", "fullName email");
        const processedLessons = lessons.map(lesson => mergeDraftIntoLesson(lesson));
        const studentsData = await Promise.all(enrollments.map(async (en) => {
            const progress = await Progress.findOne({ userId: en.learnerId._id, planId });
            const completedCount = progress ? progress.completedDays.length : 0;
            const progressPercent = Math.min(100, Math.round((completedCount / (plan.duration || 1)) * 100));
            return { id: en.learnerId._id, name: en.learnerId.fullName, email: en.learnerId.email, progress: progressPercent };
        }));

        return res.success({
            planId: plan._id, planTitle: plan.title, ownerId: plan.owner?._id,
            studentName: plan.owner?.fullName, studentCount: enrollments.length,
            lessons: processedLessons,   // ← SỬA: dùng bản đã merge draft, không phải lessons gốc
            document: plan.documentId, students: studentsData
        });
    } catch (error) { return res.error(error.message, 500); }
};

// ── QUẢN LÝ LỘ TRÌNH ───────────────────────────────────────────────
// src/controllers/instructorController.js

// 1. LƯU NHÁP TÊN KHOÁ HỌC (Học viên chưa thấy)
const updateCourseTitle = async (req, res) => {
  try {
    const { planId } = req.params;
    const { title } = req.body;

    // Lưu vào bản nháp tên
    await Plan.findByIdAndUpdate(planId, { 
      instructorDraftTitle: title.trim(),
      hasTitleDraft: true 
    });

    return res.success(null, "Đã lưu nháp tên lộ trình.");
  } catch (error) { return res.error(error.message, 500); }
};
const addLesson = async (req, res) => {
  try {
    const { planId } = req.params;
    const { afterDayNumber } = req.body;
    const newDayNumber = (parseInt(afterDayNumber) || 0) + 1;
    await Lesson.updateMany({ planId, dayNumber: { $gte: newDayNumber } }, { $inc: { dayNumber: 1 } });
    const newLesson = await Lesson.create({ planId, dayNumber: newDayNumber, title: `Ngày ${newDayNumber}`, content: "*(Chưa có nội dung)*", status: "locked" });
    await Plan.findByIdAndUpdate(planId, { $inc: { duration: 1 } });
    return res.success(newLesson);
  } catch (error) { return res.error(error.message, 500); }
};

const deleteLesson = async (req, res) => {
  try {
    const { lessonId } = req.params;
    const lesson = await Lesson.findByIdAndDelete(lessonId);
    if (lesson) {
      await Lesson.updateMany({ planId: lesson.planId, dayNumber: { $gt: lesson.dayNumber } }, { $inc: { dayNumber: -1 } });
      await Plan.findByIdAndUpdate(lesson.planId, { $inc: { duration: -1 } });
    }
    return res.success(null, "Đã xóa bài học.");
  } catch (error) { return res.error(error.message, 500); }
};


// ── HÀM QUAN TRỌNG: LƯU BẢN NHÁP (STAGING) ──────────────────────────
const updateStudentLesson = async (req, res) => {
  try {
    const { lessonId } = req.params;
    const updateData = req.body;
    const instructorId = req.user.id;

    const lesson = await Lesson.findById(lessonId);
    if (!lesson) return res.error("Không tìm thấy bài học", 404);

    const plan = await Plan.findById(lesson.planId);
    if (!plan) return res.error("Không tìm thấy lộ trình", 404);

    const isOwner = plan.owner && plan.owner.toString() === instructorId;
    const isInstructor = plan.instructorId && plan.instructorId.toString() === instructorId;

    if (!isOwner && !isInstructor) {
      return res.status(403).json({ success: false, message: "Không có quyền chỉnh sửa." });
    }

    // Khoá tự tạo (owner là GV, không có studentId) → ghi thẳng
    if (isOwner && !plan.studentId) {
      const updated = await Lesson.findByIdAndUpdate(lessonId, {
        title: updateData.title,
        content: updateData.content,
        summary: updateData.summary,
        importantNotes: updateData.importantNotes,
        quizPool: updateData.quizPool,
        videoUrl: updateData.videoUrl,
        assignmentUrl: updateData.assignmentUrl,
        solutionUrl: updateData.solutionUrl,
      }, { new: true });
      return res.success(mergeDraftIntoLesson(updated), "Đã lưu bài học.");
    }

    // Khoá có học viên → lưu vào instructorDraft, học viên chưa thấy
    const updated = await Lesson.findByIdAndUpdate(lessonId, {
      instructorDraft: {
        title: updateData.title,
        content: updateData.content,
        summary: updateData.summary,
        importantNotes: updateData.importantNotes,
        quizPool: updateData.quizPool,
        videoUrl: updateData.videoUrl,
        assignmentUrl: updateData.assignmentUrl,
        solutionUrl: updateData.solutionUrl,
        savedAt: new Date(),
      },
      hasDraft: true,
    }, { new: true });

    return res.success(mergeDraftIntoLesson(updated), "Đã lưu nháp. Học viên chưa thấy thay đổi.");
  } catch (error) {
    return res.error(error.message, 500);
  }
};

// ── FIX: GỬI BẢN CHỈNH SỬA (XUẤT BẢN TẤT CẢ) ────────────────────────

// 2. GỬI BẢN CHỈNH SỬA (Lúc này tên bài và tên khoá mới chính thức đổi)
// src/controllers/instructorController.js -> Tìm hàm finalizeReview
const finalizeReview = async (req, res) => {
  try {
    const { planId } = req.params;
    const instructorId = req.user.id;

    const plan = await Plan.findOne({
      _id: planId,
      $or: [{ instructorId }, { owner: instructorId }],
    });
    if (!plan) return res.error("Không tìm thấy lộ trình.", 404);

    // Merge tất cả draft vào bản chính
    const lessons = await Lesson.find({ planId, hasDraft: true, isDeleted: false });
    for (const lesson of lessons) {
      const d = lesson.instructorDraft;
      if (!d) continue;
      await Lesson.findByIdAndUpdate(lesson._id, {
        ...(d.title != null && { title: d.title }),
        ...(d.content != null && { content: d.content }),
        ...(d.summary != null && { summary: d.summary }),
        ...(d.importantNotes != null && { importantNotes: d.importantNotes }),
        ...(d.quizPool != null && { quizPool: d.quizPool }),
        ...(d.videoUrl != null && { videoUrl: d.videoUrl }),
        ...(d.assignmentUrl != null && { assignmentUrl: d.assignmentUrl }),
        ...(d.solutionUrl != null && { solutionUrl: d.solutionUrl }),
        instructorDraft: {},
        hasDraft: false,
      });
    }

    // Merge title nháp của plan nếu có
    if (plan.hasTitleDraft && plan.instructorDraftTitle) {
      plan.title = plan.instructorDraftTitle;
      plan.hasTitleDraft = false;
      plan.instructorDraftTitle = null;
    }
    plan.status = 'reviewed';
    await plan.save();

    return res.success(null, "Đã gửi bản chỉnh sửa cho học viên.");
  } catch (error) {
    console.error("🔥 finalizeReview error:", error);
    return res.error(error.message, 500);
  }
};

const getStudentDetail = async (req, res) => {
    try {
        const { planId, studentId } = req.params;
        const progress = await Progress.findOne({ userId: studentId, planId });
        const assignments = await Assignment.find({ learnerId: studentId, planId }).populate("lessonId", "title dayNumber");
        return res.success({ progress: progress ? progress.completedDays : [], assignments: assignments });
    } catch (error) { return res.error(error.message, 500); }
};

const saveLessonDraft = async (req, res) => {
    try {
      const { lessonId } = req.params;
      const { title, content, summary, importantNotes, quizPool, videoUrl, assignmentUrl, solutionUrl, planId } = req.body;
      const sourcePlan = await Plan.findById(planId);
      if (!sourcePlan) return res.error("Không tìm thấy lộ trình gốc", 404);
  
      const newPlan = await Plan.create({
        title: `${sourcePlan.title} (Bản sao GV)`, owner: req.user.id,
        instructorId: null, documentId: sourcePlan.documentId, duration: sourcePlan.duration,
        learningFocus: sourcePlan.learningFocus, sourceType: "self", status: "pending"
      });
  
      const sourceLessons = await Lesson.find({ planId: sourcePlan._id, isDeleted: false });
      const newLessonsData = sourceLessons.map(lesson => {
        const lessonObj = lesson.toObject();
        delete lessonObj._id;
        lessonObj.planId = newPlan._id;
        if (lesson._id.toString() === lessonId.toString()) {
          return { ...lessonObj, title: title || lessonObj.title, content, summary, importantNotes, quizPool, videoUrl, assignmentUrl, solutionUrl, instructorDraft: {}, hasDraft: false };
        }
        return { ...lessonObj, instructorDraft: {}, hasDraft: false };
      });
      await Lesson.insertMany(newLessonsData);
      return res.success({ newPlanId: newPlan._id });
    } catch (error) { return res.error(error.message, 500); }
};

const createManualCourse = async (req, res) => {
  try {
    const { title, duration } = req.body;
    const numDays = Math.max(1, Math.min(30, parseInt(duration, 10) || 7));
    const newPlan = await Plan.create({ title: title.trim(), owner: req.user.id, instructorId: null, duration: numDays, sourceType: "manual", status: "pending" });
    const lessons = Array.from({ length: numDays }, (_, i) => ({ planId: newPlan._id, dayNumber: i + 1, title: `Ngày ${i + 1}`, content: `## Ngày ${i + 1}\n\n*(Chưa có nội dung)*`, status: 'locked' }));
    await Lesson.insertMany(lessons);
    return res.status(201).json({ success: true, data: { planId: newPlan._id } });
  } catch (error) { return res.error(error.message, 500); }
};
const generateAIQuiz = async (req, res) => {
  try {
    const { lessonId } = req.params;
    const { content } = req.body; // Nội dung GV đang gõ ở Frontend

    if (!content || content.length < 50) {
      return res.error("Nội dung quá ngắn để AI có thể tạo câu hỏi.", 400);
    }

    // Gọi service vừa tạo ở Bước 1
    const questions = await lessonQuizService.generateQuestionsFromDraft(lessonId, content);

    return res.success({ quiz: questions }, `AI đã sinh ${questions.length} câu hỏi dựa trên nội dung bạn soạn.`);
  } catch (error) {
    console.error("AI Generate Quiz Error:", error);
    return res.error("AI không thể tạo câu hỏi lúc này: " + error.message, 500);
  }
};
/**
 * Lấy danh sách toàn bộ học viên đang hướng dẫn (xuyên suốt các khóa học)
 * Dùng cho trang quản lý học viên chung của Giảng viên
 */
const getMyStudents = async (req, res) => {
  try {
    const instructorId = req.user.id;

    // 1. Tìm tất cả các Enrollment (lượt đăng ký) mà user hiện tại là người hướng dẫn
    // Chúng ta populate learnerId để lấy tên/email và planId để lấy tên khóa học
    const enrollments = await Enrollment.find({ 
      instructorId: instructorId,
      status: 'active' 
    })
    .populate("learnerId", "fullName email")
    .populate("planId", "title duration")
    .sort({ createdAt: -1 })
    .lean();

    // 2. Với mỗi học viên trong mỗi khóa, chúng ta đi tìm tiến độ thực tế của họ
    const enrichedStudents = await Promise.all(enrollments.map(async (en) => {
      if (!en.learnerId || !en.planId) return null;

      // Tìm bản ghi Progress của học viên này cho lộ trình này
      const progress = await Progress.findOne({ 
        userId: en.learnerId._id, 
        planId: en.planId._id 
      });

      const completedCount = progress ? progress.completedDays.length : 0;
      const totalDays = en.planId.duration || 1;
      const progressPercent = Math.min(100, Math.round((completedCount / totalDays) * 100));

      return {
        enrollmentId: en._id,
        studentId: en.learnerId._id,
        studentName: en.learnerId.fullName,
        studentEmail: en.learnerId.email,
        planId: en.planId._id,
        planTitle: en.planId.title,
        progress: progressPercent,
        joinedAt: en.createdAt
      };
    }));

    // Lọc bỏ các giá trị null nếu có lỗi data (ví dụ khóa học bị xóa nhưng enrollment vẫn còn)
    const finalData = enrichedStudents.filter(item => item !== null);

    return res.success(finalData, "Lấy danh sách học viên thành công.");
  } catch (error) {
    console.error("🔥 Error in getMyStudents:", error);
    return res.error("Không thể lấy danh sách học viên: " + error.message, 500);
  }
};
// ── CLONE TOÀN BỘ KHOÁ HỌC THÀNH BẢN TỰ TẠO CỦA GV ──────────────────
const cloneCourseAsSelf = async (req, res) => {
  try {
    const { planId } = req.params;
    const instructorId = req.user.id;

    const plan = await Plan.findOne({
      _id: planId,
      $or: [{ instructorId }, { owner: instructorId }],
    });
    if (!plan) return res.error("Không tìm thấy lộ trình.", 404);

    // 1. Clone Plan — bỏ _id, gắn owner = GV, KHÔNG có studentId/instructorId
    //    để nó rơi đúng vào nhánh "khoá tự tạo"
    const planData = plan.toObject();
    delete planData._id;
    delete planData.createdAt;
    delete planData.updatedAt;

    const clonedPlan = await Plan.create({
      ...planData,
      title: `${plan.title} (Bản sao)`,
      owner: instructorId,
      instructorId: undefined,
      studentId: undefined,
      sourceType: 'self',
      status: 'pending',// khác 'teaching' để hiện đúng tab tự tạo
      hasTitleDraft: false,
      instructorDraftTitle: null,
    });

    // 2. Clone toàn bộ Lessons — merge draft hiện có vào bản chính của lesson mới
    const lessons = await Lesson.find({ planId, isDeleted: false }).sort({ dayNumber: 1 });

    const clonedLessonsData = lessons.map(lesson => {
      const l = lesson.toObject();
      delete l._id;
      delete l.createdAt;
      delete l.updatedAt;

      const merged = l.hasDraft && l.instructorDraft
        ? {
            title: l.instructorDraft.title || l.title,
            content: l.instructorDraft.content || l.content,
            summary: l.instructorDraft.summary || l.summary,
            importantNotes: l.instructorDraft.importantNotes ?? l.importantNotes,
            quizPool: l.instructorDraft.quizPool ?? l.quizPool,
            videoUrl: l.instructorDraft.videoUrl ?? l.videoUrl,
            assignmentUrl: l.instructorDraft.assignmentUrl ?? l.assignmentUrl,
            solutionUrl: l.instructorDraft.solutionUrl ?? l.solutionUrl,
          }
        : {
            title: l.title,
            content: l.content,
            summary: l.summary,
            importantNotes: l.importantNotes,
            quizPool: l.quizPool,
            videoUrl: l.videoUrl,
            assignmentUrl: l.assignmentUrl,
            solutionUrl: l.solutionUrl,
          };

      return {
        ...l,
        ...merged,
        planId: clonedPlan._id,
        instructorDraft: {},
        hasDraft: false,
      };
    });

    await Lesson.insertMany(clonedLessonsData);

    return res.success({ planId: clonedPlan._id }, "Đã lưu thành một khoá học tự tạo mới.");
  } catch (error) {
    console.error("🔥 cloneCourseAsSelf error:", error);
    return res.error(error.message, 500);
  }
};
module.exports = {
    getMyCourses, getCourseDashboardStats, getMyStudents, getStudentDetail,
    updateStudentLesson, updateCourseTitle, saveLessonDraft, finalizeReview,
    createManualCourse, addLesson, deleteLesson, generateAIQuiz,mergeDraftIntoLesson, cloneCourseAsSelf,
};