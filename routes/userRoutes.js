// routes/userRoutes.js
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto'); // Оставляем, вдруг пригодится
const firebaseService = require('../services/firebaseService');
const { isLoggedIn, isAdmin } = require('../middleware/authMiddleware');
const admin = require('firebase-admin');
const db = admin.database();
const log = require('electron-log'); // Используем electron-log

const router = express.Router();

// --- Функция генерации временного пароля ---
function generateTemporaryPassword(length = 10) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
    let password = '';
    for (let i = 0; i < length; i++) { password += characters.charAt(Math.floor(Math.random() * characters.length)); }
    if (!/\d/.test(password) || !/[a-zA-Z]/.test(password)) { return generateTemporaryPassword(length); }
    return password;
}

// =======================================
// === GET МАРШРУТЫ (Рендеринг страниц) ===
// =======================================

// GET / (Список пользователей)
router.get('/', isLoggedIn, isAdmin, async (req, res, next) => {
    log.info("[GET /users v5 - Rooms] Accessing user list route.");
    try {
        const users = await firebaseService.getAllUsers();
        const validUsers = Array.isArray(users) ? users : [];
        const usersWithAvatars = validUsers.filter(Boolean).map(user => {
            let avatarSrc = '/images/placeholder-avatar.png';
            if (user.ImageData && typeof user.ImageData === 'string') {
                 // Добавляем проверку размера Base64 перед созданием data URI
                 if (user.ImageData.length < 2 * 1024 * 1024) { // ~2MB лимит для data URI
                    try { let t=user.ImageData.startsWith('/9j/')?'jpeg':'png'; avatarSrc=`data:image/${t};base64,${user.ImageData}`; } catch(e){}
                 } else {
                    log.warn(`[GET /users] Avatar for ${user.Username} skipped in list preview due to large size.`);
                 }
            }
            if (!user.Username) return null;
            return { ...user, DisplayAvatarSrc: avatarSrc };
        }).filter(Boolean);
        const message = req.session.message || null; if(req.session.message) delete req.session.message;
        res.render('users-list', { title: 'Управление пользователями', users: usersWithAvatars, message: message });
    } catch (error) { log.error("[GET /users v5] Error:", error); next(error); }
});

// GET /add (Форма добавления)
router.get('/add', isLoggedIn, isAdmin, async (req, res, next) => {
    log.info("[GET /users/add v5 - Rooms] Accessing add user form route.");
    const message = req.session.message || null; if(req.session.message) delete req.session.message;
    try {
         const companiesSnapshot = await db.ref('companies').once('value');
         const companiesData = companiesSnapshot.val();
         const companiesList = companiesData ? Object.entries(companiesData).map(([id, data]) => ({ id: id, name: data?.companyName || id })) : []; // Добавил проверку data.companyName
        res.render('user-add-edit', { title: 'Добавить пользователя', userToEdit: {}, isEditMode: false, availableRoles: ['Admin', 'Owner', 'Staff', 'Tenant'], companiesList: companiesList, message: message });
    } catch(error) {
        log.error("[GET /users/add v5] Error fetching companies:", error);
         res.render('user-add-edit', { title: 'Добавить пользователя', userToEdit: {}, isEditMode: false, availableRoles: ['Admin', 'Owner', 'Staff', 'Tenant'], companiesList: [], message: message, localError: "Не удалось загрузить список компаний." });
    }
});

// GET /edit/:username (Форма редактирования)
router.get('/edit/:username', isLoggedIn, isAdmin, async (req, res, next) => {
    const usernameToEdit = req.params.username;
    log.info(`[GET /users/edit v5 - Rooms] Accessing edit form for: ${usernameToEdit}`);
    try {
        const [user, companiesSnapshot] = await Promise.all([
             firebaseService.getUserByUsername(usernameToEdit),
             db.ref('companies').orderByKey().once('value') // Сортируем для предсказуемого порядка
        ]);
        if (!user) { req.session.message = { type: 'error', text: `Пользователь ${usernameToEdit} не найден.` }; return req.session.save(err => res.redirect('/users')); }

        const companiesData = companiesSnapshot.val();
        const companiesList = companiesData ? Object.entries(companiesData).map(([id, data]) => ({ id: id, name: data?.companyName || id })).sort((a, b) => a.name.localeCompare(b.name)) : []; // Сортируем список

        let avatarSrc = '/images/placeholder-avatar.png';
        if (user.ImageData && typeof user.ImageData === 'string') {
            if (user.ImageData.length < 2 * 1024 * 1024) { // Лимит для data URI
                try{ let t=user.ImageData.startsWith('/9j/')?'jpeg':'png'; avatarSrc=`data:image/${t};base64,${user.ImageData}`; } catch(e){}
            } else {
                log.warn(`[GET /users/edit] Avatar for ${user.Username} skipped in edit form preview due to large size.`);
            }
        }
        const message = req.session.message || null; if (req.session.message) delete req.session.message;
        res.render('user-add-edit', { title: `Редактировать: ${user.Username}`, userToEdit: { ...user, DisplayAvatarSrc: avatarSrc }, isEditMode: true, availableRoles: ['Admin', 'Owner', 'Staff', 'Tenant'], companiesList: companiesList, message: message });
    } catch (error) { log.error(`[GET /users/edit v5] Error for ${usernameToEdit}:`, error); next(error); }
});

// =======================================
// === POST МАРШРУТЫ (Обработка данных) ===
// =======================================

// POST /add (Добавление пользователя)
router.post('/add', isLoggedIn, isAdmin, async (req, res, next) => {
    const { username, password, fullName, email, phone, role, companyId } = req.body;
    const usernameKey = username?.trim();
    log.info(`[POST /users/add v5 - Rooms] Attempting to add user: ${usernameKey}`);
    try {
        // Валидация...
        if (!usernameKey || !password || !fullName || !phone || !role) { throw new Error('Заполните Логин, Пароль, ФИО, Телефон и Роль.'); }
        if (!['Admin', 'Owner', 'Staff', 'Tenant'].includes(role)) { throw new Error('Недопустимая роль.'); }
        if (password.length < 6) { throw new Error('Пароль < 6 симв.'); }
        if (await firebaseService.getUserByUsername(usernameKey)) { throw new Error(`Логин '${usernameKey}' занят.`); }

        let assignedCompanyId = null;
        if (role === 'Staff') {
            if (!companyId) throw new Error("Для 'Staff' выберите компанию.");
            const companyExists = await firebaseService.getCompanyById(companyId);
            if (!companyExists) throw new Error(`Компания ${companyId} не найдена.`);
            assignedCompanyId = companyId;
        } else if (role === 'Owner') {
             assignedCompanyId = usernameKey; // ID компании = логин Owner'а
             // Проверяем, нет ли уже компании с таким ID
             if (await firebaseService.getCompanyById(assignedCompanyId)) {
                 throw new Error(`Компания с ID '${assignedCompanyId}' (логин владельца) уже существует. Выберите другой логин.`);
             }
         }

        const saltRounds = 10; const passwordHash = await bcrypt.hash(password, saltRounds);
        const newUser = {
             Username: usernameKey, PasswordHash: passwordHash, FullName: fullName, Email: email || '', Phone: phone, Role: role,
             ImageData: null, MustChangePassword: false, companyId: assignedCompanyId,
             ...(role === 'Owner' && { companyProfileCompleted: false }),
             ...(role === 'Tenant' && { Balance: 0, BalanceHistory: {} })
        };
        // Удаляем ключи с undefined значениями перед сохранением
        Object.keys(newUser).forEach(key => newUser[key] === undefined && delete newUser[key]);

        await firebaseService.saveUser({ ...newUser, username: usernameKey }); // Сохраняем пользователя

        // Создаем компанию или добавляем в staff
        if (role === 'Owner') {
             await firebaseService.createCompany(assignedCompanyId, usernameKey, { companyName: `${fullName} Company` });
             log.info(`[POST /users/add v5] Company ${assignedCompanyId} created for new Owner ${usernameKey}.`);
        } else if (role === 'Staff') {
             await db.ref(`companies/${assignedCompanyId}/staff/${usernameKey}`).set(true);
             log.info(`[POST /users/add v5] User ${usernameKey} added to staff of company ${assignedCompanyId}.`);
        }

        log.info(`[POST /users/add v5] User ${usernameKey} added successfully.`);
        req.session.message = { type: 'success', text: `Пользователь ${usernameKey} (${role}) добавлен!` };
        req.session.save(err => res.redirect('/users'));

    } catch (error) {
        log.error("[POST /users/add v5] Error adding user:", error);
        req.session.message = { type: 'error', text: error.message || 'Ошибка добавления.' };
        try { // Попытка рендера формы с ошибкой
            const companiesSnapshot = await db.ref('companies').orderByChild('companyName').once('value');
            const companiesList = companiesSnapshot.val() ? Object.entries(companiesSnapshot.val()).map(([id, data]) => ({ id: id, name: data?.companyName || id })).sort((a,b) => a.name.localeCompare(b.name)) : [];
            const userFormData = { Username: username, FullName: fullName, Email: email, Phone: phone, Role: role, companyId: companyId };
            res.render('user-add-edit', { title: 'Добавить пользователя', userToEdit: userFormData, isEditMode: false, availableRoles: ['Admin', 'Owner', 'Staff', 'Tenant'], companiesList: companiesList, message: req.session.message });
            if (req.session.message) delete req.session.message;
        } catch (renderError) { log.error("[POST /users/add v5] Error rendering form after error:", renderError); next(error); } // Передаем исходную ошибку
    }
});


// POST /edit/:username (Редактирование пользователя)
router.post('/edit/:username', isLoggedIn, isAdmin, async (req, res, next) => {
    const usernameToEdit = req.params.username;
    const { fullName, email, phone, role, companyId, newPassword, balance } = req.body;
    const io = req.app.get('socketio'); // Получаем io из app
    const adminUsername = req.session.user?.username || 'Admin';
    log.info(`[POST /users/edit v5 - Rooms] Admin ${adminUsername} attempting update for ${usernameToEdit}.`);
    try {
        // Валидация...
        if (!usernameToEdit || !fullName || !phone || !role) { throw new Error('Заполните ФИО, Телефон, Роль.'); }
        if (!['Admin', 'Owner', 'Staff', 'Tenant'].includes(role)) { throw new Error('Недопустимая роль.'); }

        const currentUserData = await firebaseService.getUserByUsername(usernameToEdit);
        if (!currentUserData) { throw new Error('Редактируемый пользователь не найден.'); }
        const originalCompanyId = currentUserData.companyId;
        const originalRole = currentUserData.Role;

        // Запрет на смену роли Owner
        if (originalRole === 'Owner' && role !== 'Owner') {
             throw new Error('Нельзя изменить роль \'Owner\'. Компании привязаны к их ID (логину Owner\'а).');
        }

        let assignedCompanyId = null;
        if (role === 'Staff') {
            if (!companyId) throw new Error("Для роли 'Staff' необходимо выбрать компанию.");
            if (!(await firebaseService.getCompanyById(companyId))) throw new Error(`Выбранная компания ${companyId} не найдена.`);
            assignedCompanyId = companyId;
        } else if (role === 'Owner') {
             assignedCompanyId = usernameToEdit; // ID компании совпадает с логином Owner'а
             // Если пользователь НЕ БЫЛ Owner'ом, но становится им, нужно создать компанию
             if (originalRole !== 'Owner') {
                 if (!(await firebaseService.getCompanyById(assignedCompanyId))) {
                     log.info(`[POST /users/edit v5] Creating company ${assignedCompanyId} for new Owner ${usernameToEdit}.`);
                     await firebaseService.createCompany(assignedCompanyId, usernameToEdit, { companyName: `${fullName} Company` });
                 } else {
                      // Если компания уже есть (маловероятно, но возможно), просто убедимся, что ownerUsername правильный
                      const companyData = await firebaseService.getCompanyById(assignedCompanyId);
                      if (companyData.ownerUsername !== usernameToEdit) {
                          log.warn(`[POST /users/edit v5] Company ${assignedCompanyId} exists but has different owner (${companyData.ownerUsername}). Updating owner to ${usernameToEdit}.`);
                          await db.ref(`companies/${assignedCompanyId}`).update({ ownerUsername: usernameToEdit });
                      }
                 }
             }
        }
        // Для Admin и Tenant companyId всегда null
        else { assignedCompanyId = null; }


        // --- Подготовка обновлений пользователя ---
        const userUpdates = {
             FullName: fullName,
             Email: email || '', // Пустая строка, если не указан
             Phone: phone,
             Role: role,
             companyId: assignedCompanyId, // null для Admin/Tenant, ID для Staff/Owner
             MustChangePassword: currentUserData.MustChangePassword // Сохраняем текущее значение по умолчанию
        };

        // Обновление пароля, если введен новый
        if (newPassword?.trim()) {
             if (newPassword.length < 6) { throw new Error('Новый пароль должен быть не менее 6 символов.'); }
             userUpdates.PasswordHash = await bcrypt.hash(newPassword.trim(), 10);
             userUpdates.MustChangePassword = false; // Сбрасываем флаг при установке нового пароля
             log.info(`[POST /users/edit v5] Password updated for ${usernameToEdit}.`);
        }

        // Управление флагом companyProfileCompleted
        if (role === 'Owner' && originalRole !== 'Owner') {
             userUpdates.companyProfileCompleted = false; // Новый Owner начинает с незавершенным профилем
        } else if (role !== 'Owner' && currentUserData.hasOwnProperty('companyProfileCompleted')) {
             userUpdates.companyProfileCompleted = null; // Удаляем флаг, если роль больше не Owner
        }

        // Управление балансом (только для Tenant)
        if (role === 'Tenant') {
            const newBalanceValue = parseFloat(balance);
            if (isNaN(newBalanceValue)) { throw new Error('Баланс должен быть числом.'); }
            const currentBalance = currentUserData.Balance ?? 0; // Текущий баланс или 0
            // Обновляем только если значение изменилось ИЛИ если поля Balance раньше не было
            if (newBalanceValue !== currentBalance || !currentUserData.hasOwnProperty('Balance')) {
                 const difference = newBalanceValue - currentBalance;
                 userUpdates.Balance = newBalanceValue;
                 log.info(`[POST /users/edit v5] Balance updated for Tenant ${usernameToEdit} to ${newBalanceValue}. Difference: ${difference}`);
                 // Добавляем запись в историю только если было изменение
                 if (difference !== 0) {
                     const historyRef = db.ref(`users/${usernameToEdit}/BalanceHistory`).push();
                     const historyKey = historyRef.key;
                     if(!historyKey) { log.error("Failed to generate BalanceHistory key!"); throw new Error("Internal error generating history key."); } // Более строгая проверка
                     // Добавляем запись в userUpdates, чтобы она применилась в той же транзакции
                     userUpdates[`BalanceHistory/${historyKey}`] = {
                         Id: historyKey,
                         Date: new Date().toISOString(),
                         Amount: difference,
                         OperationType: "Коррекция адм.",
                         Description: `Изм. адм. ${adminUsername}. Старый: ${currentBalance.toFixed(2)}`,
                         NewBalance: newBalanceValue
                     };
                 }
            }
        } else {
             // Если роль не Tenant, удаляем поля баланса из БД (если они там были)
             if (currentUserData.hasOwnProperty('Balance')) userUpdates.Balance = null;
             if (currentUserData.hasOwnProperty('BalanceHistory')) userUpdates.BalanceHistory = null;
        }

        // --- Подготовка обновлений для компаний (связи со Staff) ---
        const companyUpdates = {};
        // Если пользователь БЫЛ Staff и его роль меняется ИЛИ меняется компания
        if (originalRole === 'Staff' && originalCompanyId && (originalCompanyId !== assignedCompanyId || role !== 'Staff')) {
            log.info(`[POST /users/edit v5] Removing ${usernameToEdit} from staff of ${originalCompanyId}.`);
            companyUpdates[`/companies/${originalCompanyId}/staff/${usernameToEdit}`] = null; // Удаляем из старой компании
        }
        // Если пользователь СТАЛ Staff (и не был им раньше ИЛИ был в другой компании)
        if (role === 'Staff' && assignedCompanyId && (originalRole !== 'Staff' || originalCompanyId !== assignedCompanyId)) {
            log.info(`[POST /users/edit v5] Adding ${usernameToEdit} to staff of ${assignedCompanyId}.`);
            companyUpdates[`/companies/${assignedCompanyId}/staff/${usernameToEdit}`] = true; // Добавляем в новую
        }
        // Если пользователь был Owner и его удаляют (хотя мы это запретили выше, но на всякий случай)
        // или если стал Owner и нужно обновить ownerUsername в существующей компании (тоже маловероятно)
        // ... (здесь можно добавить логику, если потребуется)

        // --- Атомарное обновление БД ---
        const allDbUpdates = { ...companyUpdates }; // Начинаем с обновлений компаний
        // Добавляем обновления пользователя, правильно формируя пути
        Object.keys(userUpdates).forEach(key => {
            // Обрабатываем вложенный путь для BalanceHistory
            if (key.startsWith('BalanceHistory/')) {
                 allDbUpdates[`/users/${usernameToEdit}/${key}`] = userUpdates[key];
            } else {
                 allDbUpdates[`/users/${usernameToEdit}/${key}`] = userUpdates[key];
            }
        });
        // Удаляем companyProfileCompleted, если его значение null (удаление поля)
        if (allDbUpdates[`/users/${usernameToEdit}/companyProfileCompleted`] === null) {
             delete allDbUpdates[`/users/${usernameToEdit}/companyProfileCompleted`]; // Удаляем ключ, чтобы Firebase удалил поле
             allDbUpdates[`/users/${usernameToEdit}/companyProfileCompleted`] = null; // Явно ставим null для удаления
        }
         // Удаляем Balance и BalanceHistory, если их значение null
         if (allDbUpdates[`/users/${usernameToEdit}/Balance`] === null) {
              delete allDbUpdates[`/users/${usernameToEdit}/Balance`];
              allDbUpdates[`/users/${usernameToEdit}/Balance`] = null;
         }
          if (allDbUpdates[`/users/${usernameToEdit}/BalanceHistory`] === null) {
              delete allDbUpdates[`/users/${usernameToEdit}/BalanceHistory`];
              allDbUpdates[`/users/${usernameToEdit}/BalanceHistory`] = null;
          }


        await db.ref().update(allDbUpdates);
        log.info(`[POST /users/edit v5] Database updated successfully for ${usernameToEdit}.`);

        // --- Отправка Socket.IO Уведомлений В КОМНАТУ ---
        const targetUserRoom = `user:${usernameToEdit}`;
        log.info(`[POST /users/edit v5] Preparing to emit updates to room ${targetUserRoom}`);

        // 1. Обновление основных данных профиля
        let companyNameForSocket = null;
        if(assignedCompanyId && (role === 'Owner' || role === 'Staff')){
            try { companyNameForSocket = (await firebaseService.getCompanyById(assignedCompanyId))?.companyName; }
            catch(e){ log.warn(`[Socket Emit] Could not fetch company name for ${assignedCompanyId}: ${e.message}`); }
        }
        const profileUpdateData = {
            fullName: userUpdates.FullName,
            role: userUpdates.Role,
            companyName: companyNameForSocket, // null если не Owner/Staff или не найдена
            companyId: userUpdates.companyId, // null если не Owner/Staff
            companyProfileCompleted: userUpdates.companyProfileCompleted === null ? undefined : userUpdates.companyProfileCompleted, // undefined чтобы не обновлять если null
            email: userUpdates.Email,
            phone: userUpdates.Phone
        };
        // Удаляем undefined ключи перед отправкой
        Object.keys(profileUpdateData).forEach(key => profileUpdateData[key] === undefined && delete profileUpdateData[key]);

        log.info(`[Socket Emit] Emitting 'profile_data_updated' to room ${targetUserRoom} with data:`, profileUpdateData);
        io.to(targetUserRoom).emit('profile_data_updated', profileUpdateData);

        // 2. Обновление баланса (если изменился и роль Tenant)
        if (userUpdates.Balance !== undefined && userUpdates.Role === 'Tenant' && userUpdates.Balance !== (currentUserData.Balance ?? 0)) {
             const newBalance = userUpdates.Balance === null ? 0 : userUpdates.Balance;
             log.info(`[Socket Emit] Emitting 'balance_updated' to room ${targetUserRoom} with new balance: ${newBalance}`);
             io.to(targetUserRoom).emit('balance_updated', newBalance);
        }

        // 3. Уведомление о сбросе пароля (если был сброшен)
        if (userUpdates.PasswordHash && userUpdates.MustChangePassword === false) { // Условие может быть другим, если MustChangePassword ставится отдельно
            log.info(`[Socket Emit] Emitting 'password_reset_notification' to room ${targetUserRoom}`);
             io.to(targetUserRoom).emit('password_reset_notification', { message: 'Ваш пароль был изменен администратором.' });
        }
        // --- КОНЕЦ Socket.IO ---

        req.session.message = { type: 'success', text: `Данные пользователя ${usernameToEdit} успешно обновлены.` };
        req.session.save(err => {
            if (err) log.error(`[POST /users/edit v5] Session save error for ${usernameToEdit}:`, err);
            res.redirect('/users'); // Редирект на список пользователей
        });

    } catch (error) {
        log.error(`[POST /users/edit v5] Error updating user ${usernameToEdit}:`, error);
        req.session.message = { type: 'error', text: error.message || 'Ошибка обновления.' };
        try { // Попытка рендера формы с ошибкой
             // Перезагружаем данные, чтобы показать актуальное состояние после неудачной попытки
             const [userToRetry, companiesSnapshot] = await Promise.all([
                 firebaseService.getUserByUsername(usernameToEdit), // Получаем актуальные данные
                 db.ref('companies').orderByChild('companyName').once('value')
             ]);
             const companiesList = companiesSnapshot.val() ? Object.entries(companiesSnapshot.val()).map(([id, data]) => ({ id: id, name: data?.companyName || id })).sort((a,b) => a.name.localeCompare(b.name)) : [];
             // Заполняем userFormData ИЗНАЧАЛЬНЫМИ ДАННЫМИ ИЗ БД (userToRetry), а не тем, что пришло в req.body,
             // чтобы пользователь видел, что не сохранилось.
             const userFormData = { ...(userToRetry || {}), Username: usernameToEdit }; // Используем userToRetry
             let avatarSrcRetry = '/images/placeholder-avatar.png';
             if (userFormData.ImageData) { if(userFormData.ImageData.length < 2*1024*1024){try{let t=userFormData.ImageData.startsWith('/9j/')?'jpeg':'png'; avatarSrcRetry=`data:image/${t};base64,${userFormData.ImageData}`; } catch(e){}} }
             userFormData.DisplayAvatarSrc = avatarSrcRetry;
             // Сообщение об ошибке уже установлено выше
             res.render('user-add-edit', { title: `Редактировать: ${usernameToEdit}`, userToEdit: userFormData, isEditMode: true, availableRoles: ['Admin', 'Owner', 'Staff', 'Tenant'], companiesList: companiesList, message: req.session.message });
             if (req.session.message) delete req.session.message; // Очищаем после показа
         } catch (renderError) {
             log.error(`[POST /users/edit v5] Error rendering form after error for ${usernameToEdit}:`, renderError);
             next(error); // Передаем исходную ошибку дальше
         }
    }
});


// POST /reset-avatar/:username (Сброс аватара)
router.post('/reset-avatar/:username', isLoggedIn, isAdmin, async (req, res) => {
    const usernameToReset = req.params.username;
    const adminUsername = req.session.user?.username || 'Admin';
    const io = req.app.get('socketio'); // Получаем io
    log.info(`[POST /users/reset-avatar v5 - Rooms] START: Admin ${adminUsername} reset for ${usernameToReset}`);
    try {
        const userRef = db.ref(`users/${usernameToReset}`);
        const snapshot = await userRef.once('value');
        if (!snapshot.exists()) { return res.status(404).json({ success: false, error: 'Пользователь не найден.' }); }
        const user = snapshot.val();
        if (!user.ImageData) { return res.status(200).json({ success: true, message: 'У пользователя уже нет аватара.', avatarRemoved: false }); }

        await userRef.update({ ImageData: null });
        log.info(`[POST /users/reset-avatar v5] SUCCESS: Avatar reset for ${usernameToReset}`);

        // *** ОТПРАВКА В КОМНАТУ ***
        const targetUserRoom = `user:${usernameToReset}`;
        log.info(`[Socket Emit] Emitting 'avatar_updated' to room ${targetUserRoom} after reset.`);
        io.to(targetUserRoom).emit('avatar_updated'); // Отправляем сигнал для обновления UI клиента
        // *** КОНЕЦ ОТПРАВКИ ***

        res.status(200).json({ success: true, message: `Аватар пользователя ${usernameToReset} сброшен.`, avatarRemoved: true });
    } catch (error) {
        log.error(`[POST /users/reset-avatar v5] ERROR for ${usernameToReset}:`, error);
        res.status(500).json({ success: false, error: error.message || 'Ошибка сброса аватара.' });
    }
});


// POST /delete/:username (Удаление пользователя)
router.post('/delete/:username', isLoggedIn, isAdmin, async (req, res, next) => {
    const usernameToDelete = req.params.username;
    const currentAdminUsername = req.session.user?.username || 'Admin';
    const io = req.app.get('socketio'); // Получаем io
    log.info(`[POST /users/delete v5 - Rooms] START: Admin ${currentAdminUsername} deleting ${usernameToDelete}`);
    try {
        if (usernameToDelete === currentAdminUsername) { throw new Error('Нельзя удалить свой аккаунт.'); }
        const user = await firebaseService.getUserByUsername(usernameToDelete);
        if (!user) { throw new Error('Пользователь не найден.'); }

        await firebaseService.deleteUser(usernameToDelete); // Эта функция должна также удалять из staff компании
        log.info(`[POST /users/delete v5] SUCCESS: User ${usernameToDelete} deleted from DB.`);

        // *** ОТПРАВКА В КОМНАТУ И ДИСКОННЕКТ ***
        const targetUserRoom = `user:${usernameToDelete}`;
        log.info(`[Socket Emit] Emitting 'account_deleted' to room ${targetUserRoom}`);
        io.to(targetUserRoom).emit('account_deleted', { message: 'Ваш аккаунт был удален администратором.' });
        // Даем небольшую задержку перед дисконнектом, чтобы сообщение успело дойти
        setTimeout(() => {
            log.info(`[Socket Disconnect] Disconnecting sockets in room ${targetUserRoom}`);
            io.in(targetUserRoom).disconnectSockets(true); // Отключаем все сокеты в комнате
        }, 500);
        // *** КОНЕЦ ОТПРАВКИ ***

        res.status(200).json({ success: true, message: `Пользователь ${usernameToDelete} удален.` });
    } catch (error) {
        log.error(`[POST /users/delete v5] ERROR deleting ${usernameToDelete}:`, error);
        const statusCode = error.message.includes("не найден") ? 404 : (error.message.includes("свой") ? 403 : 400);
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка удаления.' });
    }
});

// POST /adjust-balance/:username (Изменение баланса)
router.post('/adjust-balance/:username', isLoggedIn, isAdmin, async (req, res) => {
    const usernameToAdjust = req.params.username;
    const newBalanceStr = req.body.newBalance;
    const adminUsername = req.session.user?.username || 'Admin';
    const io = req.app.get('socketio'); // Получаем io
    log.info(`[POST /users/adjust-balance v5 - Rooms] START: Admin ${adminUsername} adjust for ${usernameToAdjust} to ${newBalanceStr}`);

    const newBalance = parseFloat(newBalanceStr);
    if (isNaN(newBalance)) { return res.status(400).json({ success: false, error: 'Баланс должен быть числом.' }); }

    try {
        const userRef = db.ref(`users/${usernameToAdjust}`);
        const userSnapshot = await userRef.once('value');
        if (!userSnapshot.exists()) { throw new Error(`Пользователь '${usernameToAdjust}' не найден.`); }
        const user = userSnapshot.val();
        if (user.Role !== 'Tenant') { throw new Error("Изменять баланс можно только для 'Tenant'."); }

        const oldBalance = user.Balance || 0;
        const difference = newBalance - oldBalance;
        const updates = {};
        updates['Balance'] = newBalance; // Обновляем баланс

        // Добавляем запись в историю, только если баланс изменился
        if (difference !== 0) {
            const historyRef = userRef.child('BalanceHistory').push();
            const newOpKey = historyRef.key;
            if(!newOpKey) throw new Error("Failed history key gen on adjust");
            updates[`BalanceHistory/${newOpKey}`] = {
                Id: newOpKey,
                Date: new Date().toISOString(),
                Amount: difference,
                OperationType: "Коррекция адм.",
                Description: `Изм. адм.: ${adminUsername}. Старый: ${oldBalance.toFixed(2)}`,
                NewBalance: newBalance
            };
            log.info(`[POST /users/adjust-balance v5] Balance history entry added for ${usernameToAdjust}.`);
        } else {
             log.info(`[POST /users/adjust-balance v5] Balance for ${usernameToAdjust} not changed. Skipping history entry.`);
        }

        await userRef.update(updates);
        log.info(`[POST /users/adjust-balance v5] SUCCESS: Update successful for ${usernameToAdjust}. New balance: ${newBalance}`);

        // *** ОТПРАВКА В КОМНАТУ ***
        const targetUserRoom = `user:${usernameToAdjust}`;
        log.info(`[Socket Emit] Emitting 'balance_updated' to room ${targetUserRoom} with new balance: ${newBalance}`);
        io.to(targetUserRoom).emit('balance_updated', newBalance);
        // *** КОНЕЦ ОТПРАВКИ ***

        res.status(200).json({ success: true, message: 'Баланс успешно изменен.', newBalance: newBalance });

    } catch (error) {
        log.error(`[POST /users/adjust-balance v5] ERROR for ${usernameToAdjust}:`, error);
        const statusCode = error.message.includes("Tenant") ? 400 : (error.message.includes("найден") ? 404 : 500);
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка сервера при изменении баланса.' });
    }
});

// POST /set-temporary-password/:username (Сброс пароля)
router.post('/set-temporary-password/:username', isLoggedIn, isAdmin, async (req, res) => {
    const usernameToReset = req.params.username;
    const adminUsername = req.session.user?.username || 'Admin';
    const io = req.app.get('socketio'); // Получаем io
    log.info(`[POST /users/set-temporary-password v5 - Rooms] START: Admin ${adminUsername} for ${usernameToReset}`);
    try {
        const user = await firebaseService.getUserByUsername(usernameToReset);
        if (!user) { return res.status(404).json({ success: false, error: 'Пользователь не найден.' }); }
        if (usernameToReset === adminUsername) { return res.status(400).json({ success: false, error: 'Нельзя сбросить свой пароль.' }); }

        const tempPassword = generateTemporaryPassword(12);
        const tempPasswordHash = await bcrypt.hash(tempPassword, 10);
        const updates = { PasswordHash: tempPasswordHash, MustChangePassword: true }; // Устанавливаем флаг
        await db.ref(`users/${usernameToReset}`).update(updates);
        log.info(`[POST /users/set-temporary-password v5] SUCCESS for ${usernameToReset}. Flag 'MustChangePassword' set to true.`);

        // *** ОТПРАВКА УВЕДОМЛЕНИЯ В КОМНАТУ ***
        const targetUserRoom = `user:${usernameToReset}`;
        log.info(`[Socket Emit] Emitting 'password_reset_notification' to room ${targetUserRoom}`);
        io.to(targetUserRoom).emit('password_reset_notification', { message: 'Ваш пароль был сброшен администратором. Вам потребуется сменить его при следующем входе.' });
        // *** КОНЕЦ ОТПРАВКИ ***

        // Возвращаем пароль админу в ответе
        res.status(200).json({ success: true, message: `Временный пароль для ${usernameToReset} установлен. Сообщите его пользователю.`, tempPassword: tempPassword });
    } catch (error) {
        log.error(`[POST /users/set-temporary-password v5] ERROR for ${usernameToReset}:`, error);
        res.status(500).json({ success: false, error: error.message || 'Ошибка установки временного пароля.' });
    }
});

module.exports = router; // Экспорт