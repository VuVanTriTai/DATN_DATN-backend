const Review = require('../models/Review');
const Progress = require('../models/Progress');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Gửi bình luận hoặc đánh giá
// ─────────────────────────────────────────────────────────────────────────────
const createReview = async (req, res) => {
    try {
        const { planId } = req.params;
        const { content, rating, parentId } = req.body;
        const userId = req.user.id;

        if (!content || !content.trim()) {
            return res.error("Nội dung bình luận không được để trống.", 400);
        }

        // ── Kiểm tra điều kiện đánh giá (chỉ cho bình luận cấp cha) ──
        if (!parentId) {
            // Học viên học trên bản clone nên Progress trỏ tới cloneId
            // Tìm tất cả các bản clone của user từ plan gốc này
            const Plan = require('../models/Plan');
            const userClones = await Plan.find({ owner: userId, originalPlanId: planId, isDeleted: false });
            const cloneIds = userClones.map(c => c._id);

            const userProgress = await Progress.findOne({
                userId,
                $or: [
                    { planId: planId },
                    { planId: { $in: cloneIds } }
                ]
            });

            if (!userProgress || userProgress.completedDays.length < 2) {
                return res.status(403).json({
                    success: false,
                    message: "Bạn cần hoàn thành ít nhất 2 ngày học để có thể đánh giá khóa học này."
                });
            }

            // Tránh spam: mỗi user chỉ đánh giá 1 lần
            const existingRating = await Review.findOne({ userId, planId, parentId: null, isDeleted: false });
            if (existingRating) {
                return res.error("Bạn đã gửi đánh giá cho khóa học này rồi.", 400);
            }

            if (!rating || rating < 1 || rating > 5) {
                return res.error("Vui lòng chọn số sao đánh giá (1–5).", 400);
            }
        }

        // Tạo review mới
        const newReview = await Review.create({
            planId,
            userId,
            content: content.trim(),
            rating: parentId ? null : Number(rating),
            parentId: parentId || null
        });

        const populated = await newReview.populate("userId", "fullName email");
        return res.success({
            ...populated.toObject(),
            likeCount: 0,
            dislikeCount: 0,
            myStatus: null
        }, "Gửi thành công.");
    } catch (error) {
        console.error("❌ createReview error:", error);
        return res.error(error.message, 500);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Lấy danh sách bình luận (có phân trang)
// ─────────────────────────────────────────────────────────────────────────────
const getPlanReviews = async (req, res) => {
    try {
        const { planId } = req.params;
        const { page = 1, limit = 10 } = req.query;
        const p = parseInt(page) || 1;
        const l = parseInt(limit) || 10;

        // Chỉ đếm các review gốc chưa bị xoá
        const total = await Review.countDocuments({ planId, isDeleted: false, parentId: null });

        // Lấy bình luận cấp cha (phân trang)
        // Bao gồm cả review đã bị xoá mềm nếu nội dung là placeholder (isDeleted=true nhưng vẫn cần hiển thị)
        const parents = await Review.find({ planId, parentId: null, isDeleted: false })
            .populate("userId", "fullName email")
            .sort({ createdAt: -1 })
            .skip((p - 1) * l)
            .limit(l)
            .lean();

        if (parents.length === 0) {
            return res.success({ reviews: [], total: 0, totalPages: 0, currentPage: p });
        }

        // Lấy tất cả replies (kể cả đã bị xoá để hiển thị placeholder nếu phía sau có hoạt động)
        const allReplies = await Review.find({
            planId,
            parentId: { $ne: null }
        })
            .populate("userId", "fullName email")
            .sort({ createdAt: 1 })
            .lean();

        const currentUserId = req.user.id;

        // Hàm gắn thống kê cho từng review
        const processReview = (r) => ({
            ...r,
            likeCount: r.likes ? r.likes.length : 0,
            dislikeCount: r.dislikes ? r.dislikes.length : 0,
            myStatus: r.likes && r.likes.some(id => id.toString() === currentUserId)
                ? 'liked'
                : r.dislikes && r.dislikes.some(id => id.toString() === currentUserId)
                    ? 'disliked'
                    : null,
            replies: []
        });

        // Gom nhóm replies theo parentId
        const replyMapRaw = {};
        allReplies.forEach(reply => {
            const pid = reply.parentId.toString();
            if (!replyMapRaw[pid]) replyMapRaw[pid] = [];
            replyMapRaw[pid].push(reply);
        });

        // Lọc và gán thống kê cho từng reply trong mỗi nhóm
        const replyMap = {};
        Object.keys(replyMapRaw).forEach(pid => {
            const rList = replyMapRaw[pid];
            const processedList = [];
            let hasActiveAfter = false;

            // Duyệt ngược từ cuối danh sách về đầu để quyết định giữ hay bỏ các reply đã xoá
            for (let i = rList.length - 1; i >= 0; i--) {
                const rep = rList[i];
                if (!rep.isDeleted) {
                    processedList.unshift(processReview(rep));
                    hasActiveAfter = true;
                } else if (hasActiveAfter) {
                    processedList.unshift({
                        ...processReview(rep),
                        userId: null,
                        content: '[Phản hồi này đã bị gỡ]',
                        isRemovedPlaceholder: true
                    });
                }
            }

            if (processedList.length > 0) {
                replyMap[pid] = processedList;
            }
        });

        const processedParents = parents.map(r => ({
            ...processReview(r),
            replies: replyMap[r._id.toString()] || []
        }));

        // Thêm các review gốc đã bị xoá mềm (isDeleted=true) nhưng có replies đang hiển thị
        // Để tránh gãy luồng hội thoại, chúng được trả về với nội dung placeholder
        const deletedParentIds = Object.keys(replyMap).filter(
            pid => !parents.some(r => r._id.toString() === pid)
        );

        const deletedParents = deletedParentIds.length > 0
            ? await Review.find({
                _id: { $in: deletedParentIds },
                planId,
                isDeleted: true,
                parentId: null
            }).lean()
            : [];

        const placeholderParents = deletedParents.map(r => ({
            ...r,
            userId: null,
            content: '[Bình luận này đã bị gỡ do vi phạm]',
            rating: null,
            likes: [],
            dislikes: [],
            likeCount: 0,
            dislikeCount: 0,
            myStatus: null,
            isRemovedPlaceholder: true,
            replies: replyMap[r._id.toString()] || []
        }));

        // Gộp tất cả và sort theo thời gian tạo mới nhất
        const allReviews = [...processedParents, ...placeholderParents]
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        return res.success({
            reviews: allReviews,
            total,
            totalPages: Math.ceil(total / l),
            currentPage: p
        });
    } catch (error) {
        console.error("❌ getPlanReviews error:", error);
        return res.error(error.message, 500);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Lấy tổng kết rating (average + phân phối sao)
// ─────────────────────────────────────────────────────────────────────────────
const getReviewSummary = async (req, res) => {
    try {
        const { planId } = req.params;

        const stats = await Review.aggregate([
            { $match: { planId: require('mongoose').Types.ObjectId.createFromHexString(planId), parentId: null, isDeleted: false } },
            {
                $group: {
                    _id: null,
                    avgRating: { $avg: "$rating" },
                    total: { $sum: 1 },
                    star5: { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
                    star4: { $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] } },
                    star3: { $sum: { $cond: [{ $eq: ["$rating", 3] }, 1, 0] } },
                    star2: { $sum: { $cond: [{ $eq: ["$rating", 2] }, 1, 0] } },
                    star1: { $sum: { $cond: [{ $eq: ["$rating", 1] }, 1, 0] } }
                }
            }
        ]);

        if (!stats.length) {
            return res.success({
                avgRating: 0, total: 0,
                distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }
            });
        }

        const s = stats[0];
        return res.success({
            avgRating: parseFloat(s.avgRating.toFixed(1)),
            total: s.total,
            distribution: { 5: s.star5, 4: s.star4, 3: s.star3, 2: s.star2, 1: s.star1 }
        });
    } catch (error) {
        console.error("❌ getReviewSummary error:", error);
        return res.error(error.message, 500);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. Toggle Like / Dislike
// ─────────────────────────────────────────────────────────────────────────────
const toggleReaction = async (req, res) => {
    try {
        const { reviewId } = req.params;
        const { type } = req.body; // 'like' | 'dislike'
        const userId = req.user.id;

        if (!['like', 'dislike'].includes(type)) {
            return res.error("Loại phản ứng không hợp lệ.", 400);
        }

        const review = await Review.findById(reviewId);
        if (!review || review.isDeleted) return res.error("Không tìm thấy bình luận.", 404);

        const userObjId = require('mongoose').Types.ObjectId.createFromHexString(userId);
        const hasLiked = review.likes.some(id => id.equals(userObjId));
        const hasDisliked = review.dislikes.some(id => id.equals(userObjId));

        if (type === 'like') {
            if (hasLiked) {
                review.likes.pull(userObjId); // toggle off
            } else {
                review.likes.push(userObjId);
                if (hasDisliked) review.dislikes.pull(userObjId); // xóa dislike nếu có
            }
        } else {
            if (hasDisliked) {
                review.dislikes.pull(userObjId); // toggle off
            } else {
                review.dislikes.push(userObjId);
                if (hasLiked) review.likes.pull(userObjId); // xóa like nếu có
            }
        }

        await review.save();

        const myStatus = review.likes.some(id => id.equals(userObjId))
            ? 'liked'
            : review.dislikes.some(id => id.equals(userObjId))
                ? 'disliked'
                : null;

        return res.success({
            likeCount: review.likes.length,
            dislikeCount: review.dislikes.length,
            myStatus
        });
    } catch (error) {
        console.error("❌ toggleReaction error:", error);
        return res.error(error.message, 500);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. Xóa bình luận (chỉ chủ sở hữu, xóa mềm)
// ─────────────────────────────────────────────────────────────────────────────
const deleteReview = async (req, res) => {
    try {
        const { reviewId } = req.params;
        const userId = req.user.id;

        const review = await Review.findOne({ _id: reviewId, userId, isDeleted: false });
        if (!review) return res.error("Không tìm thấy hoặc bạn không có quyền xóa bình luận này.", 403);

        review.isDeleted = true;
        await review.save();

        return res.success(null, "Đã xóa bình luận.");
    } catch (error) {
        console.error("❌ deleteReview error:", error);
        return res.error(error.message, 500);
    }
};

module.exports = { createReview, getPlanReviews, getReviewSummary, toggleReaction, deleteReview };