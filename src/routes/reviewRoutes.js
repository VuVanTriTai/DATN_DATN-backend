const express = require('express');
const router = express.Router();
const reviewController = require('../controllers/reviewController');
const verifyToken = require('../middlewares/authMiddleware');

router.use(verifyToken);

// ── Phản ứng Like/Dislike (ĐẶT TRƯỚC để tránh xung đột route với /:planId) ──
router.post('/react/:reviewId', reviewController.toggleReaction);

// ── Lấy tổng kết rating của một khóa học ──
router.get('/summary/:planId', reviewController.getReviewSummary);

// ── Gửi review/comment cho khóa học ──
router.post('/:planId', reviewController.createReview);

// ── Lấy danh sách review của khóa học (hỗ trợ phân trang) ──
router.get('/:planId', reviewController.getPlanReviews);

// ── Xóa bình luận (chỉ chủ sở hữu) ──
router.delete('/:reviewId', reviewController.deleteReview);

module.exports = router;