const Plan = require("../models/Plan");
const Lesson = require("../models/Lesson");
const User = require("../models/User");
const Enrollment = require("../models/Enrollment");
const UserMemory = require("../models/UserMemory");
const Review = require("../models/Review");

const NOISE_WORDS = new Set([
  // Tiếng Việt
  'và', 'của', 'về', 'trong', 'cho', 'các', 'những', 'một', 'hai', 'ba', 'bản', 'sao', 'đang', 'được', 'bởi', 'tại', 'theo', 'với', 'như', 'để', 'này', 'kia', 'đó', 'tôi', 'bạn', 'chúng', 'cùng',
  'lên', 'xuống', 'trên', 'dưới', 'sau', 'trước', 'giữa', 'từ', 'đến', 'qua', 'lại', 'ra', 'vào', 'ở', 'có', 'không', 'đã', 'sẽ', 'đang', 'rồi', 'thì', 'mà', 'là', 'nhưng', 'hoặc', 'hay', 'nếu',
  'thế', 'vì', 'nên', 'tới', 'bị', 'cả', 'quá', 'rất', 'hơn', 'chỉ', 'tự', 'làm', 'thấy', 'biết', 'muốn', 'cần',
  'khóa', 'học', 'bài', 'tập', 'đề', 'thi', 'cơ', 'bản', 'nâng', 'cao', 'trình', 'lộ', 'hướng', 'dẫn', 'giới', 'thiệu', 'tổng', 'quan', 'giáo', 'trình', 'tài', 'liệu', 'thuyết', 'hành', 'chuyên', 'sâu',
  // English
  'the', 'of', 'in', 'to', 'for', 'and', 'a', 'an', 'on', 'at', 'by', 'with', 'about', 'as', 'into', 'like', 'through', 'after', 'before', 'between', 'under', 'over', 'from', 'about', 'into', 'its', 'their',
  'or', 'but', 'if', 'then', 'else', 'when', 'where', 'why', 'how', 'who', 'whom', 'this', 'that', 'these', 'those', 'it', 'its', 'he', 'she', 'they', 'we', 'you', 'me', 'him', 'her', 'us', 'them', 'is',
  'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'course', 'lesson', 'tutorial', 'guide', 'introduction', 'basic', 'advanced', 'intermediate', 'practice', 'theory', 'sao_chép', 'clone', 'copy'
]);

const extractKeywords = (title) => {
  if (!title) return [];
  const words = title.split(/[\s,\-\.\(\)\[\]\/]+/);
  const keywords = [];
  words.forEach(word => {
    const w = word.toLowerCase().trim();
    if (w.length >= 2 && !NOISE_WORDS.has(w)) {
      keywords.push(w);
    }
  });
  return keywords;
};

// 1. Xem khái quát tiêu đề các ngày
const getCoursePreview = async (req, res) => {
  try {
    const { id } = req.params;
    const lessons = await Lesson.find({ planId: id, isDeleted: false })
      .select("dayNumber title summary") // Chỉ lấy tiêu đề và tóm tắt, không lấy content/quiz
      .sort({ dayNumber: 1 }); // sap xep theo ngay hoc

    return res.success(lessons);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

// 2. Lấy lộ trình về kho cá nhân
const importCourse = async (req, res) => {
  try {
    const sourcePlanId = req.params.id; // lấy id của plan cần import
    const userId = req.user.id; // lấy id của user hiện tại
    console.log(`[Import Course] 🚀 Bắt đầu import khóa học gốc ID: ${sourcePlanId} cho người dùng ID: ${userId}`);

    // Lấy plan gốc
    const sourcePlan = await Plan.findById(sourcePlanId);
    if (!sourcePlan) return res.error("Không tìm thấy lộ trình gốc", 404);

    // Xác định xem đây là import từ Market hay từ lộ trình được chia sẻ riêng
    const isFromMarket = sourcePlan.isPublic === true;

    // Tạo Plan mới bản sao cho User
    const newPlan = await Plan.create({
      title: sourcePlan.title,
      topic: sourcePlan.topic,
      owner: userId,
      duration: sourcePlan.duration,
      level: sourcePlan.level,
      learningFocus: sourcePlan.learningFocus,
      learningDepth: sourcePlan.learningDepth,
      learningGoals: sourcePlan.learningGoals,// lấy mục tiêu học tập
      categories: sourcePlan.categories,// lấy danh mục
      tags: sourcePlan.tags,// lấy tags
      normalizedTags: sourcePlan.normalizedTags,// lấy normalizedTags
      documentMetadata: sourcePlan.documentMetadata,// lấy metadata
      documentId: sourcePlan.documentId,// lấy id của tài liệu gốc
      sourceType: isFromMarket ? 'imported' : 'shared_import', // Phân biệt nguồn gốc
      originalPlanId: sourcePlan._id, // 🌟 LƯU VẾT ID CỦA LỘ TRÌNH GỐC
      isPublic: false // Bản sao cá nhân nên để private
    });

    // Copy toàn bộ bài học sang Plan mới
    const sourceLessons = await Lesson.find({ planId: sourcePlanId, isDeleted: false });
    const newLessons = sourceLessons.map(l => {// map qua từng bài học
      const lessonData = l.toObject(); // chuyển sang object
      delete lessonData._id; // xóa _id
      delete lessonData.id; // xóa id
      delete lessonData.createdAt; // xóa createdAt
      delete lessonData.updatedAt; // xóa updatedAt
      return {
        ...lessonData, // spread các thuộc tính của bài học
        planId: newPlan._id, // gán planId mới
        status: lessonData.dayNumber === 1 ? 'in-progress' : 'locked' // gán status
      };
    });

    if (newLessons.length > 0) {
      await Lesson.insertMany(newLessons);// thêm bài học vào plan mới
    }

    // Nếu khóa học này được share cho cá nhân, xóa user khỏi danh sách sharedWith để ẩn khỏi mục "Lộ trình được chia sẻ"
    if (sourcePlan.sharedWith && sourcePlan.sharedWith.some(id => id.toString() === userId.toString())) {
      sourcePlan.sharedWith = sourcePlan.sharedWith.filter(id => id.toString() !== userId.toString());
      await sourcePlan.save();
    }

    // 🌟 TỰ ĐỘNG TẠO BẢN GHI ENROLLMENT ĐỂ TĂNG STUDENT COUNT VÀ PHỤC VỤ THEO DÕI
    const existingEnrollment = await Enrollment.findOne({
      learnerId: userId,// id của user hiện tại
      planId: sourcePlan._id, // id của plan gốc (Để tăng student count cho plan gốc)
      instructorId: sourcePlan.owner // id của người tạo (Để tăng số học viên cho instructor)
    });

    if (!existingEnrollment) {// nếu chưa có enrollment
      await Enrollment.create({
        learnerId: userId,
        planId: sourcePlan._id,
        instructorId: sourcePlan.owner,
        status: "active" // trạng thái là active
      });
    }

    console.log(`[Import Course] ✅ Đã import thành công khóa học. New Plan ID: ${newPlan._id}`);
    return res.success({ _id: newPlan._id }, "Đã lấy lộ trình về kho cá nhân thành công!");
  } catch (error) {
    console.error("Error importing course:", error);
    return res.error(error.message, 500);
  }
};

// 3. Lấy danh sách khóa học trên market (có bộ lọc và phân trang)
const getMarketCourses = async (req, res) => {
  try {
    const { search, category, level, page = 1, limit = 12, instructorSearch, sort = 'weekly_downloads' } = req.query;
    const p = parseInt(page) || 1;
    const l = parseInt(limit) || 12;

    // 1. Xây dựng Query cơ bản
    const query = { isPublic: true, isDeleted: false };

    // Lọc theo tên khóa học
    if (search) {
      const escapedSearch = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.title = { $regex: escapedSearch, $options: "i" }; //$options: "i" để tìm kiếm không phân biệt chữ hoa chữ thường
    }

    // Lọc theo danh mục (hỗ trợ cả key chuẩn hóa và chuỗi tiếng Việt cũ)
    if (category && category !== 'all') {
      const categoryMapping = {
        lap_trinh: ["lap_trinh", "Lập trình"],
        tri_tue_nhan_tao: ["tri_tue_nhan_tao", "Trí tuệ nhân tạo"],
        khoa_hoc_may_tinh: ["khoa_hoc_may_tinh", "Khoa học máy tính"],
        ngoai_ngu: ["ngoai_ngu", "Ngoại ngữ"],
        kinh_te_tai_chinh: ["kinh_te_tai_chinh", "Kinh tế", "Kinh tế & Tài chính"],
        marketing: ["marketing", "Kinh doanh & Marketing", "Kinh doanh"],
        toan_hoc: ["toan_hoc", "Toán học"],
        khoa_hoc_tu_nhien: ["khoa_hoc_tu_nhien", "Khoa học tự nhiên", "Vật lý", "Hóa học", "Sinh học"],
        y_hoc: ["y_hoc", "Y học & Sức khỏe", "Y học"],
        thiet_ke_do_hoa: ["thiet_ke_do_hoa", "Thiết kế đồ họa"],
        khoa_hoc_xa_hoi: ["khoa_hoc_xa_hoi", "Khoa học xã hội", "Lịch sử", "Địa lý", "Văn học", "Triết học"],
        am_nhac_nghe_thuat: ["am_nhac_nghe_thuat", "Âm nhạc & Nghệ thuật", "Âm nhạc"],
        khac: ["khac", "Khác", "Lĩnh vực Khác"]
      };
      const mappedValues = categoryMapping[category] || [category];
      query.categories = { $in: mappedValues };
    }

    // Lọc theo cấp độ
    if (level && level !== 'all') {
      if (level === 'Easy') {
        query.level = { $in: [/^easy$/i, /^basic$/i] };
      } else if (level === 'Medium') {
        query.level = { $in: [/^medium$/i, /^intermediate$/i] };
      } else if (level === 'Hard') {
        query.level = { $in: [/^hard$/i, /^advanced$/i] };
      } else {
        const escapedLevel = String(level).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        query.level = new RegExp(`^${escapedLevel}$`, 'i');
      }
    }

    // Lọc theo Giảng viên
    if (instructorSearch && instructorSearch.trim()) {
      const escapedInstructor = instructorSearch.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matchedUsers = await User.find({
        $or: [
          { fullName: { $regex: escapedInstructor, $options: "i" } },
          { email: { $regex: escapedInstructor, $options: "i" } },
        ],
      }).select("_id");//chỉ lấy id để filter

      const userIds = matchedUsers.map(u => u._id);
      query.$or = [
        { owner: { $in: userIds } }, // owner là id của người tạo (chủ sở hữu)
        { instructorId: { $in: userIds } } // instructorId là id của người hướng dẫn
      ];
    }

    // 2. Nếu sort theo students hoặc weekly_downloads → cần thống kê trước để sắp xếp
    //    Nếu sort theo newest → dùng sort MongoDB bình thường
    let sortedPlanIds = null; // null = không cần pre-sort

    if (sort === 'students' || sort === 'weekly_downloads') {
      // Lấy tất cả planIds khớp query (không phân trang) để tính thống kê sắp xếp
      const allMatchedPlans = await Plan.find(query).select('_id').lean();
      const allPlanIds = allMatchedPlans.map(p => p._id);

      if (sort === 'students') {
        // Sắp xếp theo tổng số học viên đang học (enrollment active)
        const studentStats = await Enrollment.aggregate([
          { $match: { planId: { $in: allPlanIds }, status: 'active' } },
          { $group: { _id: "$planId", studentCount: { $sum: 1 } } },
          { $sort: { studentCount: -1 } }
        ]);
        const rankedIds = studentStats.map(s => s._id.toString());
        // Những plan chưa có enrollment → thêm vào cuối
        const rankedSet = new Set(rankedIds);
        allPlanIds.forEach(id => {
          if (!rankedSet.has(id.toString())) rankedIds.push(id.toString());
        });
        sortedPlanIds = rankedIds;

      } else if (sort === 'weekly_downloads') {
        // Sắp xếp theo số lượt tải (import) trong 7 ngày gần nhất
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const weeklyStats = await Enrollment.aggregate([
          {
            $match: {
              planId: { $in: allPlanIds },
              status: 'active',
              createdAt: { $gte: oneWeekAgo }
            }
          },
          { $group: { _id: "$planId", weeklyCount: { $sum: 1 } } },
          { $sort: { weeklyCount: -1 } }
        ]);
        const rankedIds = weeklyStats.map(s => s._id.toString());
        const rankedSet = new Set(rankedIds);
        allPlanIds.forEach(id => {
          if (!rankedSet.has(id.toString())) rankedIds.push(id.toString());
        });
        sortedPlanIds = rankedIds;
      }
    }

    // 3. Lấy danh sách khoá học theo thứ tự đã sắp xếp (có phân trang)
    let courses;
    const total = await Plan.countDocuments(query);

    if (sortedPlanIds) {
      // Phân trang thủ công dựa trên danh sách đã sắp xếp
      const pageIds = sortedPlanIds.slice((p - 1) * l, p * l);
      const mongoose = require('mongoose');
      const objectIds = pageIds.map(id => new mongoose.Types.ObjectId(id));
      const rawCourses = await Plan.find({ _id: { $in: objectIds } })
        .populate("owner", "fullName email")
        .populate("instructorId", "fullName email")
        .lean();
      // Giữ đúng thứ tự đã sắp xếp
      const courseMap = {};
      rawCourses.forEach(c => courseMap[c._id.toString()] = c);
      courses = pageIds.map(id => courseMap[id]).filter(Boolean);
    } else {
      // Sort mặc định: mới nhất
      courses = await Plan.find(query)
        .populate("owner", "fullName email")
        .populate("instructorId", "fullName email")
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean();
    }

    // Nếu không có khóa học nào, trả về mảng rỗng
    if (courses.length === 0) {
      return res.success({
        courses: [],
        total: 0,
        totalPages: 0,
        currentPage: p
      });
    }

    // 4. Lấy danh sách ID các khóa học hiện tại để thống kê bổ sung
    const planIds = courses.map(c => c._id);
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // 5. Chạy song song thống kê Enrollment, Reviews và lượt tải tuần
    const [enrollmentStats, reviewStats, weeklyStats] = await Promise.all([
      // Thống kê số lượng học viên
      Enrollment.aggregate([
        { $match: { planId: { $in: planIds }, status: 'active' } },
        { $group: { _id: "$planId", studentCount: { $sum: 1 } } }
      ]),
      // Thống kê đánh giá sao và số lượt bình luận
      Review.aggregate([
        { $match: { planId: { $in: planIds }, parentId: null, isDeleted: false } },
        {
          $group: {
            _id: "$planId",
            avgRating: { $avg: "$rating" },
            reviewCount: { $sum: 1 }
          }
        }
      ]),
      // Thống kê số lượt tải trong tuần
      Enrollment.aggregate([
        { $match: { planId: { $in: planIds }, status: 'active', createdAt: { $gte: oneWeekAgo } } },
        { $group: { _id: "$planId", weeklyDownloads: { $sum: 1 } } }
      ])
    ]);

    // Chuyển kết quả thống kê thành Map để truy xuất nhanh
    const enrollmentMap = {};
    enrollmentStats.forEach(s => enrollmentMap[s._id.toString()] = s.studentCount);

    const reviewMap = {};
    reviewStats.forEach(s => reviewMap[s._id.toString()] = s);

    const weeklyMap = {};
    weeklyStats.forEach(s => weeklyMap[s._id.toString()] = s.weeklyDownloads);

    // 6. Tổng hợp dữ liệu cuối cùng
    const finalCourses = courses.map(course => {
      const idStr = course._id.toString();
      return {
        ...course,
        studentCount: enrollmentMap[idStr] || 0,
        avgRating: reviewMap[idStr] ? parseFloat(reviewMap[idStr].avgRating.toFixed(1)) : 0,
        reviewCount: reviewMap[idStr] ? reviewMap[idStr].reviewCount : 0,
        weeklyDownloads: weeklyMap[idStr] || 0
      };
    });

    // 7. Trả về kết quả
    return res.success({
      courses: finalCourses,
      total,
      totalPages: Math.ceil(total / l),
      currentPage: p
    });

  } catch (error) {
    console.error("🔥 getMarketCourses error:", error);
    return res.error(error.message, 500);
  }
};

// 4. Lấy danh sách khóa học public của một giảng viên
const getCoursesByInstructor = async (req, res) => {
  try {
    const { instructorId } = req.params;
    const courses = await Plan.find({
      owner: instructorId,
      isPublic: true,
      isDeleted: false,
    })
      .populate("owner", "fullName email")
      .sort({ createdAt: -1 })
      .lean();
    return res.success(courses);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

// 5. Lấy danh sách khóa học của mình đang trên market
const getMyListings = async (req, res) => {
  try {
    const userId = req.user.id;
    const courses = await Plan.find({
      owner: userId,
      isPublic: true,
      isDeleted: false,
    })
      .sort({ updatedAt: -1 })
      .lean();

    // Đếm số người đã import mỗi khóa học
    const coursesWithStats = await Promise.all(
      courses.map(async (course) => {
        const importCount = await Plan.countDocuments({
          sourceType: 'imported',
          title: course.title,
          isDeleted: false,
          owner: { $ne: userId },
        });
        return { ...course, importCount };
      })
    );

    return res.success(coursesWithStats);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

// 6. Gỡ khóa học khỏi market (isPublic = false)
const unlistCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const plan = await Plan.findOne({
      _id: id,
      owner: userId,
      isPublic: true
    });

    if (!plan) return res.error("Không tìm thấy khóa học công khai hoặc bạn không có quyền.", 404);

    plan.isPublic = false;
    await plan.save();

    return res.success(null, "Đã gỡ khóa học khỏi Market.");
  } catch (error) {
    return res.error(error.message, 500);
  }
};

// 7. Lấy danh sách khóa học đã import từ market
const getMyImports = async (req, res) => {
  try {
    const userId = req.user.id;
    const courses = await Plan.find({
      owner: userId,
      sourceType: 'imported',
      isDeleted: false,
    })
      .sort({ createdAt: -1 })
      .lean();
    return res.success(courses);
  } catch (error) {
    return res.error(error.message, 500);
  }
};

// 8. Xóa khóa học đã import khỏi kho cá nhân
const removeImport = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const plan = await Plan.findOne({
      _id: id,
      owner: userId,
      sourceType: 'imported',
      isDeleted: false,
    });
    if (!plan) return res.error('Không tìm thấy khóa học hoặc bạn không có quyền.', 404);

    plan.isDeleted = true;
    await plan.save();

    return res.success(null, 'Đã xóa khóa học khỏi kho cá nhân.');
  } catch (error) {
    return res.error(error.message, 500);
  }
};

// 9. Gợi ý đề cử khóa học (Recommendations)
const getMarketRecommendations = async (req, res) => {
  try {
    const userId = req.user?.id;

    // ── 1. Thống kê độ phổ biến (số học viên đang active) ──────────────────────
    const enrollmentStats = await Enrollment.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: "$planId", studentCount: { $sum: 1 } } }
    ]);
    const popularityMap = new Map();
    enrollmentStats.forEach(stat => popularityMap.set(stat._id.toString(), stat.studentCount));

    // ── 2. Xây dựng bộ tín hiệu sở thích từ NHIỀU nguồn ─────────────────────
    let interestTopics = new Set();     // keywords từ title
    let interestCategories = new Set(); // category codes
    let interestTags = new Set();       // tags

    if (userId) {
      // 2a. UserMemory (lịch sử học bài quiz) - nguồn mạnh nhất
      const memory = await UserMemory.find({ userId }).sort({ count: -1 }).limit(10).lean();
      memory.forEach(m => {
        if (m.topic) interestTopics.add(m.topic.toLowerCase().trim());
      });

      // 2b. Khoá học user đã TỰ TẠO (bao gồm đã share lên Market)
      // → Lấy categories, tags, và từ khoá trong title
      const ownPlans = await Plan.find({
        owner: userId,
        isDeleted: false,
        deletedByOwner: { $ne: true },
      }).select('title categories tags normalizedTags learningFocus').lean();

      ownPlans.forEach(p => {
        // Từ khoá trong tiêu đề (tách word > 3 ký tự)
        if (p.title) {
          extractKeywords(p.title).forEach(w => interestTopics.add(w));
        }
        // Categories & tags
        (p.categories || []).forEach(c => interestCategories.add(c));
        (p.tags || []).forEach(t => interestTags.add(t.toLowerCase().trim()));
        (p.normalizedTags || []).forEach(t => interestTags.add(t.toLowerCase().trim()));
      });

      // 2c. Khoá học user đã IMPORT từ Market
      const importedPlans = await Plan.find({
        owner: userId,
        sourceType: { $in: ['imported', 'shared_import'] },
        isDeleted: false,
      }).select('title categories tags normalizedTags').lean();

      importedPlans.forEach(p => {
        (p.categories || []).forEach(c => interestCategories.add(c));
        (p.tags || []).forEach(t => interestTags.add(t.toLowerCase().trim()));
        if (p.title) {
          extractKeywords(p.title).forEach(w => interestTopics.add(w));
        }
      });
    }

    const hasSignals = interestTopics.size > 0 || interestCategories.size > 0 || interestTags.size > 0;

    // ── 3. Truy vấn Market dựa trên tín hiệu đã tổng hợp ──────────────────────
    const baseQuery = { isPublic: true, isDeleted: false };
    let recommendedPlans = [];

    if (hasSignals) {
      const orClauses = [];

      // Tìm theo categories (match chính xác code - tín hiệu mạnh nhất)
      if (interestCategories.size > 0) {
        orClauses.push({ categories: { $in: Array.from(interestCategories) } });
      }
      // Tìm theo tags
      if (interestTags.size > 0) {
        const tagArr = Array.from(interestTags);
        orClauses.push({ tags: { $in: tagArr } });
        orClauses.push({ normalizedTags: { $in: tagArr } });
      }
      // Tìm theo từ khoá trong title (regex OR)
      if (interestTopics.size > 0) {
        const escapedTopics = Array.from(interestTopics)
          .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .filter(t => t.length > 0);
        if (escapedTopics.length > 0) {
          const topicRegex = new RegExp(escapedTopics.join('|'), 'i');
          orClauses.push({ title: { $regex: topicRegex } });
        }
      }

      if (orClauses.length > 0) {
        recommendedPlans = await Plan.find({ ...baseQuery, $or: orClauses })
          .populate('owner', 'fullName email')
          .populate('instructorId', 'fullName email')
          .limit(40)
          .lean();
      }
    }

    // ── 4. Fallback: nếu chưa đủ kết quả → bổ sung khoá học mới nhất ─────────
    if (recommendedPlans.length < 6) {
      const existingIds = new Set(recommendedPlans.map(p => p._id.toString()));
      const popular = await Plan.find(baseQuery)
        .populate('owner', 'fullName email')
        .populate('instructorId', 'fullName email')
        .sort({ createdAt: -1 })
        .limit(30)
        .lean();

      popular.forEach(p => {
        if (!existingIds.has(p._id.toString())) {
          recommendedPlans.push(p);
          existingIds.add(p._id.toString());
        }
      });
    }

    // ── 5. Thống kê Review cho các khóa đề cử ─────────────────────────────────
    const planIds = recommendedPlans.map(p => p._id);
    const reviewStats = await Review.aggregate([
      { $match: { planId: { $in: planIds }, parentId: null, isDeleted: false } },
      {
        $group: {
          _id: '$planId',
          avgRating: { $avg: '$rating' },
          reviewCount: { $sum: 1 }
        }
      }
    ]);
    const reviewMap = {};
    reviewStats.forEach(s => reviewMap[s._id.toString()] = s);

    // ── 6. Tính điểm liên quan, sắp xếp, trả về ────────────────────────────────
    const finalRecommendations = recommendedPlans.map(plan => {
      const idStr = plan._id.toString();
      const studentCount = popularityMap.get(idStr) || 0;
      const avgRating = reviewMap[idStr] ? parseFloat(reviewMap[idStr].avgRating.toFixed(1)) : 0;
      const reviewCount = reviewMap[idStr] ? reviewMap[idStr].reviewCount : 0;

      // Điểm liên quan: category match > tag match > title keyword match
      let relevanceScore = 0;
      if (hasSignals) {
        const planCategories = plan.categories || [];
        const planTags = (plan.tags || []).map(t => t.toLowerCase());
        const planNormalizedTags = (plan.normalizedTags || []).map(t => t.toLowerCase());

        planCategories.forEach(c => {
          if (interestCategories.has(c)) relevanceScore += 3;
        });
        planTags.forEach(t => {
          if (interestTags.has(t)) relevanceScore += 2;
        });
        planNormalizedTags.forEach(t => {
          if (interestTags.has(t)) relevanceScore += 2;
        });
        if (plan.title) {
          interestTopics.forEach(topic => {
            if (plan.title.toLowerCase().includes(topic)) relevanceScore += 1;
          });
        }
      }

      return { ...plan, studentCount, avgRating, reviewCount, _relevanceScore: relevanceScore };
    });

    // Sắp xếp: relevanceScore → studentCount → avgRating
    finalRecommendations.sort((a, b) => {
      if (b._relevanceScore !== a._relevanceScore) return b._relevanceScore - a._relevanceScore;
      if (b.studentCount !== a.studentCount) return b.studentCount - a.studentCount;
      return b.avgRating - a.avgRating;
    });

    // Xoá trường nội bộ trước khi trả về
    const cleaned = finalRecommendations.slice(0, 10).map(({ _relevanceScore, ...rest }) => rest);

    return res.success({
      isPersonalized: hasSignals,
      userInterests: [
        ...Array.from(interestCategories),
        ...Array.from(interestTopics).slice(0, 5),
      ],
      courses: cleaned
    });

  } catch (error) {
    console.error('🔥 Recommendation Error:', error);
    return res.error(error.message, 500);
  }
};

module.exports = {
  getMarketCourses,
  getCoursePreview,
  importCourse,
  getCoursesByInstructor,
  getMyListings,
  unlistCourse,
  getMyImports,
  removeImport,
  getMarketRecommendations,
};