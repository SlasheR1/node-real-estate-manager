// routes/authRoutes.js
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const firebaseService = require('../services/firebaseService');
const { isLoggedIn, isLoggedOut } = require('../middleware/authMiddleware');
const multer = require('multer');
const admin = require('firebase-admin');
const log = require('electron-log'); // Добавим логирование

// --- Настройка Multer ---
const uploadAvatar = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB лимит
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) { cb(null, true); }
        else { cb(new Error('Разрешены только файлы изображений!'), false); }
    }
}).single('profileAvatar'); // Имя поля в форме для аватара

const db = admin.database();

const router = express.Router();

// =======================================
// === GET МАРШРУТЫ (Отображение страниц) ===
// =======================================

// GET /login - Страница входа
router.get('/login', isLoggedOut, (req, res) => {
    log.info('[GET /login] Rendering login page.');
    // Сообщение берется из res.locals middleware'ом в server.js
    res.render('login', { title: 'Вход' /* message уже в res.locals */ });
});

// GET /register - Страница регистрации
router.get('/register', isLoggedOut, (req, res) => {
    log.info('[GET /register] Rendering registration page.');
    res.render('register', { title: 'Регистрация' });
});

// GET /profile - Страница профиля (Пересмотренная версия)
router.get('/profile', isLoggedIn, async (req, res, next) => {
    // Пользователь и его актуальные данные УЖЕ должны быть в req.session.user
    // (и в res.locals.currentUser) благодаря middleware в server.js.
    // Мы можем просто использовать их.

    // --- ПРОВЕРКА ---
    // Проверяем, что пользователь точно есть в сессии после middleware
    if (!req.session.user || !req.session.user.username) {
        log.error("[GET /profile - Revised] Сессия пользователя неполная или отсутствует после middleware. Перенаправление на /login.");
        // Уничтожаем сессию и перенаправляем, если что-то не так
        return req.session.destroy((err) => {
             if(err) log.error("[GET /profile - Revised] Ошибка при уничтожении сессии:", err);
             res.clearCookie('connect.sid');
             res.redirect('/login');
        });
    }
    // --- КОНЕЦ ПРОВЕРКИ ---

    const username = req.session.user.username;
    log.info(`[GET /profile - Revised] Рендеринг профиля для пользователя: ${username}, используя уже обновленные данные сессии.`);

    try {
        // --- НЕ НУЖНО снова загружать пользователя здесь ---
        // Данные уже актуальны в req.session.user благодаря middleware

        // Подготовка данных для рендеринга (аватар) из СЕССИИ
        let avatarSrc = '/images/placeholder-avatar.png'; // Путь к аватару по умолчанию
        // Используем данные из сессии, обновленные middleware
        if (req.session.user.imageData) {
            try {
                 // Простая проверка типа по началу base64 строки
                 let type = req.session.user.imageData.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
                 avatarSrc = `data:${type};base64,${req.session.user.imageData}`;
                 log.debug(`[GET /profile - Revised] Сгенерирован Data URI для аватара пользователя ${username}.`);
            } catch (e) {
                 log.error(`[GET /profile - Revised] Ошибка при создании Data URI для аватара пользователя ${username} из сессии:`, e);
                 // Если ошибка, останется аватар по умолчанию
            }
        } else {
            log.debug(`[GET /profile - Revised] У пользователя ${username} нет данных аватара в сессии. Используется плейсхолдер.`);
        }

        // Рендерим страницу профиля, передавая актуальные данные из СЕССИИ
        res.render('profile', {
            title: 'Мой профиль',
            // Передаем обновленные данные из СЕССИИ
            // Важно передать копию, чтобы случайно не изменить сессию в шаблоне (хотя EJS обычно этого не делает)
            user: {
                ...req.session.user, // Берем все актуальные поля из сессии (включая Role, Email, Phone, Balance и т.д.)
                DisplayAvatarSrc: avatarSrc // Добавляем подготовленный аватар
            },
            // message уже в res.locals из middleware (если был)
        });
        log.info(`[GET /profile - Revised] Страница профиля успешно отрендерена для ${username}.`);

    } catch (error) {
        // Ловим ошибки, не связанные с загрузкой пользователя (например, ошибки рендеринга EJS)
        log.error(`[GET /profile - Revised] Ошибка при рендеринге профиля для ${username}:`, error);
        // Передаем ошибку глобальному обработчику для отображения страницы ошибки 500
        next(error);
    }
});

// GET /profile/edit - Страница редактирования профиля
router.get('/profile/edit', isLoggedIn, async (req, res, next) => {
     if (!req.session.user || !req.session.user.username) { log.error("[GET /profile/edit] User session incomplete. Redirecting."); return res.redirect('/login'); }
    const username = req.session.user.username;
    log.info(`[Profile Edit GET] Accessing edit form for user: ${username}`);
    try {
        // Получаем актуальные данные для формы (из сессии, т.к. она обновляется)
        const user = req.session.user;
        // Готовим аватар для отображения в форме
        let avatarSrc = '/images/placeholder-avatar.png';
        if (user.imageData) {
            try {
                let type = user.imageData.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
                avatarSrc = `data:${type};base64,${user.imageData}`;
            } catch(e){
                 log.error(`[Profile Edit GET] Error creating avatar data URI for ${username}:`, e);
            }
        }

        res.render('profile-edit', {
            title: 'Редактировать профиль',
            // Передаем актуальные данные из сессии
            user: {
                Username: user.username, // Берем из сессии
                FullName: user.fullName,
                Email: user.email,
                Phone: user.phone,
                DisplayAvatarSrc: avatarSrc
            },
            // message уже в res.locals
        });
    } catch (error) {
        log.error(`[Profile Edit GET] Error preparing edit form for ${username}:`, error);
        next(error);
    }
});

// GET /profile/balance-history - История баланса (Только для Tenant)
router.get('/profile/balance-history', isLoggedIn, async (req, res, next) => {
    if (!req.session.user || !req.session.user.username) { log.error("[GET /balance-history] User session incomplete."); return res.redirect('/login'); }
    // --- ПРОВЕРКА РОЛИ ---
    if (req.session.user.role !== 'Tenant') {
        log.warn(`[Balance History GET] Access denied for non-tenant user: ${req.session.user.username} (Role: ${req.session.user.role})`);
        req.session.message = { type: 'warning', text: 'История баланса доступна только арендаторам.' };
        return req.session.save(err => {
            if(err) log.error("[Balance History GET] Session save error (role check):", err);
            res.redirect('/profile');
        });
    }
    // --- КОНЕЦ ПРОВЕРКИ РОЛИ ---
    const username = req.session.user.username;
    log.info(`[Balance History GET] Fetching history for tenant: ${username}`);
    try {
        // Получаем пользователя из БД, т.к. история может быть длинной и не хранится в сессии
        const user = await firebaseService.getUserByUsername(username);
        if (!user) {
             log.error(`[Balance History GET] Tenant user ${username} not found in DB.`);
             return req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect('/login'); });
        }

        // Обработка истории баланса
        let history = [];
        if (user.BalanceHistory && typeof user.BalanceHistory === 'object') {
             history = Object.entries(user.BalanceHistory)
                           .map(([firebaseKey, operationData]) => ({
                               ...operationData,
                               FBId: firebaseKey
                           }))
                           .filter(op => op && op.Date && op.Amount !== undefined);
        } else {
             log.info(`[Balance History GET] No balance history found for user ${username}.`);
        }

        // Форматирование и сортировка
        const formattedHistory = history.map(op => ({
                ...op,
                DateFormatted: new Date(op.Date).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }),
                AmountFormatted: new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', signDisplay: 'always' }).format(op.Amount || 0),
                NewBalanceFormatted: typeof op.NewBalance === 'number'
                    ? new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(op.NewBalance)
                    : '?'
            })).sort((a, b) => new Date(b.Date) - new Date(a.Date));

        // Рендеринг
        res.render('balance-history', {
             title: 'История баланса',
             history: formattedHistory
             // message уже в res.locals
        });
    } catch (error) {
        log.error(`[Balance History GET] Error fetching balance history for ${username}:`, error);
        next(error);
    }
});

// GET /change-password - Форма принудительной смены пароля
router.get('/change-password', mustChangePasswordCheck, (req, res) => {
    const username = req.session.tempUser.username;
    log.info(`[Change Password GET] Rendering form for user: ${username}`);
    res.render('change-password', {
         title: 'Смена пароля',
         username: username,
         // message уже в res.locals
    });
});

// =======================================
// === POST МАРШРУТЫ (Обработка данных) ===
// =======================================

// POST /register - Регистрация пользователя (AJAX)
router.post('/register', async (req, res, next) => {
    const { username, password, fullName, email, phone } = req.body;
    const usernameKey = username?.trim();
    log.info(`[Register POST v6.1] Attempting registration for username: ${usernameKey}`);
    try {
        // Валидация
        if (!usernameKey || !password || !fullName || !phone) {
            throw new Error('Необходимо заполнить поля: Логин, Пароль, ФИО, Телефон.');
        }
        if (password.length < 6) {
            throw new Error('Пароль должен содержать не менее 6 символов.');
        }
        if (await firebaseService.getUserByUsername(usernameKey)) {
            throw new Error(`Логин '${usernameKey}' уже используется. Пожалуйста, выберите другой.`);
        }

        // Хеширование пароля
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // Создание объекта пользователя
        const newUser = {
            Username: usernameKey,
            PasswordHash: passwordHash,
            FullName: fullName,
            Email: email || '',
            Phone: phone,
            Role: 'Tenant',
            Balance: 0,
            BalanceHistory: {},
            ImageData: null,
            MustChangePassword: false,
            companyId: null,
            companyProfileCompleted: false
        };
        if (newUser.Role !== 'Tenant') { delete newUser.Balance; delete newUser.BalanceHistory; }

        // Сохранение пользователя
        await firebaseService.saveUser({ ...newUser, username: usernameKey }); // Передаем username как ключ
        log.info(`[Register POST v6.1] User ${usernameKey} registered successfully as Tenant.`);

        // Установка сообщения и ответ
        req.session.message = { type: 'success', text: 'Регистрация прошла успешно! Теперь вы можете войти.' };
        req.session.save(err => {
            if(err) { log.error("[Register POST v6.1] Session save error:", err); }
            else { log.info("[Register POST v6.1] Session saved with success message."); }
            // Отвечаем успехом в любом случае, если пользователь создан
            res.status(200).json({ success: true, redirectUrl: '/login' });
        });
    } catch (error) {
         log.error("[Register POST v6.1] Error during registration:", error);
         res.status(400).json({ success: false, error: error.message || 'Произошла ошибка при регистрации.' });
    }
});

// POST /login - Вход пользователя (AJAX)
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const usernameKey = username?.trim();
    log.info(`[Login POST v6.1] Attempting login for user: ${usernameKey}`);

    try {
        // Валидация
        if (!usernameKey || !password) { throw new Error('Пожалуйста, введите логин и пароль.'); }

        // Получение пользователя
        const user = await firebaseService.getUserByUsername(usernameKey);
        if (!user || !user.PasswordHash) { log.warn(`[Login POST v6.1] User not found or password hash missing for: ${usernameKey}`); throw new Error('Неверный логин или пароль.'); }

        // Проверка пароля (Bcrypt + Fallback SHA256)
        let passwordMatch = false;
        let needsRehash = false;
        if (user.PasswordHash.startsWith('$2a$') || user.PasswordHash.startsWith('$2b$')) {
             try { passwordMatch = await bcrypt.compare(password, user.PasswordHash); }
             catch (compareError){ log.error("[Login POST v6.1] Bcrypt compare error:", compareError); throw new Error('Ошибка проверки пароля.'); }
        } else {
             log.info(`[Login POST v6.1] Detected potentially old hash format for ${usernameKey}. Attempting fallback check.`);
             try {
                  const hasher = crypto.createHash('sha256'); const hashedInputPassword = hasher.update(password, 'utf-8').digest('base64');
                  if(hashedInputPassword === user.PasswordHash) { passwordMatch = true; needsRehash = true; log.info(`[Login POST v6.1] Old hash matched for ${usernameKey}. Needs rehash.`); }
             } catch(hashError){ log.error("[Login POST v6.1] Fallback hash check error:", hashError); }
        }

        // Обработка результата
        if (passwordMatch) {
            log.info(`[Login POST v6.1] Password match successful for ${usernameKey}.`);

            // Рехеширование, если нужно
            if (needsRehash) {
                 try { const newHash = await bcrypt.hash(password, 10); await db.ref(`users/${usernameKey}/PasswordHash`).set(newHash); user.PasswordHash = newHash; log.info(`[Login POST v6.1] Password successfully rehashed for ${usernameKey}.`); }
                 catch (rehashError) { log.error(`[Login POST v6.1] Failed to rehash password for ${usernameKey}:`, rehashError); }
            }

            // Проверка принудительной смены пароля
            if (user.MustChangePassword === true) {
                log.info(`[Login POST v6.1] User ${usernameKey} must change password. Redirecting to /change-password.`);
                req.session.tempUser = { username: user.Username };
                return req.session.save(err => {
                     if (err) log.error("[Login POST v6.1] Session save error (force change):", err);
                     res.status(200).json({ success: true, forceChange: true, redirectUrl: '/change-password' });
                });
            } else {
                // Стандартный вход с регенерацией сессии
                req.session.regenerate(async (err) => {
                    if (err) { log.error("[Login POST v6.1] Session regeneration error:", err); return res.status(500).json({ success: false, error: 'Ошибка сессии при входе.' }); }
                    log.info(`[Login POST v6.1] Session regenerated for ${usernameKey}. Populating session data.`);

                    // Формирование объекта сессии
                    const sessionUser = {
                        username: user.Username, fullName: user.FullName, role: user.Role,
                        email: user.Email, phone: user.Phone, imageData: user.ImageData || null,
                        companyId: user.companyId || null, companyProfileCompleted: user.companyProfileCompleted === true,
                        companyName: null // Будет загружено ниже
                    };
                    if(user.Role === 'Tenant'){ sessionUser.balance = user.Balance ?? 0; }

                    // Загрузка имени компании
                    if (sessionUser.companyId) {
                         try { const company = await firebaseService.getCompanyById(sessionUser.companyId); sessionUser.companyName = company?.companyName || null; }
                         catch (companyError) { log.warn(`[Login POST v6.1] Failed to fetch company name for ${sessionUser.companyId}:`, companyError); sessionUser.companyName = null; }
                    }

                    // Сохранение в сессию
                    req.session.user = sessionUser;
                    log.info("[Login POST v6.1] Session user object created:", req.session.user);

                    // Сохранение и ответ
                    req.session.save(saveErr => {
                         if (saveErr) { log.error("[Login POST v6.1] Session save error after population:", saveErr); return res.status(500).json({ success: false, error: 'Ошибка сохранения сессии.' }); }
                         log.info(`[Login POST v6.1] Login successful for ${usernameKey}. Redirecting to /.`);
                         res.status(200).json({ success: true, redirectUrl: '/' });
                    });
                });
            }
        } else { // Пароль не совпал
            log.warn(`[Login POST v6.1] Password mismatch for user: ${usernameKey}.`);
            throw new Error('Неверный логин или пароль.');
        }
    } catch (error) {
        log.error("[Login POST v6.1] Error during login process:", error);
        res.status(400).json({ success: false, error: error.message || 'Произошла ошибка при входе.' });
    }
});

// POST /change-password - Обработка принудительной смены пароля
router.post('/change-password', mustChangePasswordCheck, async (req, res) => {
    const { newPassword, confirmPassword } = req.body;
    const username = req.session.tempUser.username;
    log.info(`[Change Password POST v6.1] Attempting to change password for user: ${username}`);
    try {
        // Валидация
        if (!newPassword || !confirmPassword) { throw new Error('Необходимо ввести и подтвердить новый пароль.'); }
        if (newPassword !== confirmPassword) { throw new Error('Введенные пароли не совпадают.'); }
        if (newPassword.length < 6) { throw new Error('Новый пароль должен содержать не менее 6 символов.'); }

        // Хеширование
        const newPasswordHash = await bcrypt.hash(newPassword, 10);
        // Обновление
        const updates = { PasswordHash: newPasswordHash, MustChangePassword: null };
        await db.ref(`users/${username}`).update(updates);
        log.info(`[Change Password POST v6.1] Password updated successfully for ${username}. Flag 'MustChangePassword' removed.`);

        // Очистка временной сессии
        delete req.session.tempUser;

        // Сообщение и редирект
        req.session.message = { type: 'success', text: 'Пароль успешно изменен! Теперь вы можете войти с новым паролем.' };
        req.session.save(err => {
             if (err) { log.error(`[Change Password POST v6.1] Session save error:`, err); }
             log.info(`[Change Password POST v6.1] Redirecting user ${username} to login page.`);
             res.redirect('/login');
        });
    } catch (error) {
        log.error(`[Change Password POST v6.1] Error changing password for ${username}:`, error);
        req.session.message = { type: 'error', text: error.message || 'Произошла ошибка при смене пароля.' };
        req.session.save(saveErr => {
             if (saveErr) log.error(`[Change Password POST v6.1] Session save error (catch):`, saveErr);
             res.redirect('/change-password');
        });
    }
});

// POST /logout - Выход пользователя
router.post('/logout', (req, res) => {
    const username = req.session?.user?.username || req.session?.tempUser?.username || 'Guest';
    log.info(`[Logout POST v6.1] Initiating logout for user: ${username}`);

    req.session.destroy(err => {
        res.clearCookie('connect.sid');
        if (err) { log.error("[Logout POST v6.1] Error destroying session:", err); }
        else { log.info(`[Logout POST v6.1] Session destroyed successfully for ${username}. Redirecting to /login.`); }
        res.redirect('/login');
    });
});

// POST /profile/add-funds - Пополнение баланса (AJAX - Только для Tenant)
router.post('/profile/add-funds', isLoggedIn, async (req, res) => {
    if (!req.session.user?.username) { log.warn("[Add Funds POST v6.1] Unauthorized: No user in session."); return res.status(401).json({ error: 'Доступ запрещен. Сессия не найдена.' }); }
    if (req.session.user.role !== 'Tenant') { log.warn(`[Add Funds POST v6.1] Forbidden: User ${req.session.user.username} is not Tenant.`); return res.status(403).json({ error: 'Действие доступно только арендаторам.' }); }

    const username = req.session.user.username;
    const io = req.app.get('socketio'); // Получаем io
    const targetUserRoom = `user:${username}`; // Определяем комнату
    log.info(`[Add Funds POST v6.1] Attempting to add funds for Tenant: ${username}`);

    try {
        const userRef = db.ref(`users/${username}`);
        const amountToAdd = 1000;

        const transactionResult = await userRef.transaction(currentUserData => {
            if (currentUserData === null) { log.error(`[Add Funds TX v6.1] User ${username} node is null.`); return undefined; }
            if (currentUserData.Role !== 'Tenant') { log.warn(`[Add Funds TX v6.1] User ${username} is not Tenant.`); return undefined; }
            const currentBalance = currentUserData.Balance || 0;
            const newBalance = parseFloat((currentBalance + amountToAdd).toFixed(2));
            currentUserData.Balance = newBalance;
            if (!currentUserData.BalanceHistory) { currentUserData.BalanceHistory = {}; }
            const historyKey = userRef.child('BalanceHistory').push().key;
            if(!historyKey) { log.error(`[Add Funds TX v6.1] Failed to generate history key!`); return undefined; }
            currentUserData.BalanceHistory[historyKey] = { Id: historyKey, Date: new Date().toISOString(), Amount: amountToAdd, OperationType: "Пополнение", Description: "Тестовое пополнение баланса", NewBalance: newBalance };
            return currentUserData;
        });

        if (!transactionResult.committed || !transactionResult.snapshot.exists()) { log.error(`[Add Funds POST v6.1] Transaction failed or user ${username} not exist.`); throw new Error("Не удалось обновить баланс."); }

        const finalBalance = transactionResult.snapshot.val().Balance;

        // Обновляем баланс в СЕССИИ
        req.session.user.balance = finalBalance;
        log.info(`[Add Funds POST v6.1] User ${username} balance updated to ${finalBalance}. Session updated.`);

        // Оповещение клиента через Socket.IO В КОМНАТУ
        log.info(`[Add Funds POST v6.1] Emitting 'balance_updated' event to room ${targetUserRoom}.`);
        io.to(targetUserRoom).emit('balance_updated', finalBalance);

        // Сохраняем сессию и отвечаем
        req.session.save(err => {
            if (err) { log.error(`[Add Funds POST v6.1] Session save error:`, err); return res.status(200).json({ message: 'Баланс пополнен (ошибка сессии)', newBalance: finalBalance }); }
            log.info(`[Add Funds POST v6.1] Successfully added funds for ${username}.`);
            res.status(200).json({ message: 'Баланс успешно пополнен!', newBalance: finalBalance });
        });

    } catch (error) {
         log.error(`[Add Funds POST v6.1] Error processing funds addition for ${username}:`, error);
         res.status(500).json({ error: error.message || 'Ошибка сервера при пополнении баланса.' });
     }
});

// POST /profile/edit - Редактирование профиля (только свои данные)
router.post('/profile/edit', isLoggedIn, async (req, res, next) => {
    if (!req.session.user?.username) { log.warn("[Profile Edit POST v6.1] Unauthorized: No user in session."); return res.redirect('/login'); }
    const username = req.session.user.username;
    const { fullName, email, phone, currentPassword, newPassword } = req.body;
    const io = req.app.get('socketio'); // Получаем io
    const targetUserRoom = `user:${username}`; // Определяем комнату
    log.info(`[Profile Edit POST v6.1] Attempting profile update for user: ${username}`);

    try {
        // Валидация
        if (!fullName?.trim() || !phone?.trim()) { throw new Error('Поля ФИО и Телефон обязательны.'); }

        // Получаем текущие данные для проверки пароля
        const currentUserData = await firebaseService.getUserByUsername(username);
        if (!currentUserData) { log.error(`[Profile Edit POST v6.1] User ${username} not found!`); throw new Error('Не удалось найти данные пользователя.'); }

        // Подготовка обновлений
        const updates = { FullName: fullName.trim(), Email: email || '', Phone: phone.trim() };

        // Обработка смены пароля
        if (newPassword && newPassword.trim()) {
             log.info(`[Profile Edit POST v6.1] Password change requested for ${username}.`);
             if (!currentPassword) { throw new Error('Для смены пароля введите текущий пароль.'); }
             if (newPassword.length < 6) { throw new Error('Новый пароль < 6 символов.'); }
             let match = false;
             if (currentUserData.PasswordHash?.startsWith('$2')) { match = await bcrypt.compare(currentPassword, currentUserData.PasswordHash); }
             else { log.warn(`[Profile Edit POST v6.1] Old hash format detected for ${username}.`); }
             if (!match) { throw new Error('Введенный текущий пароль неверен.'); }
             updates.PasswordHash = await bcrypt.hash(newPassword, 10);
             log.info(`[Profile Edit POST v6.1] New password hash generated for ${username}.`);
        }

        // Обновление в Firebase
        await db.ref(`users/${username}`).update(updates);
        log.info(`[Profile Edit POST v6.1] Profile data updated in Firebase for ${username}.`);

        // Обновление СЕССИИ
        req.session.user.fullName = updates.FullName;
        req.session.user.email = updates.Email;
        req.session.user.phone = updates.Phone;
        log.info(`[Profile Edit POST v6.1] Session data updated for ${username}.`);

        // Оповещение клиента через Socket.IO В КОМНАТУ
        const profileUpdateData = {
             fullName: updates.FullName,
             // Передаем остальные данные из обновленной сессии
             role: req.session.user.role,
             companyName: req.session.user.companyName,
             companyId: req.session.user.companyId,
             companyProfileCompleted: req.session.user.companyProfileCompleted,
             email: updates.Email,
             phone: updates.Phone
        };
        io.to(targetUserRoom).emit('profile_data_updated', profileUpdateData);
        log.info(`[Profile Edit POST v6.1] Emitted 'profile_data_updated' event to room ${targetUserRoom}.`);

        // Сообщение, сохранение сессии, редирект
        req.session.message = { type: 'success', text: 'Профиль успешно обновлен!' };
        req.session.save(err => {
             if (err) log.error(`[Profile Edit POST v6.1] Session save error:`, err);
             res.redirect('/profile');
        });

    } catch (error) {
        log.error(`[Profile Edit POST v6.1] Error updating profile for ${username}:`, error);
        req.session.message = { type: 'error', text: error.message || 'Ошибка обновления профиля.' };
        req.session.save(err => {
             if (err) log.error(`[Profile Edit POST v6.1] Session save error (catch):`, err);
             res.redirect('/profile/edit');
        });
    }
});

// POST /profile/avatar - Загрузка аватара (только своего)
router.post('/profile/avatar', isLoggedIn, (req, res, next) => {
    if (!req.session.user?.username) { log.error("[POST /profile/avatar v6.1] No user in session."); return res.redirect('/login'); }
    const username = req.session.user.username;
    const io = req.app.get('socketio'); // Получаем io
    const targetUserRoom = `user:${username}`; // Определяем комнату
    log.info(`[Avatar Upload POST v6.1] Attempting avatar upload for user: ${username}`);

    uploadAvatar(req, res, async (err) => {
         log.info(`[Avatar Upload POST v6.1] Multer processing finished for ${username}.`);
         try {
             if (err) { log.error(`[Avatar Upload POST v6.1] Multer error:`, err.message); throw err; }
             if (!req.file) { log.warn(`[Avatar Upload POST v6.1] No file uploaded.`); throw new Error('Файл изображения не был выбран.'); }

             log.info(`[Avatar Upload POST v6.1] File received: ${req.file.originalname}, Size: ${req.file.size}, Mime: ${req.file.mimetype}`);
             const newImageData = req.file.buffer.toString('base64');
             const base64Limit = 2 * 1024 * 1024 * 1.4;
             if (newImageData.length > base64Limit) { log.error(`[Avatar Upload POST v6.1] Base64 too large: ${newImageData.length}`); throw new Error("Файл слишком большой."); }
             log.info(`[Avatar Upload POST v6.1] Image converted. Base64 Length: ${newImageData.length}`);

             // Обновление в Firebase
             await db.ref(`users/${username}`).update({ ImageData: newImageData });
             log.info(`[Avatar Upload POST v6.1] Firebase updated for ${username}.`);

             // Обновление СЕССИИ
             req.session.user.imageData = newImageData;
             log.info(`[Avatar Upload POST v6.1] Session updated for ${username}.`);

             // Оповещение клиента через Socket.IO В КОМНАТУ
             io.to(targetUserRoom).emit('avatar_updated');
             log.info(`[Avatar Upload POST v6.1] Emitted 'avatar_updated' event to room ${targetUserRoom}.`);

             // Сообщение, сохранение сессии, редирект
             req.session.message = { type: 'success', text: 'Аватар успешно обновлен.' };
             req.session.save(saveErr => {
                  if (saveErr) log.error(`[Avatar Upload POST v6.1] Session save error:`, saveErr);
                  res.redirect('/profile/edit');
             });
         } catch (error) {
              log.error(`[Avatar Upload POST ERROR v6.1] for ${username}:`, error);
              req.session.message = { type: 'error', text: error.message || 'Не удалось загрузить изображение.' };
              req.session.save(saveErr => {
                   if (saveErr) log.error(`[Avatar Upload POST v6.1] Session save error (catch):`, saveErr);
                   res.redirect('/profile/edit');
              });
         }
    });
});


// Middleware для проверки временной сессии при смене пароля
function mustChangePasswordCheck(req, res, next) {
    if (req.session?.tempUser?.username) {
        return next();
    }
    log.warn("[Change PW Check v6.1] Failed: No tempUser session found. Redirecting to login.");
    res.redirect('/login');
}

module.exports = router; // Экспорт роутера