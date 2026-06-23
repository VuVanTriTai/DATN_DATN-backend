const mongoose = require("mongoose");

const instructorRatingSchema = new mongoose.Schema({
  instructor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  // learner = null khi tài khoản học viên đã bị xoá (ẩn danh hoá)
  learner: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  stars: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, default: "" },
}, { timestamps: true });

// Mỗi học viên chỉ đánh giá 1 lần mỗi giáo viên (chỉ áp dụng khi learner không null)
instructorRatingSchema.index(
  { instructor: 1, learner: 1 },
  { 
    unique: true, 
    partialFilterExpression: { learner: { $exists: true, $ne: null } } 
  }
);

module.exports = mongoose.model("InstructorRating", instructorRatingSchema);
