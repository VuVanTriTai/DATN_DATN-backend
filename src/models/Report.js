const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  // Loại nội dung bị báo cáo
  targetType: {
    type: String,
    enum: ['course', 'review', 'instructorRating'],
    required: true
  },
  // ID của nội dung bị báo cáo
  targetId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  // Người gửi báo cáo (null nếu tài khoản đã bị xoá)
  reportedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // Lý do báo cáo
  reason: {
    type: String,
    enum: [
      'spam',
      'inappropriate_content',
      'wrong_information',
      'hate_speech',
      'copyright',
      'other'
    ],
    required: true
  },
  // Mô tả thêm (tuỳ chọn)
  description: { type: String, default: '' },

  // Trạng thái xử lý
  status: {
    type: String,
    enum: ['pending', 'resolved', 'dismissed'],
    default: 'pending'
  },

  // Ghi chú của admin khi xử lý
  adminNote: { type: String, default: '' },

  // Snapshot thông tin nội dung bị báo cáo (để hiển thị ngay cả khi bị xoá)
  snapshot: { type: Object, default: null },
}, { timestamps: true });

// Index để tìm kiếm nhanh
reportSchema.index({ targetType: 1, status: 1, createdAt: -1 });
reportSchema.index({ targetId: 1, targetType: 1 });

module.exports = mongoose.model('Report', reportSchema);
