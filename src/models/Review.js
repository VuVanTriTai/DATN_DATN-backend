const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
    // userId = null khi tài khoản đã bị xoá (ẩn danh hoá thay vì xoá data)
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Rating chỉ dành cho bình luận cấp cha (parentId = null)
    rating: { type: Number, min: 1, max: 5, default: null },
    content: { type: String, required: true },

    // Nếu parentId có giá trị, đây là một câu trả lời (Reply)
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Review', default: null },

    // Lưu danh sách ID những người đã Like/Dislike để check trạng thái
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    dislikes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    isDeleted: { type: Boolean, default: false }
}, { timestamps: true });

// Index để tìm kiếm nhanh bình luận theo khóa học
reviewSchema.index({ planId: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);