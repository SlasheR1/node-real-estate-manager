// routes/companyRoutes.js
const express = require('express');
const multer = require('multer');
const firebaseService = require('../services/firebaseService');
const { isLoggedIn } = require('../middleware/authMiddleware');
// isCompanyMemberOrAdmin проверяет, что юзер - админ ИЛИ член запрашиваемой компании
const { isCompanyMemberOrAdmin } = require('../middleware/companyMiddleware');
const admin = require('firebase-admin');
const db = admin.database();

const router = express.Router();

// Middleware: Проверка, что пользователь является ВЛАДЕЛЬЦЕМ ТЕКУЩЕЙ КОМПАНИИ (для действий типа редактирования, добавления стаффа)
// Выполняется ПОСЛЕ isLoggedIn и ensureCompanyExists
function isOwnerSelf(req, res, next) {
    if (req.session.user && req.session.user.role === 'Owner' && req.session.user.companyId) {
        // Можно добавить проверку совпадения companyId из сессии с :id если оно есть в URL
        // const targetCompanyId = req.params.id || req.session.user.companyId;
        // if(req.session.user.companyId === targetCompanyId) return next();
        return next(); // Пока просто проверяем роль и наличие companyId
    }
    req.session.message = { type: 'error', text: 'Доступ запрещен (только для владельца компании).' };
    res.redirect('/'); // Или на /company/manage, если он уже туда попал
}

// Multer для логотипа
const uploadLogo = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1 * 1024 * 1024 }, // 1MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) { cb(null, true); }
        else { cb(new Error('Разрешены только файлы изображений!'), false); }
    }
}).single('companyLogo');

// --- Маршруты Настройки Компании ---

// GET /company/setup - Показать страницу НАЧАЛЬНОЙ настройки
// Доступен только для Owner БЕЗ завершенного профиля (проверяется глобальным middleware checkCompanyProfile)
router.get('/setup', isLoggedIn, isOwnerSelf, async (req, res, next) => {
    // Middleware checkCompanyProfile должен был бы перенаправить, если профиль уже завершен,
    // но на всякий случай проверяем еще раз
    if (req.session.user.companyProfileCompleted) {
        console.log(`[GET /company/setup] Profile already completed for ${req.session.user.username}. Redirecting.`);
        return res.redirect('/company/manage'); // Отправляем на страницу управления, а не на дашборд
    }

    try {
        const [user, company] = await Promise.allSettled([ // Используем allSettled
             firebaseService.getUserByUsername(req.session.user.username),
             firebaseService.getCompanyById(req.session.user.companyId)
        ]);

        const userData = user.status === 'fulfilled' ? user.value : {};
        const companyData = company.status === 'fulfilled' ? company.value : {};

        res.render('company-setup', { // Отдельный шаблон для настройки
            title: 'Настройка компании',
            user: userData,
            company: companyData,
            message: req.session.message || null
        });
        if (req.session.message) delete req.session.message;
    } catch (error) {
        console.error("Error GET /company/setup:", error);
        next(error);
    }
});

// POST /company/setup - Обработать НАЧАЛЬНУЮ настройку
// Доступен только для Owner
router.post('/setup', isLoggedIn, isOwnerSelf, (req, res, next) => {
    uploadLogo(req, res, async (err) => {
        const username = req.session.user.username;
        const companyId = req.session.user.companyId; // Должен быть установлен ensureCompanyExists
        if (!companyId) { return next(new Error("ID компании не найден в сессии.")); }

        if (err) {
            req.session.message = { type: 'error', text: err.message || 'Ошибка загрузки логотипа.' };
            return req.session.save(saveErr => res.redirect('/company/setup'));
        }

        const { companyName, companyContactEmail, companyContactPhone, companyWebsite } = req.body;

        try {
            if (!companyName || !companyName.trim()) { throw new Error('Название компании обязательно.'); }

            const companyUpdates = {
                companyName: companyName.trim(),
                companyContactEmail: companyContactEmail || null,
                companyContactPhone: companyContactPhone || null,
                companyWebsite: companyWebsite || null,
                // companyProfileCompleted в компании не храним, храним в юзере
            };
            const userUpdates = {
                companyProfileCompleted: true // Отмечаем у пользователя
            };

            // Обработка логотипа
            if (req.file) {
                companyUpdates.companyLogoData = req.file.buffer.toString('base64');
            } else {
                // При начальной настройке старого лого нет
                companyUpdates.companyLogoData = null;
            }

            // Обновляем компанию и пользователя
            await firebaseService.updateCompany(companyId, companyUpdates);
            await db.ref(`users/${username}`).update(userUpdates);

            // Обновляем сессию
            req.session.user.companyName = companyUpdates.companyName;
            req.session.user.companyProfileCompleted = true;
            if (companyUpdates.companyLogoData !== undefined) {
                 req.session.user.companyLogoData = companyUpdates.companyLogoData;
            }

            req.session.save(saveErr => {
                 if(saveErr) console.error("[Company Setup POST] Session save error:", saveErr);
                 req.session.message = { type: 'success', text: 'Профиль компании настроен!' };
                 res.redirect('/company/manage'); // Редирект на страницу управления
            });

        } catch (error) {
             console.error(`[POST /company/setup] Error for ${username}:`, error);
             req.session.message = { type: 'error', text: error.message || 'Ошибка сохранения профиля.' };
             req.session.save(saveErr => res.redirect('/company/setup'));
        }
    });
});


// --- Маршруты Управления Компанией ---

// GET /company/manage - Основная страница управления компанией
// Доступна Owner/Staff своей компании ИЛИ Admin (с query.id)
// Middleware isCompanyMemberOrAdmin проверяет доступ
router.get('/manage', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => {
    try {
        const companyId = req.session.user.companyId;
        // Определяем ID целевой компании (для админа может быть из query)
        const targetCompanyId = (req.session.user.role === 'Admin' && req.query.id) ? req.query.id : companyId;

        if (!targetCompanyId) {
             // Если ID не определен (даже для админа), показываем ошибку
             return res.render('company-management', { title: "Ошибка", error: "ID компании не определен.", company: null, staffList: [], properties: [], bookings: [] });
        }

        // Загрузка данных компании
        const company = await firebaseService.getCompanyById(targetCompanyId);
        if (!company) {
             return res.status(404).render('company-management', { title: "Компания не найдена", error: `Компания с ID ${targetCompanyId} не найдена.`, company: null, staffList: [], properties: [], bookings: [] });
        }

        // Загрузка связанных данных (параллельно)
        const staffUsernames = company.staff ? Object.keys(company.staff) : [];
        const results = await Promise.allSettled([
            Promise.all(staffUsernames.map(uname => firebaseService.getUserByUsername(uname).catch(e => null))), // Ловим ошибки, если стафф удален
            firebaseService.getPropertiesByCompanyId(targetCompanyId),
            firebaseService.getAllBookings() // Загружаем все, фильтруем на клиенте/сервере
        ]);

        // Обрабатываем результаты Promise.allSettled
        const staffDetails = results[0].status === 'fulfilled' ? results[0].value.filter(Boolean) : [];
        const properties = results[1].status === 'fulfilled' ? results[1].value : [];
        const allBookings = results[2].status === 'fulfilled' ? results[2].value : [];

        // Фильтруем бронирования для этой компании
        const companyPropertyIds = properties.map(p => p.Id);
        const companyBookings = allBookings.filter(b => b && b.PropertyId && companyPropertyIds.includes(b.PropertyId));

        console.log(`[GET /company/manage] Rendering company management for ${targetCompanyId}`);
        // Рендерим шаблон company-management.ejs
        res.render('company-management', {
            title: `Управление: ${company.companyName}`,
            company: company,
            staffList: staffDetails,
            properties: properties || [], // Передаем объекты компании
            bookings: companyBookings, // Передаем аренды компании
            message: req.session.message || null
        });
        if (req.session.message) delete req.session.message;

    } catch (error) {
        console.error("[GET /company/manage] Error:", error);
        // Отображаем страницу с общей ошибкой
         res.status(500).render('company-management', {
             title: "Ошибка управления",
             error: "Произошла ошибка при загрузке данных компании.",
             company: null, staffList: [], properties: [], bookings: []
         });
         // Или передаем дальше: next(error);
    }
});

// POST /company/edit - Редактирование данных компании
// Доступно только владельцу ЭТОЙ компании (проверяется isOwnerSelf)
router.post('/edit', isLoggedIn, isOwnerSelf, (req, res, next) => {
    uploadLogo(req, res, async (err) => {
        const companyId = req.session.user.companyId; // Берем ID из сессии владельца
        if (!companyId) { return next(new Error("ID компании не найден в сессии.")); }

        if (err) {
            req.session.message = { type: 'error', text: err.message || 'Ошибка загрузки логотипа.' };
            return req.session.save(saveErr => res.redirect('/company/manage')); // Назад на страницу управления
        }

        const { companyName, companyContactEmail, companyContactPhone, companyWebsite } = req.body;
        try {
            if (!companyName || !companyName.trim()) { throw new Error('Название компании обязательно.'); }

            const companyUpdates = {
                companyName: companyName.trim(),
                companyContactEmail: companyContactEmail || null,
                companyContactPhone: companyContactPhone || null,
                companyWebsite: companyWebsite || null,
            };

            // Обработка логотипа
            let currentLogoData = null;
            const currentCompany = await firebaseService.getCompanyById(companyId);
            currentLogoData = currentCompany?.companyLogoData || null;

            if (req.file) { // Новый лого
                companyUpdates.companyLogoData = req.file.buffer.toString('base64');
            } else if (req.body.removeLogo === '1') { // Удаление
                companyUpdates.companyLogoData = null;
            } else { // Оставляем старый
                companyUpdates.companyLogoData = currentLogoData;
            }
            // Убираем companyLogoData из updates, если он не изменился
            if (companyUpdates.companyLogoData === currentLogoData) {
                 delete companyUpdates.companyLogoData;
            }


            // Обновляем только если есть что обновлять
            if (Object.keys(companyUpdates).length > 0) {
                 await firebaseService.updateCompany(companyId, companyUpdates);
                 console.log(`[POST /company/edit] Company ${companyId} data updated.`);
                  // Обновляем имя компании в сессии пользователя
                 if (companyUpdates.companyName) {
                      req.session.user.companyName = companyUpdates.companyName;
                 }
                 // Обновляем лого в сессии, если оно изменилось
                 if (companyUpdates.companyLogoData !== undefined) {
                      req.session.user.companyLogoData = companyUpdates.companyLogoData;
                 }
                 req.session.message = { type: 'success', text: 'Данные компании обновлены.' };
            } else {
                 req.session.message = { type: 'info', text: 'Нет изменений для сохранения.' };
            }


            req.session.save(saveErr => res.redirect('/company/manage'));

        } catch (error) {
             console.error(`[POST /company/edit] Error for ${companyId}:`, error);
             req.session.message = { type: 'error', text: error.message || 'Ошибка сохранения.' };
             req.session.save(saveErr => res.redirect('/company/manage'));
        }
    });
});

// --- Маршруты Управления Персоналом ---

// POST /company/staff/add
// Доступно только владельцу (isOwnerSelf)
router.post('/staff/add', isLoggedIn, isOwnerSelf, async (req, res, next) => {
    const { staffUsername } = req.body;
    const companyId = req.session.user.companyId;
    if (!companyId) { return next(new Error("ID компании не найден.")); }
    if (!staffUsername?.trim()) { req.session.message = { type: 'error', text: 'Введите логин.' }; return req.session.save(err => res.redirect('/company/manage')); }
    const usernameToAdd = staffUsername.trim();

    if (usernameToAdd === req.session.user.username) { req.session.message = { type: 'error', text: 'Нельзя добавить себя.' }; return req.session.save(err => res.redirect('/company/manage')); }

    try {
        const userToAdd = await firebaseService.getUserByUsername(usernameToAdd);
        if (!userToAdd) { throw new Error(`Пользователь "${usernameToAdd}" не найден.`); }
        if (userToAdd.Role === 'Admin' || userToAdd.Role === 'Owner') { throw new Error('Нельзя добавить админа/владельца.'); }
        if (userToAdd.companyId && userToAdd.companyId !== companyId) { throw new Error(`Сотрудник другой компании.`); }
        if (userToAdd.companyId === companyId && userToAdd.Role === 'Staff') { throw new Error(`Уже ваш помощник.`); }

        await firebaseService.addStaffToCompany(companyId, usernameToAdd);
        req.session.message = { type: 'success', text: `Пользователь "${usernameToAdd}" добавлен.` };
        req.session.save(err => res.redirect('/company/manage'));

    } catch (error) {
        console.error("Error adding staff:", error);
        req.session.message = { type: 'error', text: error.message || 'Ошибка добавления.' };
        req.session.save(err => res.redirect('/company/manage'));
    }
});

// POST /company/staff/remove
// Доступно только владельцу (isOwnerSelf)
router.post('/staff/remove', isLoggedIn, isOwnerSelf, async (req, res, next) => {
    const { staffUsername } = req.body;
    const companyId = req.session.user.companyId;
    if (!companyId) { return next(new Error("ID компании не найден.")); }
    if (!staffUsername) { req.session.message = { type: 'error', text: 'Не указан пользователь.' }; return req.session.save(err => res.redirect('/company/manage')); }

    try {
         const userToRemove = await firebaseService.getUserByUsername(staffUsername);
         if (!userToRemove || userToRemove.companyId !== companyId || userToRemove.Role !== 'Staff') { throw new Error(`"${staffUsername}" не ваш помощник.`); }

        await firebaseService.removeStaffFromCompany(companyId, staffUsername);
        req.session.message = { type: 'success', text: `Пользователь "${staffUsername}" удален.` };
        req.session.save(err => res.redirect('/company/manage'));

    } catch (error) {
        console.error("Error removing staff:", error);
        req.session.message = { type: 'error', text: error.message || 'Ошибка удаления.' };
        req.session.save(err => res.redirect('/company/manage'));
    }
});

router.get('/balance-history', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => {
    // ID компании берется либо из query (для админа), либо из сессии пользователя
    const companyId = (req.session.user.role === 'Admin' && req.query.id) ? req.query.id : req.session.user.companyId;
    console.log(`[GET /company/balance-history] Request for companyId: ${companyId}`);

    if (!companyId) {
        req.session.message = { type: 'error', text: 'ID компании не определен.' };
        return req.session.save(err => res.redirect('/')); // Редирект на дашборд
    }

    try {
        const company = await firebaseService.getCompanyById(companyId);
        if (!company) {
            return res.status(404).render('error', { title: 'Ошибка', message: `Компания с ID ${companyId} не найдена.` });
        }

        // Получаем историю баланса
        let history = [];
        if (company.balanceHistory && typeof company.balanceHistory === 'object') {
            history = Object.values(company.balanceHistory) // Просто берем значения
                          .filter(op => op && op.Date && op.Amount !== undefined); // Фильтруем некорректные
        }

        // Форматируем для отображения
        const formattedHistory = history.map(op => ({
            ...op,
            DateFormatted: new Date(op.Date).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }),
            AmountFormatted: new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', signDisplay: 'always' }).format(op.Amount || 0),
             NewBalanceFormatted: op.NewBalance !== undefined ? new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(op.NewBalance) : '?'
        })).sort((a, b) => new Date(b.Date) - new Date(a.Date)); // Сортируем: новые сверху

        res.render('company-balance-history', { // <<<=== НОВЫЙ ШАБЛОН
            title: `История баланса: ${company.companyName}`,
            companyName: company.companyName,
            companyId: companyId, // Передаем для возможных ссылок
            history: formattedHistory
        });

    } catch (error) {
        console.error(`[GET /company/balance-history] Error for ${companyId}:`, error);
        next(error);
    }
});

module.exports = router;