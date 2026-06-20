// src/models/Plan.js
const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
  title: { type: String, required: true },
  topic: String,
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  instructorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  duration: { type: Number, default: 7 },

  // 🆔 ID của lộ trình gốc (Dùng để kiểm tra xem một người đã sở hữu bản clone của lộ trình này chưa)
  originalPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null },

  // ✅ CẬP NHẬT: Thêm các giá trị viết thường vào enum để tránh lỗi Validation
  level: {
    type: String,
    enum: ["Easy", "Medium", "Hard", "Basic", "Advanced", "basic", "advanced", "intermediate"],
    default: "Medium"
  },

  videoUrl: { type: String, default: null },

  // ✅ CẬP NHẬT: Đồng bộ enum cho cả viết hoa và viết thường
  learningGoals: {
    focus: { type: String, enum: ['theory', 'practice', 'practical'], default: 'theory' },
    depth: { type: String, enum: ['basic', 'deep', 'advanced'], default: 'basic' }
  },

  description: String,

  sourceType: {
    type: String,
    enum: ['self', 'imported', 'assigned', 'shared_import', 'manual'],
    default: 'self'
  },

  isPublic: { type: Boolean, default: false },
  categories: [{ type: String }],
  tags: [String],
  normalizedTags: [String],
  sharedWith: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  status: {
    type: String,
    enum: ['pending', 'teaching', 'reviewed', 'draft'], 
  default: 'pending'
  },

  isDeleted: { type: Boolean, default: false },
  deletedByOwner: { type: Boolean, default: false },
  deletedByInstructor: { type: Boolean, default: false },

  documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },

  documentMetadata: {
    wordCount: { type: Number, default: 0 },
    hasFormulas: { type: Boolean, default: false },
    complexity: { type: String, default: 'medium' },
  },
  instructorDraftTitle: { type: String, default: null },
hasTitleDraft: { type: Boolean, default: false },

  // ✅ CẬP NHẬT: Đảm bảo khớp với learningGoals ở trên
  learningFocus: { type: String, enum: ['theory', 'practice', 'practical'], default: 'theory' },
  learningDepth: { type: String, enum: ['basic', 'deep', 'advanced'], default: 'basic' },

}, { timestamps: true });

module.exports = mongoose.model('Plan', planSchema);