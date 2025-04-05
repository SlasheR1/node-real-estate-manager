// routes/authRoutes.js
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const firebaseService = require('../services/firebaseService');
const { isLoggedIn, isLoggedOut } = require('../middleware/authMiddleware');
const multer = require('multer');
const admin = require('firebase-admin');

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
    const message = req.session.message || null;
    if (req.session.message) delete req.session.message;
    res.render('login', { title: 'Вход', message: message });
});

// GET /register - Страница регистрации
router.get('/register', isLoggedOut, (req, res) => {
    res.render('register', { title: 'Регистрация' });
});

// GET /profile - Страница профиля
router.get('/profile', isLoggedIn, async (req, res, next) => {
    // Проверяем, есть ли пользователь в сессии
    if (!req.session.user || !req.session.user.username) {
        console.error("[Profile GET] User session incomplete. Redirecting to login.");
        // Не используем redirect('/logout'), чтобы избежать лишних запросов,
        // просто уничтожаем сессию и отправляем на логин
        return req.session.destroy((err) => {
            res.clearCookie('connect.sid');
            res.redirect('/login');
        });
    }
    const username = req.session.user.username;
    try {
        // Получаем АКТУАЛЬНЫЕ данные пользователя из Firebase
        const user = await firebaseService.getUserByUsername(username);
        if (!user) {
             // Если пользователь удален из БД, но сессия еще есть
             console.error(`[Profile GET] User ${username} not found in DB. Logging out.`);
             return req.session.destroy((err) => {
                res.clearCookie('connect.sid');
                res.redirect('/login');
             });
        }

        // --- ОБНОВЛЯЕМ СЕССИЮ АКТУАЛЬНЫМИ ДАННЫМИ ---
        // (Важно после изменений профиля админом или в другой вкладке)
        req.session.user = {
            username: user.Username,
            fullName: user.FullName,
            role: user.Role,
            email: user.Email,
            phone: user.Phone,
            imageData: user.ImageData || null,
            companyId: user.companyId || null, // Добавляем companyId
            companyProfileCompleted: user.companyProfileCompleted === true, // Добавляем флаг
            // Добавляем баланс ТОЛЬКО для Tenant
            ...(user.Role === 'Tenant' && { balance: user.Balance ?? 0 })
        };
        // --- КОНЕЦ ОБНОВЛЕНИЯ СЕССИИ ---

        // Подготовка данных для рендеринга
        let avatarSrc = '/images/placeholder-avatar.png';
        if (user.ImageData) { try { let type = user.ImageData.startsWith('/9j/') ? 'image/jpeg' : 'image/png'; avatarSrc = `data:${type};base64,${user.ImageData}`; } catch(e) {} }
        const message = req.session.message || null; if (req.session.message) delete req.session.message;

        // Рендерим страницу профиля
        res.render('profile', {
            title: 'Мой профиль',
            user: { ...user, DisplayAvatarSrc: avatarSrc }, // Передаем полные данные из БД в шаблон
            message: message
        });
    } catch (error) { console.error(`[Profile GET] Error for ${username}:`, error); next(error); }
});

// GET /profile/edit - Страница редактирования профиля
router.get('/profile/edit', isLoggedIn, async (req, res, next) => {
     if (!req.session.user || !req.session.user.username) { return res.redirect('/login'); } // Проверка сессии
    const username = req.session.user.username;
    try {
        const user = await firebaseService.getUserByUsername(username);
        if (!user) {
            console.error(`[Profile Edit GET] User ${username} not found. Logging out.`);
            return req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect('/login'); });
        }
        // Готовим аватар для отображения
        let avatarSrc = '/images/placeholder-avatar.png';
        if (user.ImageData) { try { let type = user.ImageData.startsWith('/9j/') ? 'image/jpeg' : 'image/png'; avatarSrc = `data:${type};base64,${user.ImageData}`; } catch(e){} }
        const message = req.session.message || null; if (req.session.message) delete req.session.message;

        res.render('profile-edit', {
            title: 'Редактировать профиль',
            user: { ...user, DisplayAvatarSrc: avatarSrc }, // Передаем данные из БД
            message: message
        });
    } catch (error) { console.error(`[Profile Edit GET] Error for ${username}:`, error); next(error); }
});

// GET /profile/balance-history - История баланса (Только для Tenant)
router.get('/profile/balance-history', isLoggedIn, async (req, res, next) => {
    if (!req.session.user || !req.session.user.username) { return res.redirect('/login'); }
    // --- ПРОВЕРКА РОЛИ ---
    if (req.session.user.role !== 'Tenant') {
        req.session.message = { type: 'warning', text: 'История баланса доступна только арендаторам.' };
        return res.redirect('/profile'); // Или на главную
    }
    // --- КОНЕЦ ПРОВЕРКИ РОЛИ ---
    const username = req.session.user.username;
    try {
        const user = await firebaseService.getUserByUsername(username);
        if (!user) { /* ... обработка ненайденного пользователя ... */ }

        // Обработка истории баланса (убедимся, что balanceHistory существует и это объект)
        let history = [];
        if (user.BalanceHistory && typeof user.BalanceHistory === 'object') {
             history = Object.entries(user.BalanceHistory)
                           .map(([id, opData]) => ({ ...opData, FBId: id })) // Добавляем ID записи
                           .filter(op => op && op.Date && op.Amount !== undefined); // Фильтруем некорректные записи
        }

        // Форматирование и сортировка
        const formattedHistory = history.map(op => ({
                ...op,
                DateFormatted: new Date(op.Date).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }),
                AmountFormatted: new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', signDisplay: 'always' }).format(op.Amount || 0)
            })).sort((a, b) => new Date(b.Date) - new Date(a.Date)); // Сортируем по дате (новейшие сверху)

        // Рендеринг шаблона balance-history.ejs (предполагается, что он существует)
        res.render('balance-history', { title: 'История баланса', history: formattedHistory });
    } catch (error) { console.error(`[Balance History GET] Error for ${username}:`, error); next(error); }
});

// GET /change-password - Форма принудительной смены пароля
router.get('/change-password', mustChangePasswordCheck, (req, res) => {
    const message = req.session.message || null; if (req.session.message) delete req.session.message;
    res.render('change-password', { title: 'Смена пароля', username: req.session.tempUser.username, message: message });
});

// =======================================
// === POST МАРШРУТЫ (Обработка данных) ===
// =======================================

// POST /register - Регистрация пользователя (AJAX)
router.post('/register', async (req, res, next) => {
    const { username, password, fullName, email, phone } = req.body;
    const usernameKey = username?.trim(); // Обрезаем пробелы
    console.log(`[Register POST] Attempt for: ${usernameKey}`);
    try {
        // Валидация
        if (!usernameKey || !password || !fullName || !phone) { throw new Error('Заполните Логин, Пароль, ФИО, Телефон.'); }
        if (password.length < 6) { throw new Error('Пароль < 6 символов.'); }
        if (await firebaseService.getUserByUsername(usernameKey)) { throw new Error('Логин занят!'); }

        // Хеширование пароля и создание пользователя
        const saltRounds = 10; const passwordHash = await bcrypt.hash(password, saltRounds);
        // По умолчанию регистрируем как Tenant, без companyId
        const newUser = {
            Username: usernameKey, PasswordHash: passwordHash, FullName: fullName,
            Email: email || '', Phone: phone, Role: 'Tenant', // Роль по умолчанию
            Balance: 0, BalanceHistory: {}, // Начальный баланс и история только для Tenant
            ImageData: null, MustChangePassword: false, companyId: null, companyProfileCompleted: false // Поля компании
        };
        // Удаляем Balance/History если роль не Tenant (хотя здесь всегда Tenant)
        if (newUser.Role !== 'Tenant') { delete newUser.Balance; delete newUser.BalanceHistory; }

        await firebaseService.saveUser({ ...newUser, username: usernameKey }); // Передаем username для ключа
        console.log(`[Register POST] User ${usernameKey} registered as Tenant.`);
        req.session.message = { type: 'success', text: 'Регистрация успешна! Войдите.' };
        req.session.save(err => { // Сохраняем сессию с сообщением
            if(err) console.error("[Register POST] Session save error:", err);
            res.status(200).json({ success: true, redirectUrl: '/login' });
        });
    } catch (error) {
         console.error("[Register POST] Error:", error);
         // Отправляем ошибку клиенту
         res.status(400).json({ success: false, error: error.message || 'Ошибка регистрации.' });
    }
});

// POST /login - Вход пользователя (AJAX - **ОБНОВЛЕНО для companyId**)
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const usernameKey = username?.trim();
    console.log(`[Login POST] Attempt for: ${usernameKey}`);
    try {
        if (!usernameKey || !password) { throw new Error('Введите логин и пароль'); }
        const user = await firebaseService.getUserByUsername(usernameKey);
        if (!user || !user.PasswordHash) { throw new Error('Неверный логин или пароль.'); }

        // Проверка пароля (Bcrypt или старый SHA256)
        let passwordMatch = false; let needsRehash = false;
        if (user.PasswordHash.startsWith('$2a$') || user.PasswordHash.startsWith('$2b$')) {
             try { passwordMatch = await bcrypt.compare(password, user.PasswordHash); } catch (e){ console.error("Bcrypt compare error:", e); throw new Error('Ошибка проверки пароля.'); }
        } else { // Fallback для старых хешей (если были)
            try { const h = crypto.createHash('sha256'); const b = h.update(password,'utf-8').digest(); if(b.toString('base64') === user.PasswordHash) { passwordMatch = true; needsRehash = true; console.log(`Needs rehash for ${usernameKey}`); } } catch(e){ console.error("SHA hash error:", e); }
        }

        if (passwordMatch) {
            console.log(`[Login POST] Password match for ${usernameKey}.`);
            // Рехеширование, если нужно
            if (needsRehash) { try { const salt = 10; const hash = await bcrypt.hash(password, salt); await db.ref(`users/${usernameKey}/PasswordHash`).set(hash); user.PasswordHash = hash; console.log(`Rehashed for ${usernameKey}`);} catch (rehashError) { console.error(`Rehash error:`, rehashError);} }

            // Проверка на принудительную смену пароля
            if (user.MustChangePassword === true) {
                console.log(`[Login POST] User ${usernameKey} must change password.`);
                req.session.tempUser = { username: user.Username }; // Сохраняем во временную сессию
                return res.status(200).json({ success: true, forceChange: true, redirectUrl: '/change-password' });
            } else {
                // Стандартный вход - регенерация сессии
                req.session.regenerate(async (err) => { // Добавляем async для загрузки companyName
                    if (err) { console.error("[Login POST] Session regeneration error:", err); return res.status(500).json({ success: false, error: 'Ошибка сессии.' }); }

                    // --- Формирование объекта сессии ---
                    const sessionUser = {
                        username: user.Username, fullName: user.FullName, role: user.Role,
                        email: user.Email, phone: user.Phone, imageData: user.ImageData || null,
                        companyId: user.companyId || null, // <<<=== ЭТА СТРОКА
                        companyProfileCompleted: user.companyProfileCompleted === true, // <<<=== И ЭТА
                        companyName: null // Будет загружено ниже
                    };
                    if(user.Role === 'Tenant'){ sessionUser.balance = user.Balance ?? 0; }

                    if (sessionUser.companyId) { // <<<=== ЗАГРУЗКА ИМЕНИ КОМПАНИИ
                         try {
                              const company = await firebaseService.getCompanyById(sessionUser.companyId);
                              sessionUser.companyName = company?.companyName || null;
                         } catch (companyError) { console.error(`[Login POST] Fail fetch company name:`, companyError); }
                    }

                    req.session.user = sessionUser;
                    console.log("[Login POST] Session user object:", req.session.user); // Проверяем лог

                    req.session.save(saveErr => { // Сохраняем сессию перед ответом
                         if (saveErr) console.error("[Login POST] Session save error:", saveErr);
                         res.status(200).json({ success: true, redirectUrl: '/' }); // Редирект на дашборд
                    });
                });
            }
        } else { // Пароль не совпал
            console.log(`[Login POST] Password mismatch for ${usernameKey}.`);
            throw new Error('Неверный логин или пароль.');
        }
    } catch (error) {
        console.error("[Login POST] Error:", error);
        res.status(400).json({ success: false, error: error.message || 'Ошибка входа.' });
    }
});

// POST /change-password - Обработка принудительной смены пароля
router.post('/change-password', mustChangePasswordCheck, async (req, res) => {
    const { newPassword, confirmPassword } = req.body;
    const username = req.session.tempUser.username;
    console.log(`[Change Password POST] Attempt for ${username}`);
    try {
        // Валидация
        if (!newPassword || !confirmPassword) { throw new Error('Введите и подтвердите пароль.'); }
        if (newPassword !== confirmPassword) { throw new Error('Пароли не совпадают.'); }
        if (newPassword.length < 6) { throw new Error('Пароль < 6 символов.'); }
        // Хеширование и обновление
        const saltRounds = 10; const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);
        const updates = { PasswordHash: newPasswordHash, MustChangePassword: null }; // Сбрасываем флаг
        await db.ref(`users/${username}`).update(updates);
        console.log(`[Change Password POST] Password updated for ${username}.`);
        // Очистка временной сессии и редирект
        delete req.session.tempUser;
        req.session.message = { type: 'success', text: 'Пароль изменен! Войдите снова.' };
        req.session.save(err => {
             if (err) console.error(`[Change Password POST] Session save error:`, err);
             res.redirect('/login');
        });
    } catch (error) {
        console.error(`[Change Password POST] Error for ${username}:`, error);
        req.session.message = { type: 'error', text: error.message || 'Ошибка смены пароля.' };
        req.session.save(saveErr => res.redirect('/change-password')); // Обратно на форму смены
    }
});


// POST /logout - Выход пользователя
router.post('/logout', (req, res) => {
    const username = req.session?.user?.username || req.session?.tempUser?.username || 'Guest';
    console.log(`[Logout POST] Logging out user: ${username}`);
    req.session.destroy(err => { // Уничтожаем сессию
        res.clearCookie('connect.sid'); // Чистим куки
        if (err) { console.error("[Logout POST] Error destroying session:", err); }
        console.log(`[Logout POST] Session destroyed for ${username}. Redirecting.`);
        res.redirect('/login'); // Редирект на страницу входа
    });
});

// POST /profile/add-funds - Пополнение баланса (AJAX - Только для Tenant)
router.post('/profile/add-funds', isLoggedIn, async (req, res) => {
    if (!req.session.user?.username) { return res.status(401).json({ error: 'Сессия не найдена.' }); }
    // Проверка роли
    if (req.session.user.role !== 'Tenant') { return res.status(403).json({ error: 'Доступно только арендаторам.' }); }
    const username = req.session.user.username;
    const io = req.app.get('socketio'); const userSockets = req.app.get('userSockets');
    console.log(`[Add Funds POST] Attempt for Tenant: ${username}`);
    try {
        const userRef = db.ref(`users/${username}`);
        // Используем транзакцию для обновления баланса
        const transactionResult = await userRef.transaction(currentUserData => {
            if (currentUserData === null) return undefined; // Пользователь не найден
            if (currentUserData.Role !== 'Tenant') return undefined; // Не арендатор

            const amountToAdd = 1000; // Сумма пополнения
            const currentBalance = currentUserData.Balance || 0;
            const newBalance = currentBalance + amountToAdd;
            currentUserData.Balance = newBalance;
            if (!currentUserData.BalanceHistory) currentUserData.BalanceHistory = {};
            const historyKey = userRef.child('BalanceHistory').push().key;
            currentUserData.BalanceHistory[historyKey] = { Id: historyKey, Date: new Date().toISOString(), Amount: amountToAdd, OperationType: "Пополнение", Description: "Тестовое пополнение", NewBalance: newBalance };
            return currentUserData;
        });

        if (!transactionResult.committed || !transactionResult.snapshot.exists()) {
             throw new Error("Не удалось обновить баланс пользователя.");
        }

        const newBalance = transactionResult.snapshot.val().Balance;
        req.session.user.balance = newBalance; // Обновляем баланс в сессии
        console.log(`[Add Funds POST] User ${username} balance updated to ${newBalance}.`);

        // Оповещение через Socket.IO
        const userSocketId = userSockets[username];
        if (userSocketId) { io.to(userSocketId).emit('balance_updated', newBalance); }

        req.session.save(err => { // Сохраняем сессию с обновленным балансом
            if (err) console.error(`[Add Funds POST] Session save error:`, err);
            res.status(200).json({ message: 'Баланс успешно пополнен', newBalance: newBalance });
        });
    } catch (error) {
         console.error(`[Add Funds POST] Error for ${username}:`, error);
         res.status(500).json({ error: error.message || 'Ошибка сервера.' });
     }
});

// POST /profile/edit - Редактирование профиля (только свои данные)
router.post('/profile/edit', isLoggedIn, async (req, res, next) => {
    if (!req.session.user?.username) { return res.redirect('/login'); } // Проверка сессии
    const username = req.session.user.username;
    const { fullName, email, phone, currentPassword, newPassword } = req.body;
    const io = req.app.get('socketio'); const userSockets = req.app.get('userSockets');
    console.log(`[Profile Edit POST] Attempt update for ${username}`);
    try {
        // Валидация
        if (!fullName || !phone) { throw new Error('ФИО и Телефон обязательны.'); }

        const currentUserData = await firebaseService.getUserByUsername(username);
        if (!currentUserData) { throw new Error('Пользователь не найден.'); } // Маловероятно, но возможно

        // Подготовка обновлений
        const updates = { FullName: fullName, Email: email || '', Phone: phone };

        // Обновление пароля, если указан
        if (newPassword?.trim()) {
             if (!currentPassword) { throw new Error('Введите текущий пароль для смены.'); }
             if (newPassword.length < 6) { throw new Error('Новый пароль < 6 симв.'); }
             let match = false;
             if (currentUserData.PasswordHash?.startsWith('$2')) { match = await bcrypt.compare(currentPassword, currentUserData.PasswordHash); }
             else { /* ... проверка старого хеша ... */ } // Оставил для совместимости, если нужно
             if (!match) { throw new Error('Текущий пароль неверен.'); }
             const salt = 10; updates.PasswordHash = await bcrypt.hash(newPassword, salt);
             console.log(`[Profile Edit POST] Password updated for ${username}`);
        }

        // Обновляем данные в Firebase
        await db.ref(`users/${username}`).update(updates);
        console.log(`[Profile Edit POST] Profile data updated for ${username}.`);

        // Обновляем данные в сессии
        req.session.user.fullName = updates.FullName;
        req.session.user.email = updates.Email;
        req.session.user.phone = updates.Phone;
        // Пароль в сессию не кладем

        // Оповещение через Socket.IO (только имя)
        const userSocketId = userSockets[username];
        if (userSocketId) { io.to(userSocketId).emit('profile_data_updated', { fullName: updates.FullName, role: req.session.user.role }); } // Отправляем и роль

        req.session.message = { type: 'success', text: 'Профиль обновлен!' };
        req.session.save(err => { if (err) console.error(`[Profile Edit POST] Session save error:`, err); res.redirect('/profile'); });
    } catch (error) {
        console.error(`[Profile Edit POST] Error for ${username}:`, error);
        req.session.message = { type: 'error', text: error.message || 'Ошибка обновления.' };
        req.session.save(err => res.redirect('/profile/edit')); // Обратно на форму редактирования
    }
});

// POST /profile/avatar - Загрузка аватара (только своего)
router.post('/profile/avatar', isLoggedIn, (req, res, next) => {
    if (!req.session.user?.username) { return res.redirect('/login'); } // Проверка сессии
    const username = req.session.user.username;
    const io = req.app.get('socketio'); const userSockets = req.app.get('userSockets');
    console.log(`[Avatar Upload POST] Attempt for user: ${username}`);

    uploadAvatar(req, res, async (err) => { // Используем middleware multer'а
         console.log(`[Avatar Upload POST] Multer processing complete for ${username}.`);
         try {
             // Обработка ошибок multer
             if (err) { throw err; } // Передаем ошибку в catch
             if (!req.file) { throw new Error('Файл не был загружен.'); }

             // Обработка файла
             console.log(`[Avatar Upload POST] File received: ${req.file.originalname}`);
             const newImageData = req.file.buffer.toString('base64');
             if (newImageData.length > 2 * 1024 * 1024 * 1.4) { // Примерная проверка размера base64
                 throw new Error("Загруженный файл слишком большой после кодирования.");
             }
             console.log(`[Avatar Upload POST] Image converted. Length: ${newImageData.length}`);

             // Обновление в Firebase
             await db.ref(`users/${username}`).update({ ImageData: newImageData });
             console.log(`[Avatar Upload POST] Firebase updated for ${username}.`);

             // Обновление сессии
             req.session.user.imageData = newImageData;

             // Оповещение через Socket.IO
             const userSocketId = userSockets[username];
             if (userSocketId) { io.to(userSocketId).emit('avatar_updated'); }

             req.session.message = { type: 'success', text: 'Аватар обновлен.' };
             req.session.save(saveErr => { if (saveErr) console.error(`[Avatar Upload POST] Session save error:`, saveErr); res.redirect('/profile/edit'); });
         } catch (error) {
              console.error(`[Avatar Upload POST ERROR] for ${username}:`, error);
              req.session.message = { type: 'error', text: error.message || 'Не удалось обработать изображение.' };
              req.session.save(saveErr => res.redirect('/profile/edit')); // Обратно на форму
         }
    });
});

// Middleware для проверки временной сессии при смене пароля
function mustChangePasswordCheck(req, res, next) {
    if (req.session?.tempUser?.username) { return next(); }
    console.log("[Change PW Check] Fail. No tempUser session. Redirecting.");
    res.redirect('/login');
}

module.exports = router;