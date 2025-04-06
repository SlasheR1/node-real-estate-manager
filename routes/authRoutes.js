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
    // Сообщение берется из res.locals middleware'ом в server.js
    res.render('login', { title: 'Вход' /* message уже в res.locals */ });
});

// GET /register - Страница регистрации
router.get('/register', isLoggedOut, (req, res) => {
    res.render('register', { title: 'Регистрация' });
});

// GET /profile - Страница профиля
// Этот маршрут УЖЕ ПРАВИЛЬНО обновляет сессию свежими данными перед рендерингом
router.get('/profile', isLoggedIn, async (req, res, next) => {
    // Проверяем, есть ли пользователь в сессии (хотя isLoggedIn уже должен был это сделать)
    if (!req.session.user || !req.session.user.username) {
        console.error("[Profile GET] User session incomplete or missing. Redirecting to login.");
        // Явно уничтожаем сессию и перенаправляем
        return req.session.destroy((err) => {
             if(err) console.error("[Profile GET] Error destroying session:", err);
             res.clearCookie('connect.sid'); // Чистим куки на всякий случай
             res.redirect('/login');
        });
    }
    const username = req.session.user.username;
    console.log(`[Profile GET] Fetching profile data for user: ${username}`);

    try {
        // Получаем АКТУАЛЬНЫЕ данные пользователя из Firebase
        const userFromDB = await firebaseService.getUserByUsername(username);

        // Если пользователь не найден в БД (например, удален админом)
        if (!userFromDB) {
             console.error(`[Profile GET] User ${username} not found in DB! Logging out.`);
             return req.session.destroy((err) => {
                 if(err) console.error("[Profile GET] Error destroying session for non-existent user:", err);
                 res.clearCookie('connect.sid');
                 res.redirect('/login');
             });
        }

        // --- ОБНОВЛЯЕМ СЕССИЮ АКТУАЛЬНЫМИ ДАННЫМИ ---
        // Это ключевой момент, который исправляет отображение на самой странице профиля
        req.session.user = {
            username: userFromDB.Username,
            fullName: userFromDB.FullName,
            role: userFromDB.Role,
            email: userFromDB.Email,
            phone: userFromDB.Phone,
            imageData: userFromDB.ImageData || null, // Важно для аватара
            companyId: userFromDB.companyId || null,
            companyProfileCompleted: userFromDB.companyProfileCompleted === true,
            // Добавляем баланс ТОЛЬКО для Tenant
            ...(userFromDB.Role === 'Tenant' && { balance: userFromDB.Balance ?? 0 }) // Важно для баланса
        };
         // Дополнительно загружаем имя компании, если нужно
         if (req.session.user.companyId) {
              try {
                   const company = await firebaseService.getCompanyById(req.session.user.companyId);
                   req.session.user.companyName = company?.companyName || null;
              } catch (companyError) {
                  console.warn(`[Profile GET] Failed to fetch company name for ${req.session.user.companyId}:`, companyError);
                  req.session.user.companyName = null;
              }
         }
         console.log(`[Profile GET] Session updated for user: ${username}`);
        // --- КОНЕЦ ОБНОВЛЕНИЯ СЕССИИ ---

        // Подготовка данных для рендеринга (аватар)
        let avatarSrc = '/images/placeholder-avatar.png';
        if (userFromDB.ImageData) {
            try {
                 // Простая проверка на JPEG или PNG по началу base64 строки
                 let type = userFromDB.ImageData.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
                 avatarSrc = `data:${type};base64,${userFromDB.ImageData}`;
            } catch (e) {
                 console.error(`[Profile GET] Error creating avatar data URI for ${username}:`, e);
                 // Оставляем плейсхолдер в случае ошибки
            }
        }

        // Рендерим страницу профиля, передавая обновленные данные из БД
        // res.locals.currentUser будет автоматически обновлен в следующем цикле запроса,
        // но здесь мы передаем userFromDB напрямую для гарантии свежести на ЭТОЙ странице.
        // Однако, поскольку мы обновили req.session.user, то res.locals в следующем запросе (если он будет до завершения этого)
        // уже будет содержать обновленные данные. Но для надежности передаем userFromDB.
        res.render('profile', {
            title: 'Мой профиль',
            // Передаем полные, свежие данные из БД в шаблон profile.ejs
            user: { ...userFromDB, DisplayAvatarSrc: avatarSrc },
            // message уже будет в res.locals из-за middleware
        });

    } catch (error) {
        console.error(`[Profile GET] Error fetching or rendering profile for ${username}:`, error);
        next(error); // Передаем ошибку глобальному обработчику
    }
});


// GET /profile/edit - Страница редактирования профиля
router.get('/profile/edit', isLoggedIn, async (req, res, next) => {
     if (!req.session.user || !req.session.user.username) { return res.redirect('/login'); } // Дополнительная проверка сессии
    const username = req.session.user.username;
    console.log(`[Profile Edit GET] Accessing edit form for user: ${username}`);
    try {
        // Получаем актуальные данные для формы
        const user = await firebaseService.getUserByUsername(username);
        if (!user) {
            console.error(`[Profile Edit GET] User ${username} not found during edit request. Logging out.`);
            return req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect('/login'); });
        }
        // Готовим аватар для отображения в форме
        let avatarSrc = '/images/placeholder-avatar.png';
        if (user.ImageData) {
            try {
                let type = user.ImageData.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
                avatarSrc = `data:${type};base64,${user.ImageData}`;
            } catch(e){
                 console.error(`[Profile Edit GET] Error creating avatar data URI for ${username}:`, e);
            }
        }

        res.render('profile-edit', {
            title: 'Редактировать профиль',
            user: { ...user, DisplayAvatarSrc: avatarSrc }, // Передаем актуальные данные из БД
            // message уже в res.locals
        });
    } catch (error) {
        console.error(`[Profile Edit GET] Error fetching user data for edit form (${username}):`, error);
        next(error);
    }
});

// GET /profile/balance-history - История баланса (Только для Tenant)
router.get('/profile/balance-history', isLoggedIn, async (req, res, next) => {
    if (!req.session.user || !req.session.user.username) { return res.redirect('/login'); }
    // --- ПРОВЕРКА РОЛИ ---
    if (req.session.user.role !== 'Tenant') {
        console.warn(`[Balance History GET] Access denied for non-tenant user: ${req.session.user.username} (Role: ${req.session.user.role})`);
        req.session.message = { type: 'warning', text: 'История баланса доступна только арендаторам.' };
        return req.session.save(err => { // Сохраняем сессию с сообщением перед редиректом
            if(err) console.error("[Balance History GET] Session save error (role check):", err);
            res.redirect('/profile'); // Или на главную '/'
        });
    }
    // --- КОНЕЦ ПРОВЕРКИ РОЛИ ---
    const username = req.session.user.username;
    console.log(`[Balance History GET] Fetching history for tenant: ${username}`);
    try {
        // Получаем пользователя, чтобы взять его историю
        const user = await firebaseService.getUserByUsername(username);
        if (!user) {
             // Маловероятно, т.к. сессия есть, но на всякий случай
             console.error(`[Balance History GET] Tenant user ${username} not found in DB.`);
             return req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect('/login'); });
        }

        // Обработка истории баланса (убедимся, что balanceHistory существует и это объект)
        let history = [];
        if (user.BalanceHistory && typeof user.BalanceHistory === 'object') {
             // Преобразуем объект в массив и добавляем ID записи (ключ)
             history = Object.entries(user.BalanceHistory)
                           .map(([firebaseKey, operationData]) => ({
                               ...operationData,
                               FBId: firebaseKey // Добавляем ID записи из Firebase
                           }))
                           .filter(op => op && op.Date && op.Amount !== undefined); // Фильтруем некорректные записи
        } else {
             console.log(`[Balance History GET] No balance history found for user ${username}.`);
        }

        // Форматирование и сортировка для отображения
        const formattedHistory = history.map(op => ({
                ...op,
                DateFormatted: new Date(op.Date).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }),
                AmountFormatted: new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', signDisplay: 'always' }).format(op.Amount || 0),
                NewBalanceFormatted: typeof op.NewBalance === 'number'
                    ? new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(op.NewBalance)
                    : '?' // Если NewBalance не записан, показываем '?'
            })).sort((a, b) => new Date(b.Date) - new Date(a.Date)); // Сортируем по дате (новейшие сверху)

        // Рендеринг шаблона balance-history.ejs
        res.render('balance-history', {
             title: 'История баланса',
             history: formattedHistory
             // message уже в res.locals
        });
    } catch (error) {
        console.error(`[Balance History GET] Error fetching balance history for ${username}:`, error);
        next(error);
    }
});

// GET /change-password - Форма принудительной смены пароля
router.get('/change-password', mustChangePasswordCheck, (req, res) => {
    // Используем временную сессию для передачи username
    const username = req.session.tempUser.username;
    console.log(`[Change Password GET] Rendering form for user: ${username}`);
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
    // Обрезаем пробелы и берем как ключ
    const usernameKey = username?.trim();
    console.log(`[Register POST] Attempting registration for username: ${usernameKey}`);
    try {
        // Валидация входных данных
        if (!usernameKey || !password || !fullName || !phone) {
            throw new Error('Необходимо заполнить поля: Логин, Пароль, ФИО, Телефон.');
        }
        if (password.length < 6) {
            throw new Error('Пароль должен содержать не менее 6 символов.');
        }
        // Проверка, занят ли логин
        if (await firebaseService.getUserByUsername(usernameKey)) {
            throw new Error(`Логин '${usernameKey}' уже используется. Пожалуйста, выберите другой.`);
        }

        // Хеширование пароля
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // Создание объекта нового пользователя
        // По умолчанию регистрируем как Tenant, без companyId и без необходимости смены пароля
        const newUser = {
            Username: usernameKey, // Используем обрезанный ключ
            PasswordHash: passwordHash,
            FullName: fullName,
            Email: email || '', // Email необязателен
            Phone: phone,
            Role: 'Tenant', // Роль по умолчанию - Арендатор
            Balance: 0, // Начальный баланс только для Tenant
            BalanceHistory: {}, // Пустая история баланса
            ImageData: null, // Без аватара по умолчанию
            MustChangePassword: false, // Не требует смены пароля при первой регистрации
            companyId: null, // Нет привязки к компании
            companyProfileCompleted: false // Профиль компании не заполнен
        };
        // Удаляем поля Balance и BalanceHistory, если роль не Tenant (на всякий случай, хотя здесь всегда Tenant)
        if (newUser.Role !== 'Tenant') {
            delete newUser.Balance;
            delete newUser.BalanceHistory;
        }

        // Сохраняем пользователя в Firebase
        // Передаем username еще раз для использования как ключ в базе данных
        await firebaseService.saveUser({ ...newUser, username: usernameKey });
        console.log(`[Register POST] User ${usernameKey} registered successfully as Tenant.`);

        // Устанавливаем сообщение об успехе в сессию
        req.session.message = { type: 'success', text: 'Регистрация прошла успешно! Теперь вы можете войти.' };

        // Сохраняем сессию с сообщением и отправляем ответ клиенту
        req.session.save(err => {
            if(err) {
                console.error("[Register POST] Session save error after successful registration:", err);
                // Даже если сессию не удалось сохранить, отвечаем успехом, т.к. пользователь создан
                return res.status(200).json({ success: true, redirectUrl: '/login' });
            }
            console.log("[Register POST] Session saved with success message.");
            res.status(200).json({ success: true, redirectUrl: '/login' });
        });
    } catch (error) {
         console.error("[Register POST] Error during registration:", error);
         // Отправляем ошибку клиенту в формате JSON
         res.status(400).json({ success: false, error: error.message || 'Произошла ошибка при регистрации.' });
    }
});

// POST /login - Вход пользователя (AJAX)
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const usernameKey = username?.trim();
    console.log(`[Login POST] Attempting login for user: ${usernameKey}`);

    try {
        // Валидация
        if (!usernameKey || !password) {
            throw new Error('Пожалуйста, введите логин и пароль.');
        }
        // Получение пользователя из БД
        const user = await firebaseService.getUserByUsername(usernameKey);
        // Проверка существования пользователя и хеша пароля
        if (!user || !user.PasswordHash) {
            console.warn(`[Login POST] User not found or password hash missing for: ${usernameKey}`);
            throw new Error('Неверный логин или пароль.'); // Общее сообщение для безопасности
        }

        // Проверка пароля (Bcrypt или старый SHA256 для обратной совместимости, если нужно)
        let passwordMatch = false;
        let needsRehash = false; // Флаг для рехеширования старых паролей

        if (user.PasswordHash.startsWith('$2a$') || user.PasswordHash.startsWith('$2b$')) {
             // Используем bcrypt для современных хешей
             try {
                  passwordMatch = await bcrypt.compare(password, user.PasswordHash);
             } catch (compareError){
                  console.error("[Login POST] Bcrypt compare error:", compareError);
                  throw new Error('Ошибка проверки пароля. Попробуйте еще раз.');
             }
        } else {
             // Fallback для старых хешей (например, SHA256 base64), если они могли быть
             console.log(`[Login POST] Detected potentially old hash format for ${usernameKey}. Attempting fallback check.`);
             try {
                  const hasher = crypto.createHash('sha256');
                  const hashedInputPassword = hasher.update(password, 'utf-8').digest('base64');
                  if(hashedInputPassword === user.PasswordHash) {
                       passwordMatch = true;
                       needsRehash = true; // Помечаем, что пароль нужно рехешировать
                       console.log(`[Login POST] Old hash matched for ${usernameKey}. Needs rehash.`);
                  }
             } catch(hashError){
                  console.error("[Login POST] Fallback hash check error:", hashError);
                  // Не бросаем ошибку, просто пароль не совпал
             }
        }

        // Обработка результата сравнения паролей
        if (passwordMatch) {
            console.log(`[Login POST] Password match successful for ${usernameKey}.`);

            // Рехеширование старого пароля, если необходимо
            if (needsRehash) {
                 try {
                      const salt = 10;
                      const newHash = await bcrypt.hash(password, salt);
                      await db.ref(`users/${usernameKey}/PasswordHash`).set(newHash);
                      user.PasswordHash = newHash; // Обновляем хеш в объекте пользователя для текущей сессии
                      console.log(`[Login POST] Password successfully rehashed for ${usernameKey}.`);
                 } catch (rehashError) {
                      console.error(`[Login POST] Failed to rehash password for ${usernameKey}:`, rehashError);
                      // Не критично, пользователь все равно войдет, но логируем ошибку
                 }
            }

            // Проверка на принудительную смену пароля
            if (user.MustChangePassword === true) {
                console.log(`[Login POST] User ${usernameKey} must change password. Redirecting to /change-password.`);
                // Сохраняем только username во временную сессию для смены пароля
                req.session.tempUser = { username: user.Username };
                return req.session.save(err => {
                     if (err) console.error("[Login POST] Session save error (force change):", err);
                     // Отправляем JSON с указанием на принудительную смену
                     res.status(200).json({ success: true, forceChange: true, redirectUrl: '/change-password' });
                });
            } else {
                // Стандартный вход - регенерация сессии для предотвращения фиксации сессии
                req.session.regenerate(async (err) => {
                    if (err) {
                         console.error("[Login POST] Session regeneration error:", err);
                         // Отправляем ошибку клиенту
                         return res.status(500).json({ success: false, error: 'Ошибка сессии при входе.' });
                    }
                    console.log(`[Login POST] Session regenerated for ${usernameKey}. Populating session data.`);

                    // --- Формирование объекта сессии ---
                    const sessionUser = {
                        username: user.Username,
                        fullName: user.FullName,
                        role: user.Role,
                        email: user.Email,
                        phone: user.Phone,
                        imageData: user.ImageData || null, // Данные аватара
                        companyId: user.companyId || null, // ID компании
                        companyProfileCompleted: user.companyProfileCompleted === true, // Флаг завершенности профиля компании
                        companyName: null // Имя компании будет загружено ниже, если есть companyId
                    };
                    // Добавляем баланс только для Tenant
                    if(user.Role === 'Tenant'){
                         sessionUser.balance = user.Balance ?? 0; // Используем ?? для обработки null/undefined
                    }

                    // Загрузка имени компании, если есть ID
                    if (sessionUser.companyId) {
                         try {
                              const company = await firebaseService.getCompanyById(sessionUser.companyId);
                              sessionUser.companyName = company?.companyName || null; // Используем имя из БД или null
                         } catch (companyError) {
                              console.warn(`[Login POST] Failed to fetch company name for company ${sessionUser.companyId}:`, companyError);
                              sessionUser.companyName = null; // В случае ошибки ставим null
                         }
                    }

                    // Сохраняем сформированный объект пользователя в сессию
                    req.session.user = sessionUser;
                    console.log("[Login POST] Session user object created:", req.session.user);

                    // Сохраняем сессию перед отправкой ответа
                    req.session.save(saveErr => {
                         if (saveErr) {
                             console.error("[Login POST] Session save error after population:", saveErr);
                             // Пытаемся ответить клиенту даже при ошибке сохранения сессии
                             return res.status(500).json({ success: false, error: 'Ошибка сохранения сессии.' });
                         }
                         console.log(`[Login POST] Login successful for ${usernameKey}. Redirecting to /.`);
                         res.status(200).json({ success: true, redirectUrl: '/' }); // Успешный вход, редирект на дашборд
                    });
                });
            }
        } else { // Пароль не совпал
            console.warn(`[Login POST] Password mismatch for user: ${usernameKey}.`);
            throw new Error('Неверный логин или пароль.');
        }
    } catch (error) {
        console.error("[Login POST] Error during login process:", error);
        // Отправляем стандартизированную ошибку клиенту
        res.status(400).json({ success: false, error: error.message || 'Произошла ошибка при входе.' });
    }
});

// POST /change-password - Обработка принудительной смены пароля
router.post('/change-password', mustChangePasswordCheck, async (req, res) => {
    const { newPassword, confirmPassword } = req.body;
    // Получаем username из временной сессии
    const username = req.session.tempUser.username;
    console.log(`[Change Password POST] Attempting to change password for user: ${username}`);
    try {
        // Валидация
        if (!newPassword || !confirmPassword) {
            throw new Error('Необходимо ввести и подтвердить новый пароль.');
        }
        if (newPassword !== confirmPassword) {
            throw new Error('Введенные пароли не совпадают.');
        }
        if (newPassword.length < 6) {
            throw new Error('Новый пароль должен содержать не менее 6 символов.');
        }

        // Хеширование нового пароля
        const saltRounds = 10;
        const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

        // Подготовка обновлений для Firebase
        const updates = {
            PasswordHash: newPasswordHash,
            MustChangePassword: null // Сбрасываем флаг принудительной смены (устанавливаем в null для удаления)
        };

        // Обновление данных пользователя в Firebase
        await db.ref(`users/${username}`).update(updates);
        console.log(`[Change Password POST] Password updated successfully for ${username}. Flag 'MustChangePassword' removed.`);

        // Очистка временной сессии
        delete req.session.tempUser;

        // Установка сообщения об успехе для страницы логина
        req.session.message = { type: 'success', text: 'Пароль успешно изменен! Теперь вы можете войти с новым паролем.' };

        // Сохранение сессии и редирект на страницу входа
        req.session.save(err => {
             if (err) {
                 console.error(`[Change Password POST] Session save error after password change for ${username}:`, err);
                 // Даже при ошибке сохранения сессии, редирект на логин
                 return res.redirect('/login');
             }
             console.log(`[Change Password POST] Redirecting user ${username} to login page.`);
             res.redirect('/login');
        });
    } catch (error) {
        console.error(`[Change Password POST] Error changing password for ${username}:`, error);
        // Сохраняем сообщение об ошибке в сессию для отображения на странице смены пароля
        req.session.message = { type: 'error', text: error.message || 'Произошла ошибка при смене пароля.' };
        req.session.save(saveErr => {
             if (saveErr) console.error(`[Change Password POST] Session save error (catch block):`, saveErr);
             res.redirect('/change-password'); // Обратно на форму смены пароля
        });
    }
});


// POST /logout - Выход пользователя
router.post('/logout', (req, res) => {
    // Определяем имя пользователя для логирования (из основной или временной сессии)
    const username = req.session?.user?.username || req.session?.tempUser?.username || 'Guest';
    console.log(`[Logout POST] Initiating logout for user: ${username}`);

    req.session.destroy(err => { // Уничтожаем сессию на сервере
        // Очищаем куки сессии в браузере пользователя
        res.clearCookie('connect.sid'); // Используйте имя вашей куки сессии, если оно другое

        if (err) {
             console.error("[Logout POST] Error destroying session:", err);
             // Даже при ошибке уничтожения сессии, лучше перенаправить пользователя
             return res.redirect('/login');
        }
        console.log(`[Logout POST] Session destroyed successfully for ${username}. Redirecting to /login.`);
        res.redirect('/login'); // Перенаправляем на страницу входа после успешного выхода
    });
});

// POST /profile/add-funds - Пополнение баланса (AJAX - Только для Tenant)
router.post('/profile/add-funds', isLoggedIn, async (req, res) => {
    // Проверяем наличие пользователя и его роли в сессии
    if (!req.session.user?.username) {
        console.warn("[Add Funds POST] Unauthorized attempt: No user in session.");
        return res.status(401).json({ error: 'Доступ запрещен. Сессия не найдена.' });
    }
    if (req.session.user.role !== 'Tenant') {
        console.warn(`[Add Funds POST] Forbidden attempt: User ${req.session.user.username} is not a Tenant (Role: ${req.session.user.role}).`);
        return res.status(403).json({ error: 'Действие доступно только арендаторам.' });
    }

    const username = req.session.user.username;
    const io = req.app.get('socketio'); // Получаем экземпляр Socket.IO
    const userSockets = req.app.get('userSockets'); // Получаем карту сокетов
    console.log(`[Add Funds POST] Attempting to add funds for Tenant: ${username}`);

    try {
        const userRef = db.ref(`users/${username}`);
        const amountToAdd = 1000; // Фиксированная сумма тестового пополнения

        // Используем транзакцию Firebase для атомарного обновления баланса и истории
        const transactionResult = await userRef.transaction(currentUserData => {
            // Если пользователь не найден в БД во время транзакции
            if (currentUserData === null) {
                 console.error(`[Add Funds Transaction] User ${username} node is null. Aborting transaction.`);
                 return undefined; // Отменяем транзакцию
            }
            // Дополнительная проверка роли внутри транзакции (на всякий случай)
            if (currentUserData.Role !== 'Tenant') {
                 console.warn(`[Add Funds Transaction] User ${username} is not Tenant inside transaction. Aborting.`);
                 return undefined; // Отменяем транзакцию
            }

            const currentBalance = currentUserData.Balance || 0; // Текущий баланс (или 0, если нет)
            const newBalance = parseFloat((currentBalance + amountToAdd).toFixed(2)); // Новый баланс

            // Обновляем баланс пользователя
            currentUserData.Balance = newBalance;

            // Добавляем запись в историю баланса
            if (!currentUserData.BalanceHistory) {
                 currentUserData.BalanceHistory = {}; // Инициализируем, если не существует
            }
            const historyKey = userRef.child('BalanceHistory').push().key; // Генерируем уникальный ключ
            if(!historyKey) {
                // Это критическая ошибка, если не удалось сгенерировать ключ
                console.error(`[Add Funds Transaction] Failed to generate history key for user ${username}! Aborting.`);
                return undefined; // Отменяем транзакцию
            }
            currentUserData.BalanceHistory[historyKey] = {
                 Id: historyKey, // Сохраняем ключ в самой записи
                 Date: new Date().toISOString(),
                 Amount: amountToAdd,
                 OperationType: "Пополнение", // Тип операции
                 Description: "Тестовое пополнение баланса", // Описание
                 NewBalance: newBalance // Баланс после операции
            };

            return currentUserData; // Возвращаем обновленные данные для сохранения
        });

        // Проверяем результат транзакции
        if (!transactionResult.committed || !transactionResult.snapshot.exists()) {
             // Если транзакция не прошла или узел пользователя не существует
             console.error(`[Add Funds POST] Transaction failed or user ${username} does not exist.`);
             throw new Error("Не удалось обновить баланс пользователя. Возможно, пользователь был удален.");
        }

        // Получаем финальный баланс после успешной транзакции
        const finalBalance = transactionResult.snapshot.val().Balance;

        // --- Обновляем баланс в СЕССИИ ---
        req.session.user.balance = finalBalance;
        console.log(`[Add Funds POST] User ${username} balance updated to ${finalBalance}. Session updated.`);

        // --- Оповещение клиента через Socket.IO ---
        const userSocketId = userSockets[username]; // Находим ID сокета пользователя
        if (userSocketId) {
             console.log(`[Add Funds POST] Emitting 'balance_updated' event to socket ${userSocketId} for user ${username}.`);
             io.to(userSocketId).emit('balance_updated', finalBalance); // Отправляем событие с новым балансом
        } else {
             console.log(`[Add Funds POST] User ${username} is not currently connected via socket. No real-time update sent.`);
        }

        // Сохраняем сессию с обновленным балансом перед отправкой ответа
        req.session.save(err => {
            if (err) {
                 console.error(`[Add Funds POST] Session save error after balance update for ${username}:`, err);
                 // Отправляем ответ даже если сессия не сохранилась
                 return res.status(200).json({ message: 'Баланс пополнен (ошибка сохранения сессии)', newBalance: finalBalance });
            }
            console.log(`[Add Funds POST] Successfully added funds for ${username}. Responding to client.`);
            res.status(200).json({ message: 'Баланс успешно пополнен!', newBalance: finalBalance });
        });

    } catch (error) {
         console.error(`[Add Funds POST] Error processing funds addition for ${username}:`, error);
         // Отправляем ошибку клиенту
         res.status(500).json({ error: error.message || 'Произошла ошибка на сервере при пополнении баланса.' });
     }
});


// POST /profile/edit - Редактирование профиля (только свои данные)
router.post('/profile/edit', isLoggedIn, async (req, res, next) => {
    // Проверка сессии (хотя isLoggedIn уже должен был это сделать)
    if (!req.session.user?.username) {
        console.warn("[Profile Edit POST] Unauthorized attempt: No user in session.");
        return res.redirect('/login');
    }
    const username = req.session.user.username;
    const { fullName, email, phone, currentPassword, newPassword } = req.body;
    const io = req.app.get('socketio'); // Получаем Socket.IO
    const userSockets = req.app.get('userSockets'); // Получаем карту сокетов
    console.log(`[Profile Edit POST] Attempting profile update for user: ${username}`);

    try {
        // Валидация основных полей
        if (!fullName || !fullName.trim() || !phone || !phone.trim()) {
            throw new Error('Поля ФИО и Телефон являются обязательными для заполнения.');
        }

        // Получаем текущие данные пользователя из БД для проверки пароля
        const currentUserData = await firebaseService.getUserByUsername(username);
        if (!currentUserData) {
             // Это не должно произойти, если пользователь авторизован, но проверяем
             console.error(`[Profile Edit POST] User ${username} not found in DB during edit attempt!`);
             throw new Error('Не удалось найти данные пользователя.');
        }

        // Подготовка объекта с обновлениями для Firebase
        const updates = {
            FullName: fullName.trim(),
            Email: email || '', // Email может быть пустым
            Phone: phone.trim()
        };

        // Обработка смены пароля, если введен новый пароль
        if (newPassword && newPassword.trim()) {
             console.log(`[Profile Edit POST] Password change requested for ${username}.`);
             // Проверка текущего пароля
             if (!currentPassword) {
                  throw new Error('Для смены пароля необходимо ввести текущий пароль.');
             }
             if (newPassword.length < 6) {
                  throw new Error('Новый пароль должен содержать не менее 6 символов.');
             }
             // Сравнение текущего введенного пароля с хешем из БД
             let match = false;
             if (currentUserData.PasswordHash?.startsWith('$2')) { // Проверка Bcrypt хеша
                  match = await bcrypt.compare(currentPassword, currentUserData.PasswordHash);
             } else {
                  // Здесь можно добавить логику проверки старого хеша, если необходимо
                  console.warn(`[Profile Edit POST] Attempting password change for user ${username} with potentially old hash format.`);
             }
             if (!match) {
                  throw new Error('Введенный текущий пароль неверен.');
             }
             // Хеширование нового пароля
             const salt = 10;
             updates.PasswordHash = await bcrypt.hash(newPassword, salt);
             console.log(`[Profile Edit POST] New password hash generated for ${username}.`);
             // Можно добавить сброс флага MustChangePassword, если он был
             // updates.MustChangePassword = null;
        }

        // Обновляем данные пользователя в Firebase
        await db.ref(`users/${username}`).update(updates);
        console.log(`[Profile Edit POST] Profile data successfully updated in Firebase for ${username}.`);

        // --- Обновляем данные в СЕССИИ ---
        req.session.user.fullName = updates.FullName;
        req.session.user.email = updates.Email;
        req.session.user.phone = updates.Phone;
        // Пароль в сессию не кладем!
        console.log(`[Profile Edit POST] Session data updated for ${username}.`);

        // --- Оповещение клиента через Socket.IO об обновлении данных ---
        const userSocketId = userSockets[username];
        if (userSocketId) {
             // Отправляем только необходимые для обновления интерфейса данные
             const profileUpdateData = {
                  fullName: updates.FullName,
                  // Можно добавить другие поля при необходимости
                  // role: req.session.user.role // Роль не меняется здесь
             };
             io.to(userSocketId).emit('profile_data_updated', profileUpdateData);
             console.log(`[Profile Edit POST] Emitted 'profile_data_updated' event to socket ${userSocketId}.`);
        } else {
             console.log(`[Profile Edit POST] User ${username} not connected via socket. No real-time profile update sent.`);
        }

        // Устанавливаем сообщение об успехе
        req.session.message = { type: 'success', text: 'Профиль успешно обновлен!' };
        // Сохраняем сессию и делаем редирект на страницу профиля
        req.session.save(err => {
             if (err) console.error(`[Profile Edit POST] Session save error after update for ${username}:`, err);
             res.redirect('/profile');
        });

    } catch (error) {
        console.error(`[Profile Edit POST] Error updating profile for ${username}:`, error);
        // Сохраняем сообщение об ошибке в сессию
        req.session.message = { type: 'error', text: error.message || 'Произошла ошибка при обновлении профиля.' };
        // Сохраняем сессию и делаем редирект обратно на форму редактирования
        req.session.save(err => {
             if (err) console.error(`[Profile Edit POST] Session save error (catch block):`, err);
             res.redirect('/profile/edit');
        });
    }
});


// POST /profile/avatar - Загрузка аватара (только своего)
router.post('/profile/avatar', isLoggedIn, (req, res, next) => {
    if (!req.session.user?.username) { return res.redirect('/login'); } // Проверка сессии
    const username = req.session.user.username;
    const io = req.app.get('socketio'); const userSockets = req.app.get('userSockets');
    console.log(`[Avatar Upload POST] Attempting avatar upload for user: ${username}`);

    // Используем middleware multer'а для обработки загрузки файла
    uploadAvatar(req, res, async (err) => {
         console.log(`[Avatar Upload POST] Multer processing finished for ${username}.`);
         try {
             // Обработка ошибок Multer (неправильный тип файла, размер и т.д.)
             if (err) {
                  console.error(`[Avatar Upload POST] Multer error for ${username}:`, err.message);
                  // Передаем ошибку Multer дальше в catch блок
                  throw err;
             }
             // Проверяем, был ли файл действительно загружен
             if (!req.file) {
                  console.warn(`[Avatar Upload POST] No file was uploaded for ${username}.`);
                  throw new Error('Файл изображения не был выбран или загружен.');
             }

             // Обработка загруженного файла
             console.log(`[Avatar Upload POST] File received: ${req.file.originalname}, Size: ${req.file.size} bytes, MimeType: ${req.file.mimetype}`);
             // Конвертируем буфер файла в строку base64
             const newImageData = req.file.buffer.toString('base64');

             // Дополнительная проверка размера base64 строки (она больше исходного файла)
             // Примерный коэффициент ~1.37, но для безопасности можно взять 1.4-1.5
             const base64Limit = 2 * 1024 * 1024 * 1.4; // 2MB * 1.4
             if (newImageData.length > base64Limit) {
                 console.error(`[Avatar Upload POST] Base64 image data too large for ${username}. Length: ${newImageData.length}`);
                 throw new Error("Загруженный файл слишком большой после кодирования. Попробуйте изображение меньшего размера.");
             }
             console.log(`[Avatar Upload POST] Image converted to base64. Base64 Length: ${newImageData.length}`);

             // Обновление поля ImageData пользователя в Firebase
             await db.ref(`users/${username}`).update({ ImageData: newImageData });
             console.log(`[Avatar Upload POST] Firebase updated successfully for ${username}.`);

             // --- Обновление данных аватара в СЕССИИ ---
             req.session.user.imageData = newImageData;
             console.log(`[Avatar Upload POST] Session updated with new avatar data for ${username}.`);

             // --- Оповещение клиента через Socket.IO об обновлении аватара ---
             const userSocketId = userSockets[username];
             if (userSocketId) {
                  // Отправляем простое событие, клиент сам обновит картинку
                  io.to(userSocketId).emit('avatar_updated');
                  console.log(`[Avatar Upload POST] Emitted 'avatar_updated' event to socket ${userSocketId}.`);
             } else {
                   console.log(`[Avatar Upload POST] User ${username} not connected via socket. No real-time avatar update sent.`);
             }

             // Устанавливаем сообщение об успехе
             req.session.message = { type: 'success', text: 'Аватар успешно обновлен.' };
             // Сохраняем сессию и делаем редирект обратно на страницу редактирования профиля
             req.session.save(saveErr => {
                  if (saveErr) console.error(`[Avatar Upload POST] Session save error after avatar upload for ${username}:`, saveErr);
                  res.redirect('/profile/edit');
             });
         } catch (error) {
              // Ловим ошибки Multer и другие ошибки обработки
              console.error(`[Avatar Upload POST ERROR] for ${username}:`, error);
              req.session.message = { type: 'error', text: error.message || 'Не удалось загрузить или обработать изображение.' };
              // Сохраняем сессию и редирект обратно на форму
              req.session.save(saveErr => {
                   if (saveErr) console.error(`[Avatar Upload POST] Session save error (catch block):`, saveErr);
                   res.redirect('/profile/edit');
              });
         }
    });
});


// Middleware для проверки временной сессии при смене пароля
function mustChangePasswordCheck(req, res, next) {
    // Проверяем наличие временной сессии tempUser и username в ней
    if (req.session?.tempUser?.username) {
        // Если все ок, передаем управление следующему middleware или маршруту
        return next();
    }
    // Если временной сессии нет, значит пользователь пытается получить доступ к странице смены пароля напрямую
    console.warn("[Change PW Check] Failed: No tempUser session found. Redirecting to login.");
    res.redirect('/login'); // Перенаправляем на страницу входа
}

module.exports = router; // Экспорт роутера