// routes/rentalRoutes.js (Полная версия с нуля для AJAX)
const express = require('express');
const firebaseService = require('../services/firebaseService'); // Убедитесь, что путь правильный
const { isLoggedIn, isAdmin } = require('../middleware/authMiddleware'); // Убедитесь, что пути правильные
const { isCompanyMemberOrAdmin } = require('../middleware/companyMiddleware');
const admin = require('firebase-admin');
const db = admin.database();
const log = require('electron-log');

const router = express.Router();
const COMMISSION_RATE = 0.15; // Ставка комиссии

// --- Вспомогательная функция отправки уведомлений команде ---
// (Предполагаем, что она существует и работает корректно с вашим setup Socket.IO/Redis)
async function notifyCompanyTeam(companyId, eventName, data, excludedUsername, ioInstance, userSocketsMap, actionSource = 'system', notificationDetails = null) {
    if (!companyId || !ioInstance || !notificationDetails || !userSocketsMap) { log.warn(`[notifyCompanyTeam v7] Missing required data...`); return; }
    log.info(`[notifyCompanyTeam v7] Preparing '${eventName}' DB notification for company ${companyId}, excluding ${excludedUsername}. Source: ${actionSource}`);
    try {
        const company = await firebaseService.getCompanyById(companyId);
        if (!company) { log.warn(`[notifyCompanyTeam v7] Company ${companyId} not found.`); return; }
        const ownerUsername = company.ownerUsername;
        const staffUsernames = company.staff ? Object.keys(company.staff) : [];
        const recipients = [...new Set([ownerUsername, ...staffUsernames])].filter(uname => uname && uname !== excludedUsername);
        if (recipients.length > 0) {
            log.info(`[notifyCompanyTeam v7] Recipients for '${eventName}' (Company ${companyId}): ${recipients.join(', ')}`);
            const dbPromises = recipients.map(recipient => firebaseService.addNotification(recipient, notificationDetails));
            await Promise.all(dbPromises);
            log.info(`[notifyCompanyTeam v7] Saved DB notifications for ${recipients.length} recipients.`);
            recipients.forEach(recipient => {
                 const targetRoom = `user:${recipient}`;
                 ioInstance.to(targetRoom).emit(eventName, { ...data, actionSource });
                 log.info(`[notifyCompanyTeam v7] Also emitted '${eventName}' to user ${recipient} in room ${targetRoom}`);
            });
        } else { log.info(`[notifyCompanyTeam v7] No other team members to notify in company ${companyId}.`); }
    } catch (error) { log.error(`[notifyCompanyTeam v7] Error sending '${eventName}' notification for company ${companyId}:`, error); }
}
// --- Конец Helper Функции ---

// GET /rentals - Загрузка данных для страницы управления арендами
router.get('/', isLoggedIn, async (req, res, next) => {
    const currentUser = req.session.user;
    // Доступ только для Admin, Owner, Staff
    if (!currentUser || (currentUser.role !== 'Admin' && currentUser.role !== 'Owner' && currentUser.role !== 'Staff')) {
        req.session.message = {type:'error', text:'Доступ запрещен.'};
        return req.session.save(err => { if(err) log.error("[Rentals GET v7] Session save error (access denied):", err); res.redirect('/'); });
    }
    log.info(`[GET /rentals v7] Accessing rentals management for user: ${currentUser.username}, Role: ${currentUser.role}`);

    try {
        let properties = [];
        let allBookings = [];
        let allUsers = [];

        // 1. Загрузка данных в зависимости от роли
        if (currentUser.role === 'Admin') {
            log.info("[Rentals GET v7] Fetching all data for Admin");
            [allBookings, properties, allUsers] = await Promise.allSettled([
                firebaseService.getAllBookings(),
                firebaseService.getAllProperties(),
                firebaseService.getAllUsers() // Загружаем всех пользователей для имен
            ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));
        } else if ((currentUser.role === 'Owner' || currentUser.role === 'Staff') && currentUser.companyId) {
            const companyId = currentUser.companyId;
            log.info(`[Rentals GET v7] Fetching data for Company ID ${companyId}`);
            [properties, allBookings, allUsers] = await Promise.allSettled([
                 firebaseService.getPropertiesByCompanyId(companyId), // Объекты только этой компании
                 firebaseService.getAllBookings(), // Брони ВСЕ, отфильтруем ниже
                 firebaseService.getAllUsers() // Пользователи ВСЕ
             ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));
        } else {
             log.warn(`[Rentals GET v7] Invalid state for ${currentUser.username}`);
             // Передаем пустой массив и ошибку
             return res.render('rentals-management', { title: 'Управление арендами', allBookingsJson: '[]', message: {type:'error', text:'Ошибка: Не удалось определить вашу компанию.'} });
        }

        // 2. Подготовка карт для быстрого поиска
        const propertiesMap = new Map( (Array.isArray(properties)?properties:[]).filter(p => p && p.Id).map(p => [p.Id, { title: p.Title, companyId: p.companyId }]));
        const usersMap = new Map( (Array.isArray(allUsers)?allUsers:[]).filter(u => u && u.Username).map(u => [u.Username, u.FullName || u.Username]));

        // 3. Фильтрация бронирований по объектам компании (если не Админ)
        let relevantBookings;
        if (currentUser.role === 'Admin') {
            relevantBookings = Array.isArray(allBookings) ? allBookings : [];
        } else {
            const companyPropertyIds = new Set(propertiesMap.keys()); // Используем Set для быстрой проверки
            relevantBookings = (Array.isArray(allBookings) ? allBookings : []).filter(booking =>
                booking && booking.PropertyId && companyPropertyIds.has(booking.PropertyId)
            );
        }
        log.info(`[Rentals GET v7] Found ${relevantBookings.length} relevant bookings for user/company.`);

        // 4. Обогащение данных бронирований для EJS
        console.log("[DEBUG Rentals GET v7] relevantBookings before mapping:", JSON.stringify(relevantBookings, null, 2)); // Добавлено для отладки

        const bookingsForEjs = relevantBookings.map(booking => {
             if(!booking || !booking.Id) return null; // Пропускаем некорректные
             const propInfo = booking.PropertyId ? propertiesMap.get(booking.PropertyId) : null;
             const tenantName = booking.UserId ? usersMap.get(booking.UserId) : 'Неизв. арендатор';
             return {
                 Id: booking.Id,
                 PropertyId: booking.PropertyId || null,
                 UserId: booking.UserId || null,
                 StartDate: booking.StartDate || null,
                 EndDate: booking.EndDate || null,
                 TotalCost: booking.TotalCost || 0,
                 Status: booking.Status || 'Unknown',
                 CreatedAt: booking.CreatedAt || null,
                 RejectedReason: booking.RejectedReason || null,
                 ConfirmedBy: booking.ConfirmedBy || null, // Добавим для информации
                 CancelledBy: booking.CancelledBy || null, // Добавим для информации
                 // Дополнительные поля для отображения
                 PropertyTitle: propInfo ? propInfo.title : 'Объект удален',
                 TenantName: tenantName,
                 StartDateFormatted: booking.StartDate ? new Date(booking.StartDate).toLocaleDateString('ru-RU') : '?',
                 EndDateFormatted: booking.EndDate ? new Date(booking.EndDate).toLocaleDateString('ru-RU') : '?',
             };
        }).filter(Boolean); // Убираем null значения

        console.log("[DEBUG Rentals GET v7] bookingsForEjs after mapping and filtering:", JSON.stringify(bookingsForEjs, null, 2)); // Добавлено для отладки

        // 5. Рендеринг EJS с передачей данных в JSON для клиента
        const message = req.session.message || null;
        if (req.session.message) {
            delete req.session.message;
            req.session.save(err => { if (err) log.error("[Rentals GET v7] Session save error after clearing message:", err); });
        }

        res.render('rentals-management', {
            title: 'Управление арендами',
            // Передаем весь список в JSON для обработки на клиенте
            allBookingsJson: JSON.stringify(bookingsForEjs),
            message: message,
            isAdminUser: currentUser.role === 'Admin' // Передаем флаг админа
        });

    } catch (error) {
        log.error("[Rentals GET v7] Error fetching rentals list:", error);
        next(error);
    }
});

// POST /rentals/:id/confirm - Подтверждение брони
router.post('/:id/confirm', isLoggedIn, isCompanyMemberOrAdmin, async (req, res) => { // Убрали next, т.к. сами обрабатываем ошибки
    const bookingId = req.params.id;
    const confirmerUser = req.session.user;
    const io = req.app.get('socketio');
    const userSockets = req.app.get('userSockets');
    log.info(`[Rental Confirm AJAX v7] User ${confirmerUser.username} confirming booking ${bookingId}`);
    try {
        // --- Логика подтверждения (остается без изменений, как в предыдущем шаге) ---
        // ... (Получение брони, проверка статуса, получение tenant/property/company, проверка баланса, расчеты) ...
        const booking = await firebaseService.getBookingById(bookingId); if (!booking) throw new Error('Бронирование не найдено.'); if (booking.Status !== 'Ожидает подтверждения') throw new Error(`Броню нельзя подтвердить (статус: ${booking.Status}).`);
        const tenantUserId = booking.UserId; if (!tenantUserId) throw new Error('Не указан ID арендатора.');
        const property = await firebaseService.getPropertyById(booking.PropertyId); if (!property?.companyId) throw new Error('Не найдена компания объекта.');
        const companyId = property.companyId; const [tenant, company] = await Promise.all([ firebaseService.getUserByUsername(tenantUserId), firebaseService.getCompanyById(companyId) ]);
        if (!tenant) throw new Error(`Арендатор (${tenantUserId}) не найден.`); if (!company) throw new Error(`Компания (${companyId}) не найдена.`);
        const currentBalance = tenant.Balance || 0; const totalCost = booking.TotalCost || 0; if (totalCost <= 0) throw new Error("Некорректная сумма.");
        // Проверка баланса и авто-отклонение
        if (currentBalance < totalCost) {
            log.warn(`[Rental Confirm AJAX v7] Insufficient funds for tenant ${tenant.Username} on confirm.`);
            const rejectionReason = 'Недостаточно средств на момент подтверждения'; const timestampReject = new Date().toISOString();
            await db.ref(`bookings/${bookingId}`).update({ Status: 'Отклонена', RejectedAt: timestampReject, RejectedBy: confirmerUser.username, RejectedReason: rejectionReason });
            // Уведомления об авто-отклонении...
             const tenantNotificationReject = { type: 'warning', title: 'Запрос отклонен', message: `Ваш запрос (#${bookingId.substring(0,6)}) на "<strong>${property.Title || '?'}</strong>" отклонен. Причина: ${rejectionReason}.`, bookingId: bookingId }; await firebaseService.addNotification(tenant.Username, tenantNotificationReject); io.to(`user:${tenant.Username}`).emit('booking_rejected', { bookingId: bookingId, reason: rejectionReason, propertyTitle: property.Title || '?' });
             const teamNotificationReject = { type: 'warning', title: 'Бронь отклонена (средства)', message: `Запрос (#${bookingId.substring(0,6)}) от ${tenant.FullName || tenant.Username} на "<strong>${property.Title || '?'}</strong>" авто-отклонен при подтверждении ${confirmerUser.username} из-за нехватки средств.`, bookingId: bookingId }; const socketDataReject = { bookingId: bookingId, newStatus: 'Отклонена', reason: rejectionReason, changedBy: confirmerUser.username, propertyTitle: property.Title || '?', tenantName: tenant.FullName || tenant.Username }; await notifyCompanyTeam(companyId, 'booking_status_changed', socketDataReject, confirmerUser.username, io, userSockets, 'confirm_insufficient_funds', teamNotificationReject);
             const taskIdToRemove = `book-${bookingId}`; const teamMembersUsernames = [company.ownerUsername, ...(company.staff ? Object.keys(company.staff) : [])].filter(Boolean); teamMembersUsernames.forEach(username => io.to(`user:${username}`).emit('dashboard:remove_task', taskIdToRemove));
             // Возвращаем JSON с ошибкой для клиента
             return res.status(400).json({ success: false, error: 'Недостаточно средств у арендатора для подтверждения. Бронь отклонена.', bookingId: bookingId, newStatus: 'Отклонена', rejectedReason: rejectionReason });
        }
        // Продолжение подтверждения...
        const updates = {}; const timestamp = new Date().toISOString(); const newStatus = 'Активна'; updates[`/bookings/${bookingId}/Status`] = newStatus; updates[`/bookings/${bookingId}/ConfirmedAt`] = timestamp; updates[`/bookings/${bookingId}/ConfirmedBy`] = confirmerUser.username; updates[`/bookings/${bookingId}/RejectedReason`] = null;
        const tenantNewBalance = parseFloat((currentBalance - totalCost).toFixed(2)); const tenantHistoryKey = db.ref(`users/${tenant.Username}/BalanceHistory`).push().key; if(!tenantHistoryKey) throw new Error("Ключ истории арендатора?"); updates[`/users/${tenant.Username}/Balance`] = tenantNewBalance; updates[`/users/${tenant.Username}/BalanceHistory/${tenantHistoryKey}`] = { Id: tenantHistoryKey, Date: timestamp, Amount: -totalCost, OperationType: "Оплата брони", Description: `Бронь #${bookingId.substring(0,6)}: "${property.Title}"`, NewBalance: tenantNewBalance };
        const amountToCreditCompany = booking.AmountPaidToCompany ?? parseFloat(((booking.TotalCost || 0) * (1 - COMMISSION_RATE)).toFixed(2)); if(amountToCreditCompany > 0) { const currentCompanyBalance = company.Balance || 0; const newCompanyBalance = parseFloat((currentCompanyBalance + amountToCreditCompany).toFixed(2)); const companyHistoryKey = db.ref(`companies/${companyId}/balanceHistory`).push().key; if(!companyHistoryKey) throw new Error("Ключ истории компании?"); updates[`/companies/${companyId}/Balance`] = newCompanyBalance; updates[`/companies/${companyId}/balanceHistory/${companyHistoryKey}`] = { Id: companyHistoryKey, Date: timestamp, Amount: amountToCreditCompany, OperationType: "Поступление (Аренда)", Description: `Подтверждение #${bookingId.substring(0,6)}`, NewBalance: newCompanyBalance }; }
        await db.ref().update(updates);
        log.info(`[Rental Confirm AJAX v7] SUCCESS. Booking ${bookingId} confirmed. Tenant balance: ${tenantNewBalance}.`);
        // Уведомления...
        const tenantNotificationConfirm = { type: 'success', title: 'Бронь подтверждена', message: `Ваша бронь (#${bookingId.substring(0,6)}) для "<strong>${property.Title || '?'}</strong>" подтверждена.`, bookingId: bookingId }; await firebaseService.addNotification(tenant.Username, tenantNotificationConfirm); io.to(`user:${tenant.Username}`).emit('balance_updated', tenantNewBalance); io.to(`user:${tenant.Username}`).emit('booking_confirmed', { bookingId: bookingId, propertyTitle: property.Title || '?', startDate: booking.StartDate, endDate: booking.EndDate });
        const teamNotificationConfirm = { type: 'success', title: 'Бронь подтверждена', message: `Бронь (#${bookingId.substring(0,6)}) от ${tenant.FullName || tenant.Username} на "<strong>${property.Title || '?'}</strong>" подтверждена ${confirmerUser.username}.`, bookingId: bookingId }; const socketDataConfirm = { bookingId: bookingId, newStatus: newStatus, changedBy: confirmerUser.username, propertyTitle: property.Title || '?', tenantName: tenant.FullName || tenant.Username }; await notifyCompanyTeam(companyId, 'booking_status_changed', socketDataConfirm, confirmerUser.username, io, userSockets, 'confirm', teamNotificationConfirm);
        const taskIdToRemoveConfirmed = `book-${bookingId}`; const teamUsernamesConfirm = [company.ownerUsername, ...(company.staff ? Object.keys(company.staff) : [])].filter(Boolean); teamUsernamesConfirm.forEach(username => io.to(`user:${username}`).emit('dashboard:remove_task', taskIdToRemoveConfirmed));
        // --- КОНЕЦ логики подтверждения ---

        // Отправляем JSON ответ
        res.status(200).json({
            success: true,
            message: 'Бронирование успешно подтверждено.',
            bookingId: bookingId,
            newStatus: newStatus,
            // Передаем обновленные данные для строки
            updatedBookingData: {
                 Status: newStatus,
                 ConfirmedBy: confirmerUser.username,
                 RejectedReason: null // Очищаем причину
                 // Другие поля не меняются при подтверждении, но можно добавить, если нужно
            }
        });

    } catch (error) {
        log.error(`[Rental Confirm AJAX v7] ERROR confirming booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдено") ? 404 : 400;
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка подтверждения.' });
    }
});

// POST /rentals/:id/reject - Отклонение брони
router.post('/:id/reject', isLoggedIn, isCompanyMemberOrAdmin, async (req, res) => {
    const bookingId = req.params.id;
    const rejecterUser = req.session.user;
    const reason = req.body.reason || 'Отклонено владельцем/администрацией'; // Получаем причину из тела запроса
    const io = req.app.get('socketio');
    const userSockets = req.app.get('userSockets');
    log.info(`[Rental Reject AJAX v7] User ${rejecterUser.username} rejecting booking ${bookingId} with reason: ${reason}`);
    try {
        // --- Логика отклонения (остается без изменений) ---
        const booking = await firebaseService.getBookingById(bookingId); if (!booking) throw new Error('Бронирование не найдено.'); if (booking.Status !== 'Ожидает подтверждения') throw new Error(`Броню нельзя отклонить (статус: ${booking.Status}).`);
        const tenantUserId = booking.UserId; if (!tenantUserId) throw new Error('Не указан ID арендатора.');
        const property = await firebaseService.getPropertyById(booking.PropertyId); const tenant = await firebaseService.getUserByUsername(tenantUserId); const companyId = property?.companyId;
        const newStatus = 'Отклонена';
        await db.ref(`bookings/${bookingId}`).update({ Status: newStatus, RejectedAt: new Date().toISOString(), RejectedBy: rejecterUser.username, RejectedReason: reason });
        log.info(`[Rental Reject AJAX v7] SUCCESS. Booking ${bookingId} rejected.`);
        // Уведомления...
        const tenantNotificationReject = { type: 'warning', title: 'Запрос отклонен', message: `Ваш запрос (#${bookingId.substring(0,6)}) на "<strong>${property?.Title || '?'}</strong>" отклонен.${reason ? ' Причина: ' + reason : ''}`, bookingId: bookingId }; await firebaseService.addNotification(tenantUserId, tenantNotificationReject); io.to(`user:${tenantUserId}`).emit('booking_rejected', { bookingId: bookingId, propertyTitle: property?.Title || '?', reason: reason });
        if (companyId) { const teamNotificationReject = { type: 'warning', title: 'Бронь отклонена', message: `Запрос (#${bookingId.substring(0,6)}) от ${tenant?.FullName || tenant?.Username || '?'} на "<strong>${property?.Title || '?'}</strong>" отклонен ${rejecterUser.username}.${reason ? ' Причина: '+reason : ''}`, bookingId: bookingId }; const socketDataReject = { bookingId: bookingId, newStatus: newStatus, reason: reason, changedBy: rejecterUser.username, propertyTitle: property?.Title || '?', tenantName: tenant?.FullName || tenant?.Username || '?' }; await notifyCompanyTeam(companyId, 'booking_status_changed', socketDataReject, rejecterUser.username, io, userSockets, 'reject', teamNotificationReject); const companyForNotify = await firebaseService.getCompanyById(companyId).catch(e => null); if (companyForNotify) { const taskIdToRemoveRejected = `book-${bookingId}`; const teamUsernamesReject = [companyForNotify.ownerUsername, ...(companyForNotify.staff ? Object.keys(companyForNotify.staff) : [])].filter(Boolean); teamUsernamesReject.forEach(username => io.to(`user:${username}`).emit('dashboard:remove_task', taskIdToRemoveRejected)); } }
        // --- КОНЕЦ логики отклонения ---

        // Отправляем JSON ответ
        res.status(200).json({
            success: true,
            message: 'Бронирование успешно отклонено.',
            bookingId: bookingId,
            newStatus: newStatus,
            // Передаем обновленные данные для строки
            updatedBookingData: {
                 Status: newStatus,
                 RejectedReason: reason,
                 RejectedBy: rejecterUser.username
            }
        });

    } catch (error) {
        log.error(`[Rental Reject AJAX v7] ERROR rejecting booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдено") ? 404 : 400;
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка отклонения.' });
    }
});

// POST /rentals/:id/cancel - Аннуляция активной брони
router.post('/:id/cancel', isLoggedIn, isCompanyMemberOrAdmin, async (req, res) => {
    const bookingId = req.params.id;
    const cancellerUser = req.session.user;
    const io = req.app.get('socketio');
    const userSockets = req.app.get('userSockets');
    log.info(`[Rentals Cancel AJAX v7] User ${cancellerUser.username} cancelling booking ${bookingId}`);
    try {
        // --- Логика аннуляции (остается без изменений) ---
        // ... (Получение брони, проверка статуса, получение tenant/property/company, расчет возврата, обновление балансов и истории, отправка уведомлений) ...
        const booking = await firebaseService.getBookingById(bookingId); if (!booking) throw new Error('Бронирование не найдено.'); if (booking.Status !== 'Активна') throw new Error(`Статус брони: "${booking.Status}". Аннуляция возможна только для активных броней.`);
        const tenantUserId = booking.UserId; if (!tenantUserId) throw new Error('Не указан ID арендатора.');
        const property = await firebaseService.getPropertyById(booking.PropertyId); if (!property?.companyId) throw new Error('Ошибка: не найдена компания объекта.');
        const companyId = property.companyId; const updates = {}; const timestamp = new Date().toISOString();
        const refundAmountTenant = booking.TotalCost || 0; const amountToDebitCompany = booking.AmountPaidToCompany ?? parseFloat(((booking.TotalCost || 0) * (1 - COMMISSION_RATE)).toFixed(2));
        let finalTenantBalance = null; const newStatus = 'Аннулирована'; updates[`/bookings/${bookingId}/Status`] = newStatus; updates[`/bookings/${bookingId}/CancelledAt`] = timestamp; updates[`/bookings/${bookingId}/CancelledBy`] = cancellerUser.username;
        let tenant = null; if (refundAmountTenant > 0) { tenant = await firebaseService.getUserByUsername(tenantUserId); if (tenant) { const currentTenantBalance = tenant.Balance || 0; finalTenantBalance = parseFloat((currentTenantBalance + refundAmountTenant).toFixed(2)); updates[`/users/${tenantUserId}/Balance`] = finalTenantBalance; const tenantHistoryKey = db.ref(`users/${tenantUserId}/BalanceHistory`).push().key; if(!tenantHistoryKey) throw new Error("Ключ истории арендатора?"); updates[`/users/${tenantUserId}/BalanceHistory/${tenantHistoryKey}`] = { Id: tenantHistoryKey, Date: timestamp, Amount: refundAmountTenant, OperationType: "Возврат (Аннул. адм.)", Description: `Аннул. адм. (${cancellerUser.username}) брони #${bookingId.substring(0,6)}`, NewBalance: finalTenantBalance }; } else { log.error(`[Rentals Cancel v7] Tenant ${tenantUserId} not found! Refund cannot be processed.`); }}
        if (amountToDebitCompany > 0) { const company = await firebaseService.getCompanyById(companyId); if (!company) throw new Error(`Компания ${companyId} не найдена.`); const currentCompanyBalance = company.Balance || 0; const newCompanyBalance = parseFloat((currentCompanyBalance - amountToDebitCompany).toFixed(2)); const companyHistoryKey = db.ref(`companies/${companyId}/balanceHistory`).push().key; if(!companyHistoryKey) throw new Error("Ключ истории компании?"); updates[`/companies/${companyId}/Balance`] = newCompanyBalance; updates[`/companies/${companyId}/balanceHistory/${companyHistoryKey}`] = { Id: companyHistoryKey, Date: timestamp, Amount: -amountToDebitCompany, OperationType: "Списание (Аннул. адм.)", Description: `Аннул. адм. (${cancellerUser.username}) брони #${bookingId.substring(0,6)}`, NewBalance: newCompanyBalance }; }
        await db.ref().update(updates);
        log.info(`[Rentals Cancel v7] SUCCESS. Booking ${bookingId} status changed to: ${newStatus}.`);
        // Уведомления...
        const tenantNotificationCancel = { type: 'error', title: 'Бронь аннулирована', message: `Ваша активная бронь (#${bookingId.substring(0,6)}) для "<strong>${property?.Title || '?'}</strong>" аннулирована адм. (${cancellerUser.username}).${finalTenantBalance !== null ? ' Средства возвращены.' : ''}`, bookingId: bookingId }; await firebaseService.addNotification(tenantUserId, tenantNotificationCancel); if (finalTenantBalance !== null) { io.to(`user:${tenantUserId}`).emit('balance_updated', finalTenantBalance); } io.to(`user:${tenantUserId}`).emit('booking_cancelled_by_owner', { bookingId: bookingId, propertyTitle: property?.Title || '?', cancelledBy: cancellerUser.username });
        const teamNotificationCancel = { type: 'error', title: 'Бронь аннулирована', message: `Активная бронь (#${bookingId.substring(0,6)}) от ${tenant?.FullName || tenant?.Username || '?'} для "<strong>${property?.Title || '?'}</strong>" аннулирована ${cancellerUser.username}.`, bookingId: bookingId }; const socketDataCancel = { bookingId: bookingId, newStatus: newStatus, changedBy: cancellerUser.username, propertyTitle: property?.Title || '?', tenantName: tenant?.FullName || tenant?.Username || '?' }; await notifyCompanyTeam(companyId, 'booking_status_changed', socketDataCancel, cancellerUser.username, io, userSockets, 'cancel_admin', teamNotificationCancel);
        // --- КОНЕЦ логики аннуляции ---

        let successMessage = `Бронирование успешно аннулировано.`;
        if (refundAmountTenant > 0 && finalTenantBalance !== null) { successMessage += ` Средства (${refundAmountTenant.toFixed(2)} RUB) возвращены арендатору.`; }

        // Отправляем JSON ответ
        res.status(200).json({
            success: true,
            message: successMessage,
            bookingId: bookingId,
            newStatus: newStatus,
            // Передаем обновленные данные для строки
            updatedBookingData: {
                 Status: newStatus,
                 CancelledBy: cancellerUser.username
            }
        });

    } catch (error) {
        log.error(`[Rentals Cancel AJAX v7] ERROR cancelling booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдено") ? 404 : 400;
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка аннулирования.' });
    }
});

// POST /rentals/:id/delete - Удаление записи (Admin Only)
router.post('/:id/delete', isLoggedIn, isAdmin, async (req, res) => {
    const bookingId = req.params.id;
    const adminUsername = req.session.user.username;
    log.info(`[Rentals Delete AJAX v7] Admin ${adminUsername} deleting booking ${bookingId}`);
     try {
         const booking = await firebaseService.getBookingById(bookingId);
         if (!booking) { throw new Error("Запись бронирования не найдена."); }
         // Мягкое удаление: НЕ удаляем Активные или Ожидающие
         if (['Активна', 'Ожидает подтверждения'].includes(booking.Status)) {
             throw new Error("Нельзя удалить запись об активном или ожидающем бронировании. Сначала измените статус (например, аннулируйте).");
         }
         // Физическое удаление записи из БД
         await firebaseService.deleteBooking(bookingId);
         log.info(`[Rentals Delete AJAX v7] SUCCESS: Booking ${bookingId} record deleted.`);

         // Отправляем JSON ответ
         res.status(200).json({
             success: true,
             message: 'Запись о бронировании успешно удалена.',
             bookingId: bookingId // ID для удаления строки на клиенте
         });
    } catch (error) {
        log.error(`[Rentals Delete AJAX v7] ERROR deleting booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдена") ? 404 : (error.message.includes("Нельзя удалить") ? 400 : 500);
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка удаления записи.' });
    }
});

module.exports = router;