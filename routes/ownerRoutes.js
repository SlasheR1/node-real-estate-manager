// routes/ownerRoutes.js
const express = require('express');
const multer = require('multer');
const firebaseService = require('../services/firebaseService');
const { isLoggedIn } = require('../middleware/authMiddleware'); // Нужен только isLoggedIn
const admin = require('firebase-admin');
const db = admin.database(); // Получаем доступ к базе данных для обновлений

const router = express.Router();

// Middleware: Проверка, что пользователь Owner
// (Оставляем как есть, он корректно проверяет роль)
function isOwner(req, res, next) {
    if (req.session.user && req.session.user.role === 'Owner') {
        return next();
    }
    req.session.message = { type: 'error', text: 'Доступ запрещен.' };
    res.redirect('/');
}

// Настройка Multer для логотипа
// (Оставляем как есть, он корректно настроен)
const uploadLogo = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1 * 1024 * 1024 }, // 1MB лимит для лого
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) { cb(null, true); }
        else { cb(new Error('Разрешены только файлы изображений!'), false); }
    }
}).single('companyLogo'); // Имя поля в форме <input type="file" name="companyLogo">

// GET /owner/setup - Показать страницу настройки
// (Оставляем как есть, логика проверки и рендеринга корректна)
router.get('/owner/setup', isLoggedIn, isOwner, async (req, res, next) => { // Добавляем next для обработки ошибок
    try {
        const user = await firebaseService.getUserByUsername(req.session.user.username);
        const message = req.session.message || null;
        if (req.session.message) delete req.session.message;

        // Если профиль уже заполнен (проверяем по данным из БД), редирект на дашборд
        if (user && user.companyProfileCompleted) {
             console.log(`[Owner Setup GET] Profile already completed for ${user.Username}. Redirecting to /`);
             // Обновим сессию на случай, если она устарела
             req.session.user.companyProfileCompleted = true;
             req.session.user.companyName = user.companyName || req.session.user.companyName; // Обновляем имя, если есть в БД
             return req.session.save(err => { // Сохраняем сессию перед редиректом
                 if (err) console.error("Session save error on redirect from owner setup:", err);
                 res.redirect('/');
             });
        }

        res.render('owner-setup', {
            title: 'Настройка профиля компании',
            user: user || {}, // Передаем пользователя (или пустой объект, если не найден)
            message: message
        });
    } catch (error) {
        console.error("Error getting owner setup page:", error);
        // Передаем ошибку глобальному обработчику
        error.message = 'Ошибка загрузки страницы настройки профиля компании.';
        next(error);
        // Старый вариант:
        // req.session.message = { type: 'error', text: 'Ошибка загрузки страницы настройки.' };
        // res.redirect('/');
    }
});

// POST /owner/setup - Обработать настройку профиля
// (Оставляем как есть, логика обработки формы, Multer, обновления БД и сессии корректна)
router.post('/owner/setup', isLoggedIn, isOwner, (req, res, next) => { // Добавляем next
    uploadLogo(req, res, async (err) => {
        const username = req.session.user.username;
        console.log(`[Owner Setup POST] Attempt by ${username}`);

        // Обработка ошибки Multer
        if (err) {
            console.error("[Owner Setup POST] Multer error:", err);
            // Устанавливаем сообщение об ошибке Multer во флеш-сообщение
            req.session.message = { type: 'error', text: err.message || 'Ошибка загрузки логотипа.' };
            // Сохраняем сессию и делаем редирект обратно
            return req.session.save(saveErr => {
                if (saveErr) console.error("[Owner Setup POST] Session save error (Multer):", saveErr);
                res.redirect('/owner/setup');
            });
        }

        const { companyName, companyContactEmail, companyContactPhone, companyWebsite } = req.body;

        try {
            // Валидация: Название компании обязательно
            if (!companyName || !companyName.trim()) {
                throw new Error('Название компании обязательно для заполнения.');
            }

            const updates = {
                companyName: companyName.trim(),
                companyContactEmail: companyContactEmail || null,
                companyContactPhone: companyContactPhone || null,
                companyWebsite: companyWebsite || null,
                companyProfileCompleted: true // Отмечаем профиль как заполненный
            };

            // Обработка логотипа
            let currentLogoData = null;
            try { // Загружаем текущие данные, чтобы не потерять лого, если новое не загружено
                const currentUserData = await firebaseService.getUserByUsername(username);
                if (currentUserData && currentUserData.companyLogoData) {
                    currentLogoData = currentUserData.companyLogoData;
                }
            } catch (fetchError) {
                console.warn(`[Owner Setup POST] Could not fetch current user data for logo check:`, fetchError);
                // Не критично, продолжим без старого лого
            }

            if (req.file) { // Если загружен новый логотип
                console.log(`[Owner Setup POST] New logo uploaded for ${username}. Size: ${req.file.buffer.length}`);
                updates.companyLogoData = req.file.buffer.toString('base64');
            } else { // Если новый логотип не загружен, используем старый (если он был)
                updates.companyLogoData = currentLogoData; // будет null, если старого не было
            }

            // Обновляем данные пользователя в Firebase
            await db.ref(`users/${username}`).update(updates); // Используем db.ref() напрямую для атомарного update
            console.log(`[Owner Setup POST] Company profile updated for ${username}`);

            // Обновляем данные в текущей сессии
            req.session.user.companyName = updates.companyName;
            req.session.user.companyProfileCompleted = true;
            // Обновляем лого в сессии только если оно изменилось или было добавлено
            if (req.file || updates.companyLogoData !== undefined) { // Проверяем, было ли поле в updates
                req.session.user.companyLogoData = updates.companyLogoData;
            }

            // Сохраняем сессию и делаем редирект на дашборд
            req.session.save(saveErr => {
                 if(saveErr) {
                     console.error("[Owner Setup POST] Session save error:", saveErr);
                     // Даже если сессию не удалось сохранить, редирект все равно нужен
                     // Можно добавить сообщение об ошибке сессии, но редирект важнее
                     req.flash('error', 'Профиль сохранен, но произошла ошибка сессии.'); // Пример с flash (если используется)
                     return res.redirect('/');
                 }
                 req.session.message = { type: 'success', text: 'Профиль компании успешно настроен!' };
                 res.redirect('/'); // Редирект на дашборд после успешной настройки
            });

        } catch (error) { // Ловим ошибки валидации или сохранения в БД
            console.error(`[Owner Setup POST] Error updating profile for ${username}:`, error);
            req.session.message = { type: 'error', text: error.message || 'Ошибка сохранения профиля компании.' };
            // Сохраняем сессию с ошибкой и редирект обратно
            req.session.save(saveErr => {
                 if(saveErr) console.error("[Owner Setup POST] Session save error (Catch):", saveErr);
                 res.redirect('/owner/setup');
            });
        }
    });
});

module.exports = router;