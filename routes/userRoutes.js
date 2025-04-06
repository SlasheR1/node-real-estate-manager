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
    log.info("[GET /users v5 - Rooms] Accessing user list route."); // Версия лога
    try {
        const users = await firebaseService.getAllUsers();
        const validUsers = Array.isArray(users) ? users : [];
        const usersWithAvatars = validUsers.filter(Boolean).map(user => {
            let avatarSrc = '/images/placeholder-avatar.png';
            if (user.ImageData && typeof user.ImageData === 'string') { try { let t=user.ImageData.startsWith('/9j/')?'jpeg':'png'; avatarSrc=`data:image/${t};base64,${user.ImageData}`; } catch(e){} }
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
         const companiesList = companiesData ? Object.entries(companiesData).map(([id, data]) => ({ id: id, name: data.companyName })) : [];
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
        const [user, companiesSnapshot] = await Promise.all([ firebaseService.getUserByUsername(usernameToEdit), db.ref('companies').once('value') ]);
        if (!user) { req.session.message = { type: 'error', text: `Пользователь ${usernameToEdit} не найден.` }; return req.session.save(err => res.redirect('/users')); }
        const companiesData = companiesSnapshot.val();
        const companiesList = companiesData ? Object.entries(companiesData).map(([id, data]) => ({ id: id, name: data.companyName })) : [];
        let avatarSrc = '/images/placeholder-avatar.png';
        if (user.ImageData && typeof user.ImageData === 'string') { try{ let t=user.ImageData.startsWith('/9j/')?'jpeg':'png'; avatarSrc=`data:image/${t};base64,${user.ImageData}`; } catch(e){} }
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
            if (!(await firebaseService.getCompanyById(companyId))) throw new Error(`Компания ${companyId} не найдена.`);
            assignedCompanyId = companyId;
        } else if (role === 'Owner') { assignedCompanyId = usernameKey; }

        const saltRounds = 10; const passwordHash = await bcrypt.hash(password, saltRounds);
        const newUser = {
             Username: usernameKey, PasswordHash: passwordHash, FullName: fullName, Email: email || '', Phone: phone, Role: role,
             ImageData: null, MustChangePassword: false, companyId: assignedCompanyId,
             ...(role === 'Owner' && { companyProfileCompleted: false }),
             ...(role === 'Tenant' && { Balance: 0, BalanceHistory: {} })
        };
        Object.keys(newUser).forEach(key => newUser[key] === undefined && delete newUser[key]);
        await firebaseService.saveUser({ ...newUser, username: usernameKey });

        if (role === 'Owner') { await firebaseService.createCompany(assignedCompanyId, usernameKey, { companyName: `${fullName} Company` }); }
        else if (role === 'Staff') { await db.ref(`companies/${assignedCompanyId}/staff/${usernameKey}`).set(true); }

        log.info(`[POST /users/add v5] User ${usernameKey} added successfully.`);
        req.session.message = { type: 'success', text: `Пользователь ${usernameKey} (${role}) добавлен!` };
        req.session.save(err => res.redirect('/users'));

    } catch (error) {
        log.error("[POST /users/add v5] Error adding user:", error);
        req.session.message = { type: 'error', text: error.message || 'Ошибка добавления.' };
        try { // Попытка рендера формы с ошибкой
            const companiesSnapshot = await db.ref('companies').once('value');
            const companiesList = companiesSnapshot.val() ? Object.entries(companiesSnapshot.val()).map(([id, data]) => ({ id: id, name: data.companyName })) : [];
            const userFormData = { Username: username, FullName: fullName, Email: email, Phone: phone, Role: role, companyId: companyId };
            res.render('user-add-edit', { title: 'Добавить пользователя', userToEdit: userFormData, isEditMode: false, availableRoles: ['Admin', 'Owner', 'Staff', 'Tenant'], companiesList: companiesList, message: req.session.message });
            if (req.session.message) delete req.session.message;
        } catch (renderError) { next(error); }
    }
});


// POST /edit/:username (Редактирование пользователя)
router.post('/edit/:username', isLoggedIn, isAdmin, async (req, res, next) => {
    const usernameToEdit = req.params.username;
    const { fullName, email, phone, role, companyId, newPassword, balance } = req.body;
    const io = req.app.get('socketio');
    log.info(`[POST /users/edit v5 - Rooms] Attempt update for ${usernameToEdit}.`);
    try {
        // Валидация...
        if (!usernameToEdit || !fullName || !phone || !role) { throw new Error('Заполните ФИО, Телефон, Роль.'); }
        if (!['Admin', 'Owner', 'Staff', 'Tenant'].includes(role)) { throw new Error('Недопустимая роль.'); }
        if (role === 'Staff' && !companyId) { throw new Error("Для 'Staff' выберите компанию."); }

        const currentUserData = await firebaseService.getUserByUsername(usernameToEdit);
        if (!currentUserData) { throw new Error('Редактируемый пользователь не найден.'); }
        const originalCompanyId = currentUserData.companyId;
        const originalRole = currentUserData.Role;
        if (originalRole === 'Owner' && role !== 'Owner') { throw new Error('Нельзя изменить роль Owner.'); }

        let assignedCompanyId = null;
        if (role === 'Staff') {
            if (!(await firebaseService.getCompanyById(companyId))) throw new Error(`Компания ${companyId} не найдена.`);
            assignedCompanyId = companyId;
        } else if (role === 'Owner') { assignedCompanyId = usernameToEdit; }

        // --- Подготовка обновлений ---
        const userUpdates = { FullName: fullName, Email: email || '', Phone: phone, Role: role, companyId: assignedCompanyId };
        if (newPassword?.trim()) {
             if (newPassword.length < 6) { throw new Error('Пароль < 6 симв.'); }
             userUpdates.PasswordHash = await bcrypt.hash(newPassword, 10); userUpdates.MustChangePassword = false;
        }
        if (role === 'Owner' && originalRole !== 'Owner') { userUpdates.companyProfileCompleted = false; }
        else if (role !== 'Owner' && currentUserData.hasOwnProperty('companyProfileCompleted')) { userUpdates.companyProfileCompleted = null; }

        // Баланс
        if (role === 'Tenant') {
            const newBalanceValue = parseFloat(balance);
            if (isNaN(newBalanceValue)) { throw new Error('Баланс должен быть числом.'); }
            if (newBalanceValue !== (currentUserData.Balance ?? 0) || !currentUserData.hasOwnProperty('Balance')) {
                 const oldBalance = currentUserData.Balance ?? 0; const difference = newBalanceValue - oldBalance; userUpdates.Balance = newBalanceValue;
                 if (difference !== 0) {
                     const historyRef = db.ref(`users/${usernameToEdit}/BalanceHistory`).push(); const historyKey = historyRef.key;
                     if(!historyKey) throw new Error("Failed history key gen on edit");
                     const adminUsername = req.session.user?.username || 'Admin'; // Получаем имя админа
                     userUpdates[`BalanceHistory/${historyKey}`] = { Id: historyKey, Date: new Date().toISOString(), Amount: difference, OperationType: "Коррекция адм.", Description: `Изм. адм. ${adminUsername}.`, NewBalance: newBalanceValue };
                 }
            }
        } else { if (currentUserData.hasOwnProperty('Balance')) userUpdates.Balance = null; if (currentUserData.hasOwnProperty('BalanceHistory')) userUpdates.BalanceHistory = null; }

        const companyUpdates = {};
        if (originalRole === 'Staff' && originalCompanyId && (originalCompanyId !== assignedCompanyId || role !== 'Staff')) { companyUpdates[`/companies/${originalCompanyId}/staff/${usernameToEdit}`] = null; }
        if (role === 'Staff' && assignedCompanyId && (originalRole !== 'Staff' || originalCompanyId !== assignedCompanyId)) { companyUpdates[`/companies/${assignedCompanyId}/staff/${usernameToEdit}`] = true; }
        if (role === 'Owner' && originalRole !== 'Owner') { let company = await firebaseService.getCompanyById(assignedCompanyId); if (!company) { await firebaseService.createCompany(assignedCompanyId, usernameToEdit, { companyName: `${fullName} Company` }); } else if(company.ownerUsername !== usernameToEdit) { await db.ref(`companies/${assignedCompanyId}`).update({ ownerUsername: usernameToEdit }); } }

        // --- Атомарное обновление БД ---
        const allDbUpdates = { ...companyUpdates };
        Object.keys(userUpdates).forEach(key => { allDbUpdates[`/users/${usernameToEdit}/${key}`] = userUpdates[key]; });
        await db.ref().update(allDbUpdates);
        log.info(`[POST /users/edit v5] Database updated for ${usernameToEdit}.`);

        // --- Отправка Socket.IO В КОМНАТУ ---
        const targetUserRoom = `user:${usernameToEdit}`;
        let companyNameForSocket = null;
        if(assignedCompanyId){ try { companyNameForSocket = (await firebaseService.getCompanyById(assignedCompanyId))?.companyName; } catch(e){} }
        const profileUpdateData = { fullName: userUpdates.FullName, role: userUpdates.Role, companyName: companyNameForSocket, companyId: userUpdates.companyId, companyProfileCompleted: userUpdates.companyProfileCompleted === null ? undefined : userUpdates.companyProfileCompleted, email: userUpdates.Email, phone: userUpdates.Phone };

        log.info(`[POST /users/edit v5] Emitting updates to room ${targetUserRoom}`);
        io.to(targetUserRoom).emit('profile_data_updated', profileUpdateData);
        if (userUpdates.Balance !== undefined && userUpdates.Role === 'Tenant') {
             io.to(targetUserRoom).emit('balance_updated', userUpdates.Balance === null ? 0 : userUpdates.Balance);
        }
        // --- КОНЕЦ Socket.IO ---

        req.session.message = { type: 'success', text: `Данные ${usernameToEdit} обновлены.` };
        req.session.save(err => res.redirect('/users'));

    } catch (error) {
        log.error(`[POST /users/edit v5] Error updating user ${usernameToEdit}:`, error);
        req.session.message = { type: 'error', text: error.message || 'Ошибка обновления.' };
        try { // Попытка рендера формы с ошибкой
             const [userToRetry, companiesSnapshot] = await Promise.all([ firebaseService.getUserByUsername(usernameToEdit), db.ref('companies').once('value') ]);
             const companiesList = companiesSnapshot.val() ? Object.entries(companiesSnapshot.val()).map(([id, data]) => ({ id: id, name: data.companyName })) : [];
             const userFormData = { ...(userToRetry || {}), Username: usernameToEdit, FullName: fullName, Email: email, Phone: phone, Role: role, companyId: companyId, Balance: balance };
             let avatarSrcRetry = '/images/placeholder-avatar.png'; if (userFormData.ImageData) { try{let t=userFormData.ImageData.startsWith('/9j/')?'jpeg':'png'; avatarSrcRetry=`data:image/${t};base64,${userFormData.ImageData}`; } catch(e){} } userFormData.DisplayAvatarSrc = avatarSrcRetry;
             res.render('user-add-edit', { title: `Редактировать: ${usernameToEdit}`, userToEdit: userFormData, isEditMode: true, availableRoles: ['Admin', 'Owner', 'Staff', 'Tenant'], companiesList: companiesList, message: req.session.message });
             if (req.session.message) delete req.session.message;
         } catch (renderError) { next(error); }
    }
});

// POST /reset-avatar/:username (Сброс аватара)
router.post('/reset-avatar/:username', isLoggedIn, isAdmin, async (req, res) => {
    const usernameToReset = req.params.username;
    const adminUsername = req.session.user?.username || 'Admin';
    const io = req.app.get('socketio');
    log.info(`[POST /users/reset-avatar v5 - Rooms] START: Admin ${adminUsername} reset for ${usernameToReset}`);
    try {
        const userRef = db.ref(`users/${usernameToReset}`);
        const snapshot = await userRef.once('value'); const user = snapshot.val();
        if (!user) { return res.status(404).json({ success: false, error: 'Пользователь не найден.' }); }
        if (!user.ImageData) { return res.status(200).json({ success: true, message: 'У пользователя уже нет аватара.', avatarRemoved: false }); }

        await userRef.update({ ImageData: null });
        log.info(`[POST /users/reset-avatar v5] SUCCESS: Avatar reset for ${usernameToReset}`);

        // *** ОТПРАВКА В КОМНАТУ ***
        const targetUserRoom = `user:${usernameToReset}`;
        io.to(targetUserRoom).emit('avatar_updated');
        log.info(`[POST /users/reset-avatar v5] Emitted 'avatar_updated' to room ${targetUserRoom}`);
        // *** КОНЕЦ ОТПРАВКИ ***

        res.status(200).json({ success: true, message: `Аватар ${usernameToReset} сброшен.`, avatarRemoved: true });
    } catch (error) {
        log.error(`[POST /users/reset-avatar v5] ERROR for ${usernameToReset}:`, error);
        res.status(500).json({ success: false, error: error.message || 'Ошибка сброса аватара.' });
    }
});


// POST /delete/:username (Удаление пользователя)
router.post('/delete/:username', isLoggedIn, isAdmin, async (req, res, next) => {
    const usernameToDelete = req.params.username;
    const currentAdminUsername = req.session.user?.username || 'Admin';
    const io = req.app.get('socketio');
    log.info(`[POST /users/delete v5 - Rooms] START: Admin ${currentAdminUsername} deleting ${usernameToDelete}`);
    try {
        if (usernameToDelete === currentAdminUsername) { throw new Error('Нельзя удалить свой аккаунт.'); }
        const user = await firebaseService.getUserByUsername(usernameToDelete);
        if (!user) { throw new Error('Пользователь не найден.'); }

        await firebaseService.deleteUser(usernameToDelete);
        log.info(`[POST /users/delete v5] SUCCESS: User ${usernameToDelete} deleted from DB.`);

        // *** ОТПРАВКА В КОМНАТУ И ДИСКОННЕКТ ***
        const targetUserRoom = `user:${usernameToDelete}`;
        io.to(targetUserRoom).emit('account_deleted', { message: 'Ваш аккаунт удален администратором.' });
        io.in(targetUserRoom).disconnectSockets(true); // Отключаем все сокеты в комнате
        log.info(`[POST /users/delete v5] Emitted 'account_deleted' and disconnected sockets in room ${targetUserRoom}`);
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
    const io = req.app.get('socketio');
    log.info(`[POST /users/adjust-balance v5 - No Transaction, Rooms] START: Admin ${adminUsername} adjust for ${usernameToAdjust} to ${newBalanceStr}`);

    const newBalance = parseFloat(newBalanceStr);
    if (isNaN(newBalance)) { return res.status(400).json({ success: false, error: 'Баланс должен быть числом.' }); }

    try {
        const userRef = db.ref(`users/${usernameToAdjust}`);
        const userSnapshot = await userRef.once('value'); const user = userSnapshot.val();
        if (!user) { throw new Error(`Пользователь '${usernameToAdjust}' не найден.`); }
        if (user.Role !== 'Tenant') { throw new Error("Изменять баланс можно только для 'Tenant'."); }

        const oldBalance = user.Balance || 0; const difference = newBalance - oldBalance;
        const updates = { Balance: newBalance };
        if (difference !== 0) {
            const historyRef = userRef.child('BalanceHistory').push(); const newOpKey = historyRef.key;
            if(!newOpKey) throw new Error("Failed history key gen on adjust");
            updates[`BalanceHistory/${newOpKey}`] = { Id: newOpKey, Date: new Date().toISOString(), Amount: difference, OperationType: "Коррекция адм.", Description: `Изм. адм.: ${adminUsername}. Старый: ${oldBalance.toFixed(2)}`, NewBalance: newBalance };
        }

        await userRef.update(updates);
        log.info(`[POST /users/adjust-balance v5] SUCCESS: Update successful for ${usernameToAdjust}. New balance: ${newBalance}`);

        // *** ОТПРАВКА В КОМНАТУ ***
        const targetUserRoom = `user:${usernameToAdjust}`;
        io.to(targetUserRoom).emit('balance_updated', newBalance);
        log.info(`[POST /users/adjust-balance v5] Emitted 'balance_updated' to room ${targetUserRoom}`);
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
    log.info(`[POST /users/set-temporary-password v5] START: Admin ${adminUsername} for ${usernameToReset}`);
    try {
        const user = await firebaseService.getUserByUsername(usernameToReset);
        if (!user) { return res.status(404).json({ success: false, error: 'Пользователь не найден.' }); }
        if (usernameToReset === adminUsername) { return res.status(400).json({ success: false, error: 'Нельзя сбросить свой пароль.' }); }

        const tempPassword = generateTemporaryPassword(12);
        const tempPasswordHash = await bcrypt.hash(tempPassword, 10);
        const updates = { PasswordHash: tempPasswordHash, MustChangePassword: true };
        await db.ref(`users/${usernameToReset}`).update(updates);
        log.info(`[POST /users/set-temporary-password v5] SUCCESS for ${usernameToReset}.`);

        // Уведомление не отправляем через сокет, пароль передаем админу
        res.status(200).json({ success: true, message: `Временный пароль для ${usernameToReset} установлен.`, tempPassword: tempPassword });
    } catch (error) {
        log.error(`[POST /users/set-temporary-password v5] ERROR for ${usernameToReset}:`, error);
        res.status(500).json({ success: false, error: error.message || 'Ошибка установки пароля.' });
    }
});

module.exports = router; // Экспорт