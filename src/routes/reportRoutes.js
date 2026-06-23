const express = require('express');
const router = express.Router();
const verifyToken = require('../middlewares/authMiddleware');
const isAdmin = require('../middlewares/isAdmin');
const { createReport, getReports, resolveReport, dismissReport } = require('../controllers/reportController');

// ── Người dùng gửi báo cáo (cần đăng nhập)
router.post('/', verifyToken, createReport);

// ── Admin: Lấy danh sách báo cáo
router.get('/', verifyToken, isAdmin, getReports);

// ── Admin: Xử lý báo cáo (gỡ nội dung)
router.patch('/:id/resolve', verifyToken, isAdmin, resolveReport);

// ── Admin: Bỏ qua báo cáo (không gỡ nội dung)
router.patch('/:id/dismiss', verifyToken, isAdmin, dismissReport);

module.exports = router;
