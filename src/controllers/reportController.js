const Report = require('../models/Report');
const Review = require('../models/Review');
const Plan = require('../models/Plan');
const InstructorRating = require('../models/InstructorRating');
const User = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Gửi báo cáo vi phạm (Người dùng)
// ─────────────────────────────────────────────────────────────────────────────
const createReport = async (req, res) => {
  try {
    const { targetType, targetId, reason, description } = req.body;
    const reportedBy = req.user.id;

    if (!['course', 'review', 'instructorRating'].includes(targetType)) {
      return res.error('Loại báo cáo không hợp lệ.', 400);
    }
    if (!targetId) return res.error('Thiếu ID nội dung báo cáo.', 400);
    if (!reason) return res.error('Vui lòng chọn lý do báo cáo.', 400);

    // Kiểm tra đã báo cáo chưa (tránh spam)
    const existing = await Report.findOne({
      targetType,
      targetId,
      reportedBy,
      status: 'pending'
    });
    if (existing) {
      return res.error('Bạn đã báo cáo nội dung này rồi. Chúng tôi đang xem xét.', 400);
    }

    // Lấy snapshot nội dung để admin dễ xem kể cả sau khi bị xoá
    let snapshot = null;
    try {
      if (targetType === 'course') {
        const course = await Plan.findById(targetId).populate('owner', 'fullName email').lean();
        if (course) snapshot = { title: course.title, owner: course.owner?.fullName, topic: course.topic };
      } else if (targetType === 'review') {
        const review = await Review.findById(targetId).populate('userId', 'fullName').lean();
        if (review) snapshot = { content: review.content, author: review.userId?.fullName || 'Ẩn danh', rating: review.rating };
      } else if (targetType === 'instructorRating') {
        const rating = await InstructorRating.findById(targetId)
          .populate('learner', 'fullName')
          .populate('instructor', 'fullName')
          .lean();
        if (rating) snapshot = { comment: rating.comment, stars: rating.stars, learner: rating.learner?.fullName || 'Ẩn danh', instructor: rating.instructor?.fullName };
      }
    } catch (_) { /* snapshot thất bại thì thôi */ }

    const report = await Report.create({
      targetType,
      targetId,
      reportedBy,
      reason,
      description: description || '',
      snapshot
    });

    return res.success(report, 'Đã gửi báo cáo. Cảm ơn bạn đã góp phần xây dựng cộng đồng!');
  } catch (error) {
    console.error('❌ createReport error:', error);
    return res.error(error.message, 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Lấy danh sách báo cáo (Admin)
// ─────────────────────────────────────────────────────────────────────────────
const getReports = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      targetType = '',
      status = 'pending'
    } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = {};
    if (targetType) query.targetType = targetType;
    if (status) query.status = status;

    const [reports, total] = await Promise.all([
      Report.find(query)
        .populate('reportedBy', 'fullName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Report.countDocuments(query)
    ]);

    return res.success({
      reports,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('❌ getReports error:', error);
    return res.error(error.message, 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Xử lý báo cáo: Gỡ nội dung (Admin)
// Logic đặc biệt: nếu review gốc có replies → thay nội dung bằng placeholder
//                 thay vì xóa cứng để không gãy luồng hội thoại
// ─────────────────────────────────────────────────────────────────────────────
const resolveReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNote = '' } = req.body;

    const report = await Report.findById(id);
    if (!report) return res.error('Không tìm thấy báo cáo.', 404);
    if (report.status !== 'pending') return res.error('Báo cáo này đã được xử lý rồi.', 400);

    let actionMessage = '';

    if (report.targetType === 'course') {
      // Gỡ khóa học khỏi market
      await Plan.findByIdAndUpdate(report.targetId, { isDeleted: true, isPublic: false });
      actionMessage = 'Đã gỡ khóa học vi phạm.';

    } else if (report.targetType === 'review') {
      const review = await Review.findById(report.targetId);
      if (review && !review.isDeleted) {
        // Kiểm tra xem review gốc có replies không
        if (!review.parentId) {
          // Đây là review gốc (cấp cha)
          const replyCount = await Review.countDocuments({
            parentId: review._id,
            isDeleted: false
          });

          if (replyCount > 0) {
            // Có replies → Thay nội dung bằng placeholder, giữ luồng hội thoại
            review.isDeleted = true;
            review.content = '[Bình luận này đã bị gỡ do vi phạm]';
            await review.save();
            actionMessage = `Đã gỡ nội dung bình luận gốc (giữ ${replyCount} phản hồi để không gãy luồng).`;
          } else {
            // Không có replies → xóa mềm bình thường
            review.isDeleted = true;
            await review.save();
            actionMessage = 'Đã xóa bình luận vi phạm.';
          }
        } else {
          // Đây là reply → xóa mềm bình thường
          review.isDeleted = true;
          await review.save();
          actionMessage = 'Đã xóa phản hồi vi phạm.';
        }
      } else {
        actionMessage = 'Bình luận đã bị xóa trước đó.';
      }

    } else if (report.targetType === 'instructorRating') {
      // Xóa đánh giá giáo viên và tính lại điểm
      const rating = await InstructorRating.findByIdAndDelete(report.targetId);
      if (rating) {
        // Tính lại avgRating và ratingCount
        const ratings = await InstructorRating.find({ instructor: rating.instructor });
        const ratingCount = ratings.length;
        const avgRating = ratingCount > 0
          ? parseFloat((ratings.reduce((s, r) => s + r.stars, 0) / ratingCount).toFixed(1))
          : 0;
        await User.findByIdAndUpdate(rating.instructor, {
          $set: {
            'instructorProfile.avgRating': avgRating,
            'instructorProfile.ratingCount': ratingCount
          }
        });
      }
      actionMessage = 'Đã xóa đánh giá giáo viên vi phạm.';
    }

    // Đánh dấu tất cả các báo cáo pending cho cùng nội dung là resolved
    await Report.updateMany(
      { targetId: report.targetId, targetType: report.targetType, status: 'pending' },
      { status: 'resolved', adminNote: adminNote || actionMessage }
    );

    return res.success(null, actionMessage);
  } catch (error) {
    console.error('❌ resolveReport error:', error);
    return res.error(error.message, 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. Bỏ qua báo cáo (Admin) — không xóa nội dung
// ─────────────────────────────────────────────────────────────────────────────
const dismissReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNote = '' } = req.body;

    const report = await Report.findById(id);
    if (!report) return res.error('Không tìm thấy báo cáo.', 404);
    if (report.status !== 'pending') return res.error('Báo cáo này đã được xử lý rồi.', 400);

    report.status = 'dismissed';
    report.adminNote = adminNote || 'Nội dung không vi phạm tiêu chuẩn cộng đồng.';
    await report.save();

    return res.success(null, 'Đã bỏ qua báo cáo.');
  } catch (error) {
    console.error('❌ dismissReport error:', error);
    return res.error(error.message, 500);
  }
};

module.exports = { createReport, getReports, resolveReport, dismissReport };
