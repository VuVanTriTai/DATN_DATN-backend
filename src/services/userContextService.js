// services/personalizationService.js
// Dịch vụ này sẽ xử lý các logic liên quan đến cá nhân hóa trải nghiệm học tập của người dùng, như cập nhật bộ nhớ học tập và xác định chế độ học tập phù hợp dựa trên tiến trình của họ.
const UserMemory = require("../models/UserMemory");
const Progress = require("../models/Progress");
/**
 * 📌 UPDATE MEMORY (đã có nhưng viết lại chuẩn hơn)
 */
const updateUserMemory = async (userId, topic) => {
    try {
        if (!userId || !topic) return;

        await UserMemory.findOneAndUpdate(
            { userId, topic },
            { $inc: { count: 1 } },
            { upsert: true, new: true }
        );

    } catch (err) {
        console.error("❌ updateUserMemory error:", err.message);
    }
};
/**
 * 📌 GET LEARNING MODE (QUAN TRỌNG)
 * Tác dụng: Xác định trình độ của học viên đối với chủ đề hiện tại.
 * Logic: 
 * - Nếu học viên đã học chủ đề này trước đó và điểm cao (>=80) -> ADVANCED (Dạy nâng cao).
 * - Nếu điểm thấp (<50) -> REMEDIAL (Dạy phụ đạo, giải thích cực kỹ).
 * - Còn lại -> NORMAL.
 */
const getLearningMode = async (userId, currentTopic) => {
    try {
        if (!userId) return "NORMAL";

        // Tìm bản ghi tiến độ gần nhất có chứa topic này
        // Sắp xếp theo updatedAt để lấy kết quả mới nhất học viên đạt được
        const progress = await Progress.findOne({
            userId,
            "knowledgeMap.topic": currentTopic
        }).sort({ updatedAt: -1 });

        if (!progress) return "NORMAL";

        // Lấy thông tin tri thức về topic cụ thể này
        const topicInfo = progress.knowledgeMap.find(k => k.topic === currentTopic);

        if (!topicInfo) return "NORMAL";

        if (topicInfo.score >= 80) return "ADVANCED";
        if (topicInfo.score < 50) return "REMEDIAL";

        return "NORMAL";
    } catch (err) {
        console.error("❌ getLearningMode error:", err.message);
        return "NORMAL";
    }
};

module.exports = {
    updateUserMemory,
    getLearningMode
};