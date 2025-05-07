const express = require('express');
const router = express.Router();
const firebaseService = require('../services/firebaseService');
const { isAdmin } = require('../middleware/authMiddleware');
const multer = require('multer'); // Для обработки загрузки логотипа
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// GET /admin/companies/ - Показать список всех компаний
router.get('/', isAdmin, async (req, res, next) => {
    try {
        const companies = await firebaseService.getAllCompanies();
        res.render('admin/companies-list', { // Мы создадим этот view позже
            title: 'Управление компаниями',
            companies: companies,
            user: req.session.user,
            message: req.session.message
        });
        if (req.session.message) delete req.session.message;
    } catch (error) {
        console.error("Ошибка при получении списка компаний для админа:", error);
        req.session.message = { type: 'error', text: 'Не удалось загрузить список компаний.' };
        res.redirect('/admin/dashboard'); // Предполагаем, что есть админ-дашборд
    }
});

// GET /admin/companies/:companyId/edit - Форма редактирования компании админом
router.get('/:companyId/edit', isAdmin, async (req, res, next) => {
    try {
        const companyId = req.params.companyId;
        const company = await firebaseService.getCompanyById(companyId);

        if (!company) {
            req.session.message = { type: 'error', text: 'Компания не найдена.' };
            return res.redirect('/admin/companies');
        }

        res.render('admin/company-edit', { // Мы создадим этот view
            title: `Редактирование: ${company.companyName}`,
            company: company,
            user: req.session.user,
            message: req.session.message // Передаем из сессии, если есть
        });
        if (req.session.message) delete req.session.message;

    } catch (error) {
        console.error(`Ошибка при загрузке компании ${req.params.companyId} для редактирования админом:`, error);
        req.session.message = { type: 'error', text: 'Не удалось загрузить данные компании для редактирования.' };
        res.redirect('/admin/companies');
    }
});

// POST /admin/companies/:companyId/edit - Обработка редактирования компании админом
router.post('/:companyId/edit', isAdmin, upload.single('companyLogo'), async (req, res, next) => {
    const companyId = req.params.companyId;
    try {
        const { companyName, companyContactEmail, companyContactPhone, companyWebsite, removeLogo } = req.body;

        if (!companyName || !companyName.trim()) {
            req.session.message = { type: 'error', text: 'Название компании обязательно.' };
            return res.redirect(`/admin/companies/${companyId}/edit`);
        }

        const updates = {
            companyName: companyName.trim(),
            companyContactEmail: companyContactEmail || null,
            companyContactPhone: companyContactPhone || null,
            companyWebsite: companyWebsite || null,
        };

        const currentCompany = await firebaseService.getCompanyById(companyId);
        if (!currentCompany) {
            req.session.message = { type: 'error', text: 'Компания не найдена для обновления.' };
            return res.redirect('/admin/companies');
        }

        if (req.file) { // Новый логотип загружен
            updates.companyLogoData = req.file.buffer.toString('base64');
        } else if (removeLogo === '1') { // Флаг на удаление логотипа
            updates.companyLogoData = null;
        }
        // Если новый лого не загружен и нет флага на удаление, companyLogoData не меняется (остается текущим)

        await firebaseService.updateCompany(companyId, updates);

        req.session.message = { type: 'success', text: `Данные компании "${updates.companyName}" успешно обновлены.` };
        res.redirect('/admin/companies');

    } catch (error) {
        console.error(`Ошибка при обновлении компании ${companyId} админом:`, error);
        if (error.message.includes('Название компании обязательно')) { // Пример специфичной обработки ошибки
             req.session.message = { type: 'error', text: error.message };
        } else {
             req.session.message = { type: 'error', text: 'Произошла ошибка при обновлении компании.' };
        }
        res.redirect(`/admin/companies/${companyId}/edit`);
    }
});

// GET /admin/companies/:companyId/balance - Форма изменения баланса админом
router.get('/:companyId/balance', isAdmin, async (req, res, next) => {
    try {
        const companyId = req.params.companyId;
        const company = await firebaseService.getCompanyById(companyId);

        if (!company) {
            req.session.message = { type: 'error', text: 'Компания не найдена.' };
            return res.redirect('/admin/companies');
        }

        res.render('admin/company-balance', { // Мы создадим этот view
            title: `Изменение баланса: ${company.companyName}`,
            company: company,
            user: req.session.user,
            message: req.session.message
        });
        if (req.session.message) delete req.session.message;

    } catch (error) {
        console.error(`Ошибка при загрузке компании ${req.params.companyId} для изменения баланса админом:`, error);
        req.session.message = { type: 'error', text: 'Не удалось загрузить данные компании для изменения баланса.' };
        res.redirect('/admin/companies');
    }
});

// POST /admin/companies/:companyId/balance - Обработка изменения баланса админом
router.post('/:companyId/balance', isAdmin, async (req, res, next) => {
    const companyId = req.params.companyId;
    try {
        const { newBalance, reason } = req.body; // newBalance - это уже целевой баланс из формы
        const targetBalanceValue = parseFloat(newBalance);

        if (isNaN(targetBalanceValue)) {
            req.session.message = { type: 'error', text: 'Некорректное значение для нового баланса.' };
            return res.redirect(`/admin/companies/${companyId}/balance`);
        }

        const company = await firebaseService.getCompanyById(companyId);
        if (!company) {
            req.session.message = { type: 'error', text: 'Компания не найдена.' };
            return res.redirect('/admin/companies');
        }

        const currentBalance = company.Balance || 0;
        // Определяем тип операции на основе разницы
        const diff = targetBalanceValue - currentBalance;
        const operationType = diff >= 0 ? 'Пополнение (Админ)' : 'Списание (Админ)';
        
        // Формируем описание
        const description = `Баланс изменен администратором ${req.session.user.username}. ${reason ? 'Причина: ' + reason + '.' : ''} Старый: ${currentBalance.toFixed(2)}, Новый: ${targetBalanceValue.toFixed(2)}`;

        // Передаем targetBalanceValue напрямую, а также operationType и description
        await firebaseService.updateCompanyBalance(companyId, targetBalanceValue, operationType, description);

        req.session.message = { type: 'success', text: `Баланс компании "${company.companyName}" успешно изменен на ${targetBalanceValue.toFixed(2)}.` };
        res.redirect('/admin/companies');

    } catch (error) {
        console.error(`Ошибка при изменении баланса компании ${companyId} админом:`, error);
        req.session.message = { type: 'error', text: 'Произошла ошибка при изменении баланса.' };
        res.redirect(`/admin/companies/${companyId}/balance`);
    }
});

module.exports = router; 