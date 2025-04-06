const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto'); // Оставляем, т.к. может использоваться в будущем или для старых хешей
const firebaseService = require('../services/firebaseService');
const { isLoggedIn, isAdmin } = require('../middleware/authMiddleware');
const admin = require('firebase-admin');
const db = admin.database();
const log = require('electron-log'); // Используем electron-log

const router = express.Router();

// --- Функция генерации временного пароля ---
function generateTemporaryPassword(length = 10) {
    // Убрал спецсимволы для простоты копирования/ввода пользователем
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < length; i++) {
        password += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    // Простая проверка, что есть и буквы и цифры (хотя бы по одной)
    if (!/\d/.test(password) || !/[a-zA-Z]/.test(password)) {
        return generateTemporaryPassword(length); // Генерируем заново, если нет
    }
    return password;
}

// =======================================
// === GET МАРШРУТЫ (Рендеринг страниц) ===
// =======================================

// GET / (Список пользователей) - Только для Admin
router.get('/', isLoggedIn, isAdmin, async (req, res, next) => {
    log.info("[GET /users v5] Accessing user list route by Admin.");
    try {
        const users = await firebaseService.getAllUsers();
        const validUsers = Array.isArray(users) ? users : [];

        // Подготовка данных для отображения, включая аватары
        const usersWithAvatars = validUsers.filter(Boolean).map(user => {
            let avatarSrc = '/images/placeholder-avatar.png'; // Плейсхолдер по умолчанию
            if (user.ImageData && typeof user.ImageData === 'string') {
                try {
                    // Простая проверка на JPEG или PNG
                    let type = user.ImageData.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
                    avatarSrc = `data:${type};base64,${user.ImageData}`;
                } catch (e) {
                    log.warn(`[GET /users v5] Error creating avatar data URI for user ${user.Username}:`, e);
                }
            }
            // Пропускаем пользователей без Username (маловероятно, но для надежности)
            if (!user.Username) {
                log.warn("[GET /users v5] Skipping user entry with missing Username.");
                return null;
            }
            return { ...user, DisplayAvatarSrc: avatarSrc };
        }).filter(Boolean); // Убираем null значения

        // Сообщение берется из res.locals middleware'ом
        res.render('users-list', {
            title: 'Управление пользователями',
            users: usersWithAvatars,
            // message уже в res.locals
        });
    } catch (error) {
        log.error("[GET /users v5] Error fetching or processing user list:", error);
        next(error); // Передаем ошибку дальше
    }
});

// GET /add (Форма добавления) - Только для Admin
router.get('/add', isLoggedIn, isAdmin, async (req, res, next) => {
    log.info("[GET /users/add v5] Accessing add user form route by Admin.");
    // Сообщение берется из res.locals
    try {
         // Загружаем список компаний для выбора при создании Staff
         const companiesSnapshot = await db.ref('companies').once('value');
         const companiesData = companiesSnapshot.val();
         // Преобразуем в массив для select'а
         const companiesList = companiesData ? Object.entries(companiesData).map(([id, data]) => ({
              id: id,
              name: data.companyName || `Компания ${id}` // Используем имя или ID
         })) : [];

        res.render('user-add-edit', {
             title: 'Добавить пользователя',
             userToEdit: {}, // Пустой объект для новой записи
             isEditMode: false,
             availableRoles: ['Admin', 'Owner', 'Staff', 'Tenant'], // Доступные роли для выбора
             companiesList: companiesList, // Список компаний для привязки Staff
             // message уже в res.locals
        });
    } catch(error) {
        log.error("[GET /users/add v5] Error fetching companies list:", error);
        // Даже при ошибке загрузки компаний, рендерим форму, но с сообщением об ошибке
         res.render('user-add-edit', {
             title: 'Добавить пользователя',
             userToEdit: {}, isEditMode: false,
             availableRoles: ['Admin', 'Owner', 'Staff', 'Tenant'],
             companiesList: [], // Пустой список
             // message уже в res.locals
             localError: "Не удалось загрузить список компаний." // Доп. сообщение об ошибке
         });
    }
});

// GET /edit/:username (Форма редактирования) - Только для Admin
router.get('/edit/:username', isLoggedIn, isAdmin, async (req, res, next) => {
    const usernameToEdit = req.params.username;
    log.info(`[GET /users/edit v5] Accessing edit form for user: ${usernameToEdit} by Admin.`);
    try {
        // Загружаем данные пользователя и список компаний параллельно
        const [user, companiesSnapshot] = await Promise.all([
             firebaseService.getUserByUsername(usernameToEdit),
             db.ref('companies').once('value')
        ]);

        // Если пользователь не найден
        if (!user) {
            log.warn(`[GET /users/edit v5] User ${usernameToEdit} not found.`);
            req.session.message = { type: 'error', text: `Пользователь с логином "${usernameToEdit}" не найден.` };
            return req.session.save(err => res.redirect('/users'));
        }

        // Подготовка списка компаний
        const companiesData = companiesSnapshot.val();
        const companiesList = companiesData ? Object.entries(companiesData).map(([id, data]) => ({
             id: id, name: data.companyName || `Компания ${id}`
        })) : [];

        // Подготовка аватара для отображения
        let avatarSrc = '/images/placeholder-avatar.png';
        if (user.ImageData && typeof user.ImageData === 'string') {
            try {
                let type = user.ImageData.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
                avatarSrc = `data:${type};base64,${user.ImageData}`;
            } catch(e){
                log.warn(`[GET /users/edit v5] Error creating avatar data URI for ${usernameToEdit}:`, e);
            }
        }

        // Сообщение берется из res.locals
        res.render('user-add-edit', {
            title: `Редактировать: ${user.Username}`,
            userToEdit: { ...user, DisplayAvatarSrc: avatarSrc }, // Передаем данные пользователя
            isEditMode: true,
            availableRoles: ['Admin', 'Owner', 'Staff', 'Tenant'],
            companiesList: companiesList,
            // message уже в res.locals
        });
    } catch (error) {
        log.error(`[GET /users/edit v5] Error fetching data for user ${usernameToEdit}:`, error);
        next(error); // Передаем ошибку дальше
    }
});

// =======================================
// === POST МАРШРУТЫ (Обработка данных) ===
// =======================================

// POST /add (Добавление пользователя) - Только для Admin
router.post('/add', isLoggedIn, isAdmin, async (req, res, next) => {
    const { username, password, fullName, email, phone, role, companyId } = req.body;
    const usernameKey = username?.trim();
    log.info(`[POST /users/add v5] Admin attempting to add user: ${usernameKey} with role ${role}`);
    try {
        // --- Валидация входных данных ---
        if (!usernameKey || !password || !fullName || !phone || !role) {
            throw new Error('Необходимо заполнить поля: Логин, Пароль, ФИО, Телефон и Роль.');
        }
        if (!['Admin', 'Owner', 'Staff', 'Tenant'].includes(role)) {
            throw new Error('Выбрана недопустимая роль пользователя.');
        }
        if (password.length < 6) {
            throw new Error('Пароль должен содержать не менее 6 символов.');
        }
        if (await firebaseService.getUserByUsername(usernameKey)) {
            throw new Error(`Пользователь с логином '${usernameKey}' уже существует.`);
        }
        if (role === 'Staff' && !companyId) {
             throw new Error("Для роли 'Staff' необходимо выбрать компанию.");
        }
        // Проверяем существование компании, если она выбрана для Staff
        if (role === 'Staff' && companyId && !(await firebaseService.getCompanyById(companyId))) {
             throw new Error(`Выбранная компания (ID: ${companyId}) не найдена.`);
        }
        // --- Конец валидации ---

        // Определяем companyId для пользователя в зависимости от роли
        let assignedCompanyId = null;
        if (role === 'Staff') {
            assignedCompanyId = companyId; // Привязываем к выбранной компании
        } else if (role === 'Owner') {
            // Для Owner'а ID компании совпадает с его username
            assignedCompanyId = usernameKey;
        } // Для Admin и Tenant companyId остается null

        // Хеширование пароля
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // Создание объекта нового пользователя
        const newUser = {
             Username: usernameKey,
             PasswordHash: passwordHash,
             FullName: fullName,
             Email: email || '',
             Phone: phone,
             Role: role,
             ImageData: null,
             MustChangePassword: false, // По умолчанию не требует смены пароля
             companyId: assignedCompanyId, // null или ID компании/username Owner'а
             // Добавляем поля только для соответствующих ролей
             ...(role === 'Owner' && { companyProfileCompleted: false }), // Owner начинает с незаполненным профилем
             ...(role === 'Tenant' && { Balance: 0, BalanceHistory: {} }) // Tenant начинает с нулевым балансом
        };
        // Удаляем ключи с undefined значениями (на всякий случай)
        Object.keys(newUser).forEach(key => newUser[key] === undefined && delete newUser[key]);

        // Сохранение пользователя в /users/
        await firebaseService.saveUser({ ...newUser, username: usernameKey });

        // Дополнительные действия в зависимости от роли
        if (role === 'Owner') {
             // Создаем запись компании в /companies/
             await firebaseService.createCompany(assignedCompanyId, usernameKey, { companyName: `${fullName} Company` }); // Имя по умолчанию
             log.info(`[POST /users/add v5] Created company node ${assignedCompanyId} for new Owner ${usernameKey}.`);
        } else if (role === 'Staff') {
             // Добавляем пользователя в список staff компании
             await db.ref(`companies/${assignedCompanyId}/staff/${usernameKey}`).set(true);
             log.info(`[POST /users/add v5] Added user ${usernameKey} to staff of company ${assignedCompanyId}.`);
        }

        log.info(`[POST /users/add v5] User ${usernameKey} (Role: ${role}) added successfully by Admin.`);
        req.session.message = { type: 'success', text: `Пользователь ${usernameKey} (Роль: ${role}) успешно добавлен!` };
        // Сохраняем сессию и редирект на список пользователей
        req.session.save(err => {
            if (err) log.error("[POST /users/add v5] Session save error after adding user:", err);
            res.redirect('/users');
        });

    } catch (error) {
        log.error("[POST /users/add v5] Error adding user:", error);
        req.session.message = { type: 'error', text: error.message || 'Произошла ошибка при добавлении пользователя.' };
        // Попытка рендерить форму снова с введенными данными и ошибкой
        try {
            const companiesSnapshot = await db.ref('companies').once('value');
            const companiesList = companiesSnapshot.val() ? Object.entries(companiesSnapshot.val()).map(([id, data]) => ({ id: id, name: data.companyName || `Компания ${id}` })) : [];
            // Собираем введенные данные для передачи обратно в форму
            const userFormData = { Username: username, FullName: fullName, Email: email, Phone: phone, Role: role, companyId: companyId };
            res.render('user-add-edit', {
                 title: 'Добавить пользователя',
                 userToEdit: userFormData, // Передаем введенные данные
                 isEditMode: false,
                 availableRoles: ['Admin', 'Owner', 'Staff', 'Tenant'],
                 companiesList: companiesList,
                 // message уже будет в res.locals, т.к. мы его установили выше
                 localError: error.message // Можно передать текст ошибки отдельно
            });
        } catch (renderError) {
             log.error("[POST /users/add v5] Error rendering form after validation error:", renderError);
             next(error); // Если рендер формы тоже не удался, передаем исходную ошибку дальше
        }
    }
});

// POST /edit/:username (Редактирование пользователя) - Только для Admin
router.post('/edit/:username', isLoggedIn, isAdmin, async (req, res, next) => {
    const usernameToEdit = req.params.username;
    const { fullName, email, phone, role, companyId, newPassword, balance } = req.body;
    const io = req.app.get('socketio'); // Получаем Socket.IO
    log.info(`[POST /users/edit v5] Admin attempting update for user: ${usernameToEdit}`);
    try {
        // --- Валидация ---
        if (!usernameToEdit || !fullName || !phone || !role) {
            throw new Error('Необходимо заполнить поля: ФИО, Телефон, Роль.');
        }
        if (!['Admin', 'Owner', 'Staff', 'Tenant'].includes(role)) {
            throw new Error('Выбрана недопустимая роль.');
        }
        if (role === 'Staff' && !companyId) {
            throw new Error("Для роли 'Staff' необходимо выбрать компанию.");
        }

        // Получаем текущие данные пользователя
        const currentUserData = await firebaseService.getUserByUsername(usernameToEdit);
        if (!currentUserData) {
            throw new Error(`Редактируемый пользователь '${usernameToEdit}' не найден.`);
        }
        const originalCompanyId = currentUserData.companyId;
        const originalRole = currentUserData.Role;

        // Проверка неизменности роли Owner
        if (originalRole === 'Owner' && role !== 'Owner') {
            throw new Error('Нельзя изменить роль пользователя \'Owner\'. Удалите пользователя и создайте заново с другой ролью.');
        }
        // Проверка существования компании, если выбрана для Staff
        if (role === 'Staff' && companyId && !(await firebaseService.getCompanyById(companyId))) {
             throw new Error(`Выбранная компания (ID: ${companyId}) не найдена.`);
        }
        // --- Конец валидации ---

        // Определяем ID компании для сохранения
        let assignedCompanyId = null;
        if (role === 'Staff') {
            assignedCompanyId = companyId;
        } else if (role === 'Owner') {
            assignedCompanyId = usernameToEdit; // У Owner ID компании = username
        }

        // --- Подготовка объекта обновлений для узла пользователя ---
        const userUpdates = {
            FullName: fullName,
            Email: email || '',
            Phone: phone,
            Role: role,
            companyId: assignedCompanyId
        };

        // Обновление пароля, если он введен
        if (newPassword && newPassword.trim()) {
             if (newPassword.length < 6) {
                 throw new Error('Новый пароль должен содержать не менее 6 символов.');
             }
             userUpdates.PasswordHash = await bcrypt.hash(newPassword, 10);
             // Сбрасываем флаг принудительной смены пароля, если он был установлен
             userUpdates.MustChangePassword = false; // Устанавливаем в false, чтобы снять требование
             log.info(`[POST /users/edit v5] Password updated for ${usernameToEdit}.`);
        }

        // Обновление флага companyProfileCompleted при смене роли на/с Owner
        if (role === 'Owner' && originalRole !== 'Owner') {
            // Если стал Owner'ом, профиль нужно заполнить
            userUpdates.companyProfileCompleted = false;
        } else if (role !== 'Owner' && currentUserData.hasOwnProperty('companyProfileCompleted')) {
            // Если перестал быть Owner'ом, удаляем флаг
            userUpdates.companyProfileCompleted = null;
        }

        // Обработка баланса (только для Tenant)
        if (role === 'Tenant') {
            const newBalanceValue = parseFloat(balance);
            if (isNaN(newBalanceValue)) {
                 throw new Error('Значение баланса должно быть числом.');
            }
            const currentBalance = currentUserData.Balance ?? 0;
            // Обновляем баланс и историю только если значение изменилось
            if (newBalanceValue !== currentBalance) {
                 const difference = newBalanceValue - currentBalance;
                 userUpdates.Balance = newBalanceValue;
                 // Добавляем запись в историю
                 const historyRef = db.ref(`users/${usernameToEdit}/BalanceHistory`).push();
                 const historyKey = historyRef.key;
                 if(!historyKey) {
                    log.error(`[POST /users/edit v5] Failed to generate BalanceHistory key for ${usernameToEdit}!`);
                    throw new Error("Не удалось сгенерировать ключ для истории баланса.");
                 }
                 const adminUsername = req.session.user?.username || 'Admin'; // Имя администратора для записи
                 userUpdates[`BalanceHistory/${historyKey}`] = {
                     Id: historyKey,
                     Date: new Date().toISOString(),
                     Amount: difference, // Сумма изменения
                     OperationType: "Коррекция адм.",
                     Description: `Изменение адм. ${adminUsername}. Старый баланс: ${currentBalance.toFixed(2)}`,
                     NewBalance: newBalanceValue
                 };
                 log.info(`[POST /users/edit v5] Balance updated for ${usernameToEdit} to ${newBalanceValue}. Difference: ${difference}`);
            } else {
                // Если баланс не изменился, но роль осталась Tenant, убеждаемся, что поле Balance есть
                if (!currentUserData.hasOwnProperty('Balance')) {
                    userUpdates.Balance = currentBalance; // Устанавливаем текущее значение (0), если поля не было
                }
            }
        } else {
            // Если роль НЕ Tenant, удаляем поля баланса, если они были
            if (currentUserData.hasOwnProperty('Balance')) userUpdates.Balance = null;
            if (currentUserData.hasOwnProperty('BalanceHistory')) userUpdates.BalanceHistory = null;
        }
        // --- Конец подготовки обновлений для пользователя ---

        // --- Подготовка обновлений для узла компании ---
        const companyUpdates = {};
        // 1. Если пользователь БЫЛ Staff и его роль/компания изменились -> удалить из старой компании
        if (originalRole === 'Staff' && originalCompanyId && (originalCompanyId !== assignedCompanyId || role !== 'Staff')) {
            companyUpdates[`/companies/${originalCompanyId}/staff/${usernameToEdit}`] = null;
            log.info(`[POST /users/edit v5] Prepared removal of ${usernameToEdit} from staff of company ${originalCompanyId}.`);
        }
        // 2. Если пользователь СТАЛ Staff (и не был им в этой же компании) -> добавить в новую компанию
        if (role === 'Staff' && assignedCompanyId && (originalRole !== 'Staff' || originalCompanyId !== assignedCompanyId)) {
            companyUpdates[`/companies/${assignedCompanyId}/staff/${usernameToEdit}`] = true;
            log.info(`[POST /users/edit v5] Prepared addition of ${usernameToEdit} to staff of company ${assignedCompanyId}.`);
        }
        // 3. Если пользователь СТАЛ Owner (ранее им не был) -> создать/обновить узел компании
        if (role === 'Owner' && originalRole !== 'Owner') {
            let company = await firebaseService.getCompanyById(assignedCompanyId);
            if (!company) {
                // Создаем компанию, если ее нет
                await firebaseService.createCompany(assignedCompanyId, usernameToEdit, { companyName: `${fullName} Company` });
                log.info(`[POST /users/edit v5] Created new company node ${assignedCompanyId} as user ${usernameToEdit} became Owner.`);
            } else if (company.ownerUsername !== usernameToEdit) {
                // Обновляем владельца, если компания уже есть, но владелец другой (маловероятно)
                await db.ref(`companies/${assignedCompanyId}`).update({ ownerUsername: usernameToEdit });
                log.warn(`[POST /users/edit v5] Updated owner of existing company ${assignedCompanyId} to ${usernameToEdit}.`);
            }
        }
        // --- Конец подготовки обновлений для компании ---

        // --- Атомарное обновление базы данных (пользователь + компания) ---
        const allDbUpdates = { ...companyUpdates };
        Object.keys(userUpdates).forEach(key => {
            // Формируем путь для обновления пользователя
            allDbUpdates[`/users/${usernameToEdit}/${key}`] = userUpdates[key];
        });
        await db.ref().update(allDbUpdates);
        log.info(`[POST /users/edit v5] Atomic database update successful for user ${usernameToEdit} and potentially company nodes.`);

        // --- Отправка Socket.IO уведомлений В КОМНАТУ пользователя ---
        const targetUserRoom = `user:${usernameToEdit}`;
        let companyNameForSocket = null;
        if (assignedCompanyId) {
            try {
                 // Получаем актуальное имя компании для сокета
                 companyNameForSocket = (await firebaseService.getCompanyById(assignedCompanyId))?.companyName;
            } catch(e){ log.warn(`[POST /users/edit v5] Failed to fetch company name for socket update:`, e); }
        }
        // Данные для обновления профиля на клиенте
        const profileUpdateData = {
            fullName: userUpdates.FullName,
            role: userUpdates.Role,
            companyName: companyNameForSocket, // Актуальное имя компании
            companyId: userUpdates.companyId,
            companyProfileCompleted: userUpdates.companyProfileCompleted === null ? undefined : userUpdates.companyProfileCompleted, // Передаем undefined, если null
            email: userUpdates.Email,
            phone: userUpdates.Phone
        };

        log.info(`[POST /users/edit v5] Emitting 'profile_data_updated' to room ${targetUserRoom}`);
        io.to(targetUserRoom).emit('profile_data_updated', profileUpdateData);

        // Отдельно отправляем обновление баланса, если он изменился и роль Tenant
        if (userUpdates.hasOwnProperty('Balance') && userUpdates.Role === 'Tenant') {
             log.info(`[POST /users/edit v5] Emitting 'balance_updated' to room ${targetUserRoom} with value: ${userUpdates.Balance ?? 0}`);
             io.to(targetUserRoom).emit('balance_updated', userUpdates.Balance ?? 0); // Отправляем 0, если null
        }
        // --- Конец Socket.IO ---

        req.session.message = { type: 'success', text: `Данные пользователя ${usernameToEdit} успешно обновлены.` };
        req.session.save(err => {
            if (err) log.error("[POST /users/edit v5] Session save error after update:", err);
            res.redirect('/users'); // Редирект на список пользователей
        });

    } catch (error) {
        log.error(`[POST /users/edit v5] Error updating user ${usernameToEdit}:`, error);
        req.session.message = { type: 'error', text: error.message || 'Произошла ошибка при обновлении пользователя.' };
        // Попытка рендерить форму снова с ошибкой
        try {
             const [userToRetry, companiesSnapshot] = await Promise.all([
                  firebaseService.getUserByUsername(usernameToEdit), // Получаем пользователя еще раз
                  db.ref('companies').once('value')
             ]);
             const companiesList = companiesSnapshot.val() ? Object.entries(companiesSnapshot.val()).map(([id, data]) => ({ id: id, name: data.companyName || `Компания ${id}` })) : [];
             // Собираем данные формы (включая возможно невалидные) для предзаполнения
             const userFormData = { ...(userToRetry || {}), Username: usernameToEdit, FullName: fullName, Email: email, Phone: phone, Role: role, companyId: companyId, Balance: balance };
             // Готовим аватар
             let avatarSrcRetry = '/images/placeholder-avatar.png';
             if (userFormData.ImageData) { try{let t=userFormData.ImageData.startsWith('/9j/')?'jpeg':'png'; avatarSrcRetry=`data:image/${t};base64,${userFormData.ImageData}`; } catch(e){} }
             userFormData.DisplayAvatarSrc = avatarSrcRetry;
             // Рендерим форму с ошибкой
             res.render('user-add-edit', {
                  title: `Редактировать: ${usernameToEdit}`,
                  userToEdit: userFormData, isEditMode: true,
                  availableRoles: ['Admin', 'Owner', 'Staff', 'Tenant'],
                  companiesList: companiesList,
                  // message уже в res.locals
                  localError: error.message
             });
         } catch (renderError) {
              log.error(`[POST /users/edit v5] Error rendering form after update error for ${usernameToEdit}:`, renderError);
              next(error); // Передаем исходную ошибку, если рендер тоже не удался
         }
    }
});


// POST /reset-avatar/:username (Сброс аватара) - Только для Admin
router.post('/reset-avatar/:username', isLoggedIn, isAdmin, async (req, res) => {
    const usernameToReset = req.params.username;
    const adminUsername = req.session.user?.username || 'Admin';
    const io = req.app.get('socketio'); // Получаем Socket.IO
    log.info(`[POST /users/reset-avatar v5] Admin ${adminUsername} initiating avatar reset for user: ${usernameToReset}`);
    try {
        const userRef = db.ref(`users/${usernameToReset}`);
        const snapshot = await userRef.once('value');
        const user = snapshot.val();
        // Проверка существования пользователя
        if (!user) {
            log.warn(`[POST /users/reset-avatar v5] User ${usernameToReset} not found.`);
            return res.status(404).json({ success: false, error: 'Пользователь не найден.' });
        }
        // Проверка, есть ли аватар для сброса
        if (!user.ImageData) {
            log.info(`[POST /users/reset-avatar v5] User ${usernameToReset} already has no avatar.`);
            // Возвращаем успех, но указываем, что ничего не удаляли
            return res.status(200).json({ success: true, message: `У пользователя ${usernameToReset} уже нет аватара.`, avatarRemoved: false });
        }

        // Сброс аватара (установка ImageData в null)
        await userRef.update({ ImageData: null });
        log.info(`[POST /users/reset-avatar v5] SUCCESS: Avatar reset for user ${usernameToReset}.`);

        // --- Отправка уведомления пользователю через Socket.IO В КОМНАТУ ---
        const targetUserRoom = `user:${usernameToReset}`;
        io.to(targetUserRoom).emit('avatar_updated'); // Клиент сам обновит изображение
        log.info(`[POST /users/reset-avatar v5] Emitted 'avatar_updated' notification to room ${targetUserRoom}`);
        // --- Конец Socket.IO ---

        // Отправляем успешный ответ админу
        res.status(200).json({ success: true, message: `Аватар пользователя ${usernameToReset} успешно сброшен.`, avatarRemoved: true });
    } catch (error) {
        log.error(`[POST /users/reset-avatar v5] ERROR resetting avatar for ${usernameToReset}:`, error);
        res.status(500).json({ success: false, error: error.message || 'Произошла ошибка при сбросе аватара.' });
    }
});

// POST /delete/:username (Удаление пользователя) - Только для Admin
router.post('/delete/:username', isLoggedIn, isAdmin, async (req, res, next) => {
    const usernameToDelete = req.params.username;
    const currentAdminUsername = req.session.user?.username || 'Admin';
    const io = req.app.get('socketio'); // Получаем Socket.IO
    log.info(`[POST /users/delete v5] Admin ${currentAdminUsername} initiating deletion of user: ${usernameToDelete}`);
    try {
        // Запрет удаления самого себя
        if (usernameToDelete === currentAdminUsername) {
            throw new Error('Вы не можете удалить свой собственный аккаунт.');
        }
        // Проверка существования пользователя перед удалением
        const user = await firebaseService.getUserByUsername(usernameToDelete);
        if (!user) {
             log.warn(`[POST /users/delete v5] User ${usernameToDelete} not found for deletion.`);
             throw new Error(`Пользователь '${usernameToDelete}' не найден.`);
        }

        // Вызов сервисной функции для удаления пользователя (которая также удалит его из staff)
        await firebaseService.deleteUser(usernameToDelete);
        log.info(`[POST /users/delete v5] SUCCESS: User ${usernameToDelete} deleted from database.`);

        // --- Отправка уведомления пользователю и принудительный дисконнект ---
        const targetUserRoom = `user:${usernameToDelete}`;
        // Отправляем событие, чтобы клиент мог показать сообщение перед отключением
        io.to(targetUserRoom).emit('account_deleted', { message: 'Ваш аккаунт был удален администратором.' });
        // Принудительно отключаем все сокеты в комнате этого пользователя
        io.in(targetUserRoom).disconnectSockets(true);
        log.info(`[POST /users/delete v5] Emitted 'account_deleted' and disconnected sockets in room ${targetUserRoom}`);
        // --- Конец Socket.IO ---

        // Отправляем успешный ответ админу
        res.status(200).json({ success: true, message: `Пользователь ${usernameToDelete} успешно удален.` });
    } catch (error) {
        log.error(`[POST /users/delete v5] ERROR deleting user ${usernameToDelete}:`, error);
        const statusCode = error.message.includes("не найден") ? 404 : (error.message.includes("свой") ? 403 : 400); // Определяем код ошибки
        res.status(statusCode).json({ success: false, error: error.message || 'Произошла ошибка при удалении пользователя.' });
    }
});

// POST /adjust-balance/:username (Изменение баланса) - Только для Admin
// Этот маршрут не использует транзакцию, как /profile/add-funds, т.к. админское действие считается доверенным
// и менее подвержено гонкам состояний (один админ меняет баланс одного юзера).
router.post('/adjust-balance/:username', isLoggedIn, isAdmin, async (req, res) => {
    const usernameToAdjust = req.params.username;
    const newBalanceStr = req.body.newBalance;
    const adminUsername = req.session.user?.username || 'Admin';
    const io = req.app.get('socketio');
    log.info(`[POST /users/adjust-balance v5] Admin ${adminUsername} attempting to adjust balance for ${usernameToAdjust} to ${newBalanceStr}`);

    // Парсим и валидируем новое значение баланса
    const newBalance = parseFloat(newBalanceStr);
    if (isNaN(newBalance)) {
        log.warn(`[POST /users/adjust-balance v5] Invalid balance value provided: ${newBalanceStr}`);
        return res.status(400).json({ success: false, error: 'Значение баланса должно быть числом.' });
    }

    try {
        const userRef = db.ref(`users/${usernameToAdjust}`);
        // Получаем текущие данные пользователя
        const userSnapshot = await userRef.once('value');
        const user = userSnapshot.val();

        if (!user) {
             log.warn(`[POST /users/adjust-balance v5] User ${usernameToAdjust} not found.`);
             throw new Error(`Пользователь '${usernameToAdjust}' не найден.`);
        }
        // Проверяем, что это Tenant
        if (user.Role !== 'Tenant') {
             log.warn(`[POST /users/adjust-balance v5] Attempt to adjust balance for non-tenant user ${usernameToAdjust} (Role: ${user.Role})`);
             throw new Error("Изменять баланс можно только для пользователей с ролью 'Tenant'.");
        }

        const oldBalance = user.Balance || 0;
        const difference = newBalance - oldBalance; // Разница для истории

        // Готовим объект для обновления в Firebase
        const updates = { Balance: newBalance };

        // Добавляем запись в историю, только если баланс действительно изменился
        if (difference !== 0) {
            const historyRef = userRef.child('BalanceHistory').push(); // Генерируем ключ для истории
            const newOpKey = historyRef.key;
            if(!newOpKey) {
                log.error(`[POST /users/adjust-balance v5] Failed to generate BalanceHistory key for ${usernameToAdjust}!`);
                throw new Error("Не удалось создать запись в истории баланса.");
            }
            updates[`BalanceHistory/${newOpKey}`] = {
                 Id: newOpKey,
                 Date: new Date().toISOString(),
                 Amount: difference, // Записываем сумму изменения
                 OperationType: "Коррекция адм.",
                 Description: `Изменение адм.: ${adminUsername}. Старый баланс: ${oldBalance.toFixed(2)}`,
                 NewBalance: newBalance
            };
            log.info(`[POST /users/adjust-balance v5] Balance changed for ${usernameToAdjust}. Old: ${oldBalance}, New: ${newBalance}, Diff: ${difference}. History entry prepared.`);
        } else {
            log.info(`[POST /users/adjust-balance v5] Balance for ${usernameToAdjust} is already ${newBalance}. No update needed.`);
            // Если баланс не изменился, просто возвращаем успех без обновления БД
             return res.status(200).json({ success: true, message: `Баланс пользователя ${usernameToAdjust} уже равен ${newBalance.toFixed(2)}.`, newBalance: newBalance });
        }

        // Обновляем данные пользователя в Firebase
        await userRef.update(updates);
        log.info(`[POST /users/adjust-balance v5] SUCCESS: Firebase updated for ${usernameToAdjust}. New balance: ${newBalance}`);

        // --- Отправка уведомления пользователю через Socket.IO В КОМНАТУ ---
        const targetUserRoom = `user:${usernameToAdjust}`;
        io.to(targetUserRoom).emit('balance_updated', newBalance);
        log.info(`[POST /users/adjust-balance v5] Emitted 'balance_updated' notification to room ${targetUserRoom}`);
        // --- Конец Socket.IO ---

        // Отправляем успешный ответ админу
        res.status(200).json({ success: true, message: `Баланс пользователя ${usernameToAdjust} успешно изменен.`, newBalance: newBalance });

    } catch (error) {
        log.error(`[POST /users/adjust-balance v5] ERROR adjusting balance for ${usernameToAdjust}:`, error);
        // Определяем статус код в зависимости от ошибки
        const statusCode = error.message.includes("Tenant") ? 400 : (error.message.includes("найден") ? 404 : 500);
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка сервера при изменении баланса.' });
    }
});

// POST /set-temporary-password/:username (Сброс пароля) - Только для Admin
router.post('/set-temporary-password/:username', isLoggedIn, isAdmin, async (req, res) => {
    const usernameToReset = req.params.username;
    const adminUsername = req.session.user?.username || 'Admin';
    log.info(`[POST /users/set-temporary-password v5] Admin ${adminUsername} initiating password reset for user: ${usernameToReset}`);
    try {
        // Проверка, что админ не сбрасывает свой пароль
        if (usernameToReset === adminUsername) {
             throw new Error('Вы не можете сбросить свой собственный пароль через эту функцию.');
        }
        // Проверка существования пользователя
        const user = await firebaseService.getUserByUsername(usernameToReset);
        if (!user) {
             log.warn(`[POST /users/set-temporary-password v5] User ${usernameToReset} not found.`);
             return res.status(404).json({ success: false, error: 'Пользователь не найден.' });
        }

        // Генерация временного пароля
        const tempPassword = generateTemporaryPassword(12); // Генерируем 12-значный пароль
        // Хеширование временного пароля
        const tempPasswordHash = await bcrypt.hash(tempPassword, 10);

        // Подготовка обновлений для Firebase
        const updates = {
            PasswordHash: tempPasswordHash,
            MustChangePassword: true // Устанавливаем флаг принудительной смены
        };

        // Обновление данных пользователя в Firebase
        await db.ref(`users/${usernameToReset}`).update(updates);
        log.info(`[POST /users/set-temporary-password v5] SUCCESS: Temporary password set for ${usernameToReset}. User must change it on next login.`);

        // Не отправляем пароль пользователю через сокет!
        // Отправляем успешный ответ админу, включая временный пароль
        res.status(200).json({
            success: true,
            message: `Временный пароль для ${usernameToReset} установлен. Пользователь должен будет сменить его при следующем входе.`,
            tempPassword: tempPassword // Передаем пароль админу для сообщения пользователю
        });
    } catch (error) {
        log.error(`[POST /users/set-temporary-password v5] ERROR resetting password for ${usernameToReset}:`, error);
        const statusCode = error.message.includes("свой") ? 400 : 500;
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка установки временного пароля.' });
    }
});

module.exports = router; // Экспорт роутера