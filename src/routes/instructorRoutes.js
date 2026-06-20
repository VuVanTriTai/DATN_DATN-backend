const express = require("express");
const router = express.Router();
const instructorController = require("../controllers/instructorController");
const verifyToken = require("../middlewares/authMiddleware");
const { checkRole } = require("../middlewares/roleMiddleware");

/**
 * CẤU HÌNH BẢO VỆ TOÀN CỤC
 */
router.use(verifyToken, checkRole(['instructor']));

// ── QUẢN LÝ DANH SÁCH & THỐNG KÊ ─────────────────────────────────────
router.get("/my-courses", instructorController.getMyCourses);
router.get("/my-students", instructorController.getMyStudents);
router.get("/course/:planId/stats", instructorController.getCourseDashboardStats);

// ── BIÊN TẬP LỘ TRÌNH (PLAN) ─────────────────────────────────────────

// 1. Đổi tên khóa học
// Khớp với: api.instructor.updateCourseTitle(planId, title)
router.put('/course/:planId/title', instructorController.updateCourseTitle);

// 2. Thêm ngày học (QUAN TRỌNG: Sửa lại để hết lỗi 404)
// Khớp với: POST /api/instructor/course/:planId/lesson
router.post('/course/:planId/lesson', instructorController.addLesson);

// 3. Tạo khoá học thủ công
router.post("/manual-course", instructorController.createManualCourse);


// ── BIÊN TẬP BÀI HỌC (LESSON) ────────────────────────────────────────

// 4. Cập nhật nội dung bài học
// Khớp với: api.instructor.updateLesson(lessonId, data)
router.put('/lesson/:lessonId', instructorController.updateStudentLesson);

// 5. Xóa ngày học
// Khớp với: api.instructor.deleteLesson(lessonId)
router.delete('/lesson/:lessonId', instructorController.deleteLesson);

// 6. Clone bài học (Lưu thành bản khác)
router.post("/lesson/:lessonId/clone", instructorController.saveLessonDraft);

// 7. Gửi lại cho học viên hoàn tất chỉnh sửa
router.post("/course/:planId/send-back", instructorController.finalizeReview);

// routes/instructorRoutes.js
router.post("/lesson/:lessonId/generate-ai-quiz", instructorController.generateAIQuiz);

router.post('/courses/:planId/clone-as-self', instructorController.cloneCourseAsSelf);
// Thêm dòng này để sửa lỗi 404

module.exports = router;