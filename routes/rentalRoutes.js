// routes/rentalRoutes.js
const express = require('express');
const firebaseService = require('../services/firebaseService');
const { isLoggedIn, isAdmin } = require('../middleware/authMiddleware'); // isAdmin нужен для delete
const { isCompanyMemberOrAdmin } = require('../middleware/companyMiddleware'); // Для confirm/reject/cancel
const admin = require('firebase-admin');
const db = admin.database();
const log = require('electron-log'); // Используем electron-log

const router = express.Router();
const COMMISSION_RATE = 0.15; // Ставка комиссии

// --- Helper Функция для отправки уведомлений команде (No changes needed) ---
async function notifyCompanyTeam(companyId, eventName, data, excludedUsername, ioInstance, userSocketsMap, actionSource = 'system', notificationDetails = null) {
    // ... (keep the existing helper function as is) ...
    if (!companyId || !ioInstance || !notificationDetails || !userSocketsMap) { log.warn(`[notifyCompanyTeamV6.1] Missing required data...`); return; }
    log.info(`[notifyCompanyTeamV6.1] Preparing '${eventName}' DB notification for company ${companyId}, excluding ${excludedUsername}. Source: ${actionSource}`);
    try {
        const company = await firebaseService.getCompanyById(companyId);
        if (!company) { log.warn(`[notifyCompanyTeamV6.1] Company ${companyId} not found.`); return; }
        const ownerUsername = company.ownerUsername;
        const staffUsernames = company.staff ? Object.keys(company.staff) : [];
        const recipients = [...new Set([ownerUsername, ...staffUsernames])].filter(uname => uname && uname !== excludedUsername);
        if (recipients.length > 0) {
            log.info(`[notifyCompanyTeamV6.1] Recipients for '${eventName}' (Company ${companyId}): ${recipients.join(', ')}`);
            const dbPromises = recipients.map(recipient => firebaseService.addNotification(recipient, notificationDetails));
            await Promise.all(dbPromises);
            log.info(`[notifyCompanyTeamV6.1] Saved DB notifications for ${recipients.length} recipients.`);
            recipients.forEach(recipient => {
                 const recipientSocketId = userSocketsMap[recipient];
                 const targetRoom = `user:${recipient}`;
                 if (recipientSocketId) {
                      ioInstance.to(targetRoom).emit(eventName, { ...data, actionSource });
                      log.info(`[notifyCompanyTeamV6.1] Also emitted '${eventName}' to online user ${recipient} in room ${targetRoom}`);
                 } else {
                     log.info(`[notifyCompanyTeamV6.1] User ${recipient} is offline for direct emit, notification stored in DB.`);
                 }
            });
        } else { log.info(`[notifyCompanyTeamV6.1] No other team members to notify in company ${companyId}.`); }
    } catch (error) { log.error(`[notifyCompanyTeamV6.1] Error sending '${eventName}' notification for company ${companyId}:`, error); }
}
// --- Конец Helper Функции ---

// GET /: Отображение страницы управления арендами (Backend provides full data)
router.get('/', isLoggedIn, async (req, res, next) => {
    const currentUser = req.session.user;
    // Доступ только для Admin, Owner, Staff
    if (!currentUser || (currentUser.role !== 'Admin' && currentUser.role !== 'Owner' && currentUser.role !== 'Staff')) {
        req.session.message = {type:'error', text:'Доступ запрещен.'};
        // Use session save for reliable redirect with message
        return req.session.save(err => {
             if(err) log.error("[Rentals GET v6.2] Session save error (access denied):", err);
             res.redirect('/');
        });
    }
    log.info(`[GET /rentals v6.2 - Client Filter/Pagination] Accessing rentals management for user: ${currentUser.username}, Role: ${currentUser.role}`);

    try {
        let properties = [];
        let allBookings = [];
        let allUsers = [];

        // Загрузка данных с фильтрацией по компании (No changes needed here)
        if (currentUser.role === 'Admin') {
            log.info("[Rentals GET v6.2] Fetching all data for Admin");
            [allBookings, properties, allUsers] = await Promise.allSettled([
                firebaseService.getAllBookings(),
                firebaseService.getAllProperties(),
                firebaseService.getAllUsers()
            ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));
        } else if ((currentUser.role === 'Owner' || currentUser.role === 'Staff') && currentUser.companyId) {
            const companyId = currentUser.companyId;
            log.info(`[Rentals GET v6.2] Fetching data for Company ID ${companyId}`);
            [properties, allBookings, allUsers] = await Promise.allSettled([
                 firebaseService.getPropertiesByCompanyId(companyId),
                 firebaseService.getAllBookings(),
                 firebaseService.getAllUsers()
             ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));
        } else {
             log.warn(`[Rentals GET v6.2] Access denied or invalid state for ${currentUser.username} (Role: ${currentUser.role}, CompanyId: ${currentUser.companyId})`);
             return res.render('rentals-management', { title: 'Управление арендами', bookings: [], message: {type:'error', text:'Ошибка: Не удалось определить вашу компанию.'} });
        }

        // Подготовка карт для быстрого поиска (No changes needed)
        const propertiesMap = new Map( (Array.isArray(properties)?properties:[]).filter(p => p && p.Id).map(p => [p.Id, { title: p.Title, companyId: p.companyId }]));
        const usersMap = new Map( (Array.isArray(allUsers)?allUsers:[]).filter(u => u && u.Username).map(u => [u.Username, u.FullName || u.Username]));

        // Фильтрация бронирований по объектам (No changes needed)
        let filteredBookings;
        if (currentUser.role === 'Admin') {
            filteredBookings = Array.isArray(allBookings) ? allBookings : [];
        } else {
            const companyPropertyIds = Array.from(propertiesMap.keys());
            filteredBookings = (Array.isArray(allBookings) ? allBookings : []).filter(booking => booking && booking.PropertyId && companyPropertyIds.includes(booking.PropertyId));
        }

        // Форматирование данных для отображения - УБЕДИТЕСЬ, что ВСЕ нужные поля передаются
        const bookingsWithDetails = filteredBookings.map(booking => {
             if(!booking || !booking.Id) {
                 log.warn("[Rentals GET v6.2] Skipping invalid booking entry in map.");
                 return null;
             }
             const propInfo = booking.PropertyId ? propertiesMap.get(booking.PropertyId) : null;
             const tenantName = booking.UserId ? usersMap.get(booking.UserId) : 'Неизвестный арендатор';
             return {
                 Id: booking.Id, // Needed for JS filtering/updates
                 PropertyId: booking.PropertyId, // Needed for links
                 UserId: booking.UserId, // Needed? Maybe for filtering later
                 StartDate: booking.StartDate,
                 EndDate: booking.EndDate,
                 TotalCost: booking.TotalCost,
                 Status: booking.Status, // Crucial for filtering & display
                 CreatedAt: booking.CreatedAt, // For sorting
                 RejectedReason: booking.RejectedReason || null,
                 // --- Fields added for display/filtering ---
                 PropertyTitle: propInfo ? propInfo.title : 'Объект удален?',
                 TenantName: tenantName,
                 StartDateFormatted: booking.StartDate ? new Date(booking.StartDate).toLocaleDateString('ru-RU') : '?',
                 EndDateFormatted: booking.EndDate ? new Date(booking.EndDate).toLocaleDateString('ru-RU') : '?',
             };
        }).filter(Boolean) // Remove null entries
          .sort((a, b) => new Date(b.CreatedAt || 0) - new Date(a.CreatedAt || 0)); // Sort all by creation date initially (client will re-sort/group)

        // Get flash message from session
        const message = req.session.message || null;
        if (req.session.message) {
            delete req.session.message;
            // Save session after deleting message
            req.session.save(err => {
                if (err) log.error("[Rentals GET v6.2] Session save error after clearing message:", err);
            });
        }

        res.render('rentals-management', {
            title: 'Управление арендами',
            bookings: bookingsWithDetails, // Pass the full, sorted list
            message: message,
            isAdminUser: currentUser.role === 'Admin' // Keep passing this
        });

    } catch (error) {
        log.error("[Rentals GET v6.2] Error fetching rentals list:", error);
        next(error);
    }
});

// --- POST routes (confirm, reject, cancel, delete) ---
// --- NO CHANGES NEEDED in the backend logic for these POST routes ---
// --- They already return JSON which the frontend can use ---

// POST /:id/confirm
router.post('/:id/confirm', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => {
    const bookingId = req.params.id;
    const confirmerUser = req.session.user;
    const io = req.app.get('socketio');
    const userSockets = req.app.get('userSockets');
    log.info(`[Rental Confirm AJAX v6.2] User ${confirmerUser.username} confirming booking ${bookingId}`);
    try {
        const booking = await firebaseService.getBookingById(bookingId);
        if (!booking) { throw new Error('Бронирование не найдено.'); }
        if (booking.Status !== 'Ожидает подтверждения') { throw new Error(`Броню нельзя подтвердить (статус: ${booking.Status}).`); }
        const tenantUserId = booking.UserId;
        if (!tenantUserId) { throw new Error('Не указан ID арендатора в бронировании.'); }
        const property = await firebaseService.getPropertyById(booking.PropertyId);
        if (!property?.companyId) { throw new Error('Не удалось определить компанию объекта.'); }
        const companyId = property.companyId;
        const [tenant, company] = await Promise.all([ firebaseService.getUserByUsername(tenantUserId), firebaseService.getCompanyById(companyId) ]);
        if (!tenant) { throw new Error(`Арендатор (${tenantUserId}) не найден.`); }
        if (!company) { throw new Error(`Компания (${companyId}) не найдена.`); }
        const currentBalance = tenant.Balance || 0;
        const totalCost = booking.TotalCost || 0;
        if (totalCost <= 0) { throw new Error("Некорректная сумма бронирования."); }
        if (currentBalance < totalCost) {
            log.warn(`[Rental Confirm AJAX v6.2] Insufficient funds for tenant ${tenant.Username} on confirm.`);
            const rejectionReason = 'Недостаточно средств на момент подтверждения';
            const timestampReject = new Date().toISOString();
            await db.ref(`bookings/${bookingId}`).update({ Status: 'Отклонена', RejectedAt: timestampReject, RejectedBy: confirmerUser.username, RejectedReason: rejectionReason });
            const tenantNotificationReject = { type: 'warning', title: 'Запрос отклонен', message: `Ваш запрос (#${bookingId.substring(0,6)}) на бронирование объекта "<strong>${property.Title || '?'}</strong>" был отклонен. Причина: ${rejectionReason}.`, bookingId: bookingId };
            await firebaseService.addNotification(tenant.Username, tenantNotificationReject);
            const tenantRoomReject = `user:${tenant.Username}`;
            io.to(tenantRoomReject).emit('booking_rejected', { bookingId: bookingId, reason: rejectionReason, propertyTitle: property.Title || '?' });
            log.info(`[Rental Confirm AJAX v6.2] Emitted 'booking_rejected' to tenant room ${tenantRoomReject}`);
            const teamNotificationReject = { type: 'warning', title: 'Бронь отклонена (средства)', message: `Запрос (#${bookingId.substring(0,6)}) для "<strong>${property.Title || '?'}</strong>" (Арендатор: ${tenant.FullName || tenant.Username}) <strong>автоматически отклонен</strong> из-за недостатка средств при попытке подтверждения пользователем ${confirmerUser.username}.`, bookingId: bookingId };
            const socketDataReject = { bookingId: bookingId, newStatus: 'Отклонена', reason: rejectionReason, changedBy: confirmerUser.username, propertyTitle: property.Title || '?', tenantName: tenant.FullName || tenant.Username };
            await notifyCompanyTeam(companyId, 'booking_status_changed', socketDataReject, confirmerUser.username, io, userSockets, 'confirm_insufficient_funds', teamNotificationReject);

            // --->>> ДОБАВЛЕНО: Удаление задачи Dashboard при авто-отклонении <<<---
            const taskIdToRemove = `book-${bookingId}`;
            const teamMembersUsernames = [company.ownerUsername, ...(company.staff ? Object.keys(company.staff) : [])].filter(Boolean);
            teamMembersUsernames.forEach(username => {
                const userRoom = `user:${username}`;
                io.to(userRoom).emit('dashboard:remove_task', taskIdToRemove);
                log.info(`[Rental Confirm Funds] Emitted 'dashboard:remove_task' (${taskIdToRemove}) to room ${userRoom}`);
            });
            // --->>> КОНЕЦ ДОБАВЛЕНИЯ <<<---

            throw new Error('Недостаточно средств у арендатора для подтверждения. Бронь отклонена.');
        }
        const updates = {};
        const timestamp = new Date().toISOString();
        const newStatus = 'Активна';
        updates[`/bookings/${bookingId}/Status`] = newStatus;
        updates[`/bookings/${bookingId}/ConfirmedAt`] = timestamp;
        updates[`/bookings/${bookingId}/ConfirmedBy`] = confirmerUser.username;
        updates[`/bookings/${bookingId}/RejectedReason`] = null;
        const tenantNewBalance = parseFloat((currentBalance - totalCost).toFixed(2));
        const tenantHistoryKey = db.ref(`users/${tenant.Username}/BalanceHistory`).push().key;
        if(!tenantHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для арендатора.");
        updates[`/users/${tenant.Username}/Balance`] = tenantNewBalance;
        updates[`/users/${tenant.Username}/BalanceHistory/${tenantHistoryKey}`] = { Id: tenantHistoryKey, Date: timestamp, Amount: -totalCost, OperationType: "Оплата брони", Description: `Бронь #${bookingId.substring(0,6)}: "${property.Title}"`, NewBalance: tenantNewBalance };
        const amountToCreditCompany = booking.AmountPaidToCompany || parseFloat(((booking.TotalCost || 0) * (1 - COMMISSION_RATE)).toFixed(2));
        if(amountToCreditCompany > 0) {
            const currentCompanyBalance = company.Balance || 0;
            const newCompanyBalance = parseFloat((currentCompanyBalance + amountToCreditCompany).toFixed(2));
            const companyHistoryKey = db.ref(`companies/${companyId}/balanceHistory`).push().key;
            if(!companyHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для компании.");
            updates[`/companies/${companyId}/Balance`] = newCompanyBalance;
            updates[`/companies/${companyId}/balanceHistory/${companyHistoryKey}`] = { Id: companyHistoryKey, Date: timestamp, Amount: amountToCreditCompany, OperationType: "Поступление (Аренда)", Description: `Подтверждение #${bookingId.substring(0,6)} (Общ:${totalCost.toFixed(2)}, Ком:${(totalCost - amountToCreditCompany).toFixed(2)})`, NewBalance: newCompanyBalance };
            log.info(`[Rental Confirm AJAX v6.2] Company ${companyId} credit prepared. New balance: ${newCompanyBalance}.`);
        } else { log.warn(`[Rental Confirm AJAX v6.2] Calculated amountToCreditCompany is zero or negative.`); }
        await db.ref().update(updates);
        log.info(`[Rental Confirm AJAX v6.2] SUCCESS. Booking ${bookingId} confirmed. Tenant balance: ${tenantNewBalance}.`);
        const tenantNotificationConfirm = { type: 'success', title: 'Бронь подтверждена', message: `Ваша бронь (#${bookingId.substring(0,6)}) для объекта "<strong>${property.Title || '?'}</strong>" (${booking.StartDate} - ${booking.EndDate}) была подтверждена.`, bookingId: bookingId };
        await firebaseService.addNotification(tenant.Username, tenantNotificationConfirm);
        const tenantRoomConfirm = `user:${tenant.Username}`;
        io.to(tenantRoomConfirm).emit('balance_updated', tenantNewBalance);
        io.to(tenantRoomConfirm).emit('booking_confirmed', { bookingId: bookingId, propertyTitle: property.Title || '?', startDate: booking.StartDate, endDate: booking.EndDate });
        log.info(`[Rental Confirm AJAX v6.2] Emitted 'booking_confirmed' and 'balance_updated' to tenant room ${tenantRoomConfirm}`);
        const teamNotificationConfirm = { type: 'success', title: 'Бронь подтверждена', message: `Бронь (#${bookingId.substring(0,6)}) для "<strong>${property.Title || '?'}</strong>" (Арендатор: ${tenant.FullName || tenant.Username}) <strong>подтверждена</strong> пользователем ${confirmerUser.username}.`, bookingId: bookingId };
        const socketDataConfirm = { bookingId: bookingId, newStatus: newStatus, changedBy: confirmerUser.username, propertyTitle: property.Title || '?', tenantName: tenant.FullName || tenant.Username };
        await notifyCompanyTeam(companyId, 'booking_status_changed', socketDataConfirm, confirmerUser.username, io, userSockets, 'confirm', teamNotificationConfirm);

        // --->>> ДОБАВЛЕНО: Удаление задачи Dashboard при подтверждении <<<---
        const taskIdToRemoveConfirmed = `book-${bookingId}`;
        const teamUsernamesConfirm = [company.ownerUsername, ...(company.staff ? Object.keys(company.staff) : [])].filter(Boolean);
        teamUsernamesConfirm.forEach(username => {
            const userRoom = `user:${username}`;
            io.to(userRoom).emit('dashboard:remove_task', taskIdToRemoveConfirmed);
            log.info(`[Rental Confirm] Emitted 'dashboard:remove_task' (${taskIdToRemoveConfirmed}) to room ${userRoom}`);
        });
        // --->>> КОНЕЦ ДОБАВЛЕНИЯ <<<---

        res.status(200).json({ success: true, message: 'Бронирование подтверждено.', newStatus: newStatus, tenantName: tenant.FullName || tenant.Username, propertyTitle: property.Title || '?' });
    } catch (error) {
        log.error(`[Rental Confirm AJAX v6.2] ERROR confirming booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдено") ? 404 : (error.message.includes("Недостаточно средств") ? 400 : 500);
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка подтверждения бронирования.' });
    }
});

// POST /:id/reject
router.post('/:id/reject', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => {
    const bookingId = req.params.id;
    const rejecterUser = req.session.user;
    const reason = req.body.reason || 'Отклонено владельцем/администрацией';
    const io = req.app.get('socketio');
    const userSockets = req.app.get('userSockets');
    log.info(`[Rental Reject AJAX v6.2] User ${rejecterUser.username} rejecting booking ${bookingId} with reason: ${reason}`);
    try {
        const booking = await firebaseService.getBookingById(bookingId);
        if (!booking) { throw new Error('Бронирование не найдено.'); }
        if (booking.Status !== 'Ожидает подтверждения') { throw new Error(`Броню нельзя отклонить (статус: ${booking.Status}).`); }
        const tenantUserId = booking.UserId;
        if (!tenantUserId) { throw new Error('Не указан ID арендатора в бронировании.'); }
        const property = await firebaseService.getPropertyById(booking.PropertyId);
        const tenant = await firebaseService.getUserByUsername(tenantUserId);
        const companyId = property?.companyId;
        const newStatus = 'Отклонена';
        await db.ref(`bookings/${bookingId}`).update({ Status: newStatus, RejectedAt: new Date().toISOString(), RejectedBy: rejecterUser.username, RejectedReason: reason });
        log.info(`[Rental Reject AJAX v6.2] SUCCESS. Booking ${bookingId} rejected.`);
        const tenantNotificationReject = { type: 'warning', title: 'Запрос отклонен', message: `Ваш запрос (#${bookingId.substring(0,6)}) на бронирование объекта "<strong>${property?.Title || '?'}</strong>" был отклонен.${reason ? ' Причина: ' + reason : ''}`, bookingId: bookingId };
        await firebaseService.addNotification(tenantUserId, tenantNotificationReject);
        const tenantRoomReject = `user:${tenantUserId}`;
        io.to(tenantRoomReject).emit('booking_rejected', { bookingId: bookingId, propertyTitle: property?.Title || '?', reason: reason });
        log.info(`[Rental Reject AJAX v6.2] Emitted 'booking_rejected' to tenant room ${tenantRoomReject}`);
        if (companyId) {
             const teamNotificationReject = { type: 'warning', title: 'Бронь отклонена', message: `Запрос (#${bookingId.substring(0,6)}) для "<strong>${property?.Title || '?'}</strong>" (Арендатор: ${tenant?.FullName || tenant?.Username || '?'}) <strong>отклонен</strong> пользователем ${rejecterUser.username}.${reason ? ' Причина: '+reason : ''}`, bookingId: bookingId };
             const socketDataReject = { bookingId: bookingId, newStatus: newStatus, reason: reason, changedBy: rejecterUser.username, propertyTitle: property?.Title || '?', tenantName: tenant?.FullName || tenant?.Username || '?' };
             await notifyCompanyTeam(companyId, 'booking_status_changed', socketDataReject, rejecterUser.username, io, userSockets, 'reject', teamNotificationReject);

             // --->>> ДОБАВЛЕНО: Удаление задачи Dashboard при отклонении <<<---
             const companyForNotify = await firebaseService.getCompanyById(companyId).catch(e => null);
             if (companyForNotify) {
                 const taskIdToRemoveRejected = `book-${bookingId}`;
                 const teamUsernamesReject = [companyForNotify.ownerUsername, ...(companyForNotify.staff ? Object.keys(companyForNotify.staff) : [])].filter(Boolean);
                 teamUsernamesReject.forEach(username => {
                     const userRoom = `user:${username}`;
                     io.to(userRoom).emit('dashboard:remove_task', taskIdToRemoveRejected);
                     log.info(`[Rental Reject] Emitted 'dashboard:remove_task' (${taskIdToRemoveRejected}) to room ${userRoom}`);
                 });
             } else { log.warn(`[Rental Reject] Could not find company ${companyId} to remove dashboard task.`); }
             // --->>> КОНЕЦ ДОБАВЛЕНИЯ <<<---
        }
        res.status(200).json({ success: true, message: 'Бронирование отклонено.', newStatus: newStatus, rejectedReason: reason, tenantName: tenant?.FullName || tenant?.Username || '?', propertyTitle: property?.Title || '?' });
    } catch (error) {
        log.error(`[Rental Reject AJAX v6.2] ERROR rejecting booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдено") ? 404 : 400;
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка отклонения бронирования.' });
    }
});

// POST /:id/cancel
router.post('/:id/cancel', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => {
    const bookingId = req.params.id;
    const cancellerUser = req.session.user;
    const io = req.app.get('socketio');
    const userSockets = req.app.get('userSockets');
    log.info(`[Rentals Cancel AJAX v6.2] User ${cancellerUser.username} cancelling booking ${bookingId}`);
    try {
        const booking = await firebaseService.getBookingById(bookingId);
        if (!booking) { throw new Error('Бронирование не найдено.'); }
        if (booking.Status !== 'Активна') { throw new Error(`Статус брони: "${booking.Status}". Аннуляция возможна только для активных броней.`); }
        const tenantUserId = booking.UserId;
        if (!tenantUserId) { throw new Error('Не указан ID арендатора в бронировании.'); }
        const property = await firebaseService.getPropertyById(booking.PropertyId);
        if (!property?.companyId) { throw new Error('Ошибка: не найдена компания объекта для обработки отмены.'); }
        const companyId = property.companyId;
        const updates = {};
        const timestamp = new Date().toISOString();
        const refundAmountTenant = booking.TotalCost || 0;
        const amountToDebitCompany = booking.AmountPaidToCompany ?? parseFloat(((booking.TotalCost || 0) * (1 - COMMISSION_RATE)).toFixed(2));
        let finalTenantBalance = null;
        const newStatus = 'Аннулирована';
        updates[`/bookings/${bookingId}/Status`] = newStatus;
        updates[`/bookings/${bookingId}/CancelledAt`] = timestamp;
        updates[`/bookings/${bookingId}/CancelledBy`] = cancellerUser.username;
        let tenant = null;
        if (refundAmountTenant > 0) {
            tenant = await firebaseService.getUserByUsername(tenantUserId);
            if (tenant) {
                 const currentTenantBalance = tenant.Balance || 0;
                 finalTenantBalance = parseFloat((currentTenantBalance + refundAmountTenant).toFixed(2));
                 updates[`/users/${tenantUserId}/Balance`] = finalTenantBalance;
                 const tenantHistoryKey = db.ref(`users/${tenantUserId}/BalanceHistory`).push().key;
                 if(!tenantHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для арендатора при аннуляции.");
                 updates[`/users/${tenantUserId}/BalanceHistory/${tenantHistoryKey}`] = { Id: tenantHistoryKey, Date: timestamp, Amount: refundAmountTenant, OperationType: "Возврат (Аннул. адм.)", Description: `Аннул. адм./влад. (${cancellerUser.username}) брони #${bookingId.substring(0,6)}`, NewBalance: finalTenantBalance };
                 log.info(`[Rentals Cancel v6.2] Tenant ${tenantUserId} refund prepared. New balance: ${finalTenantBalance}`);
            } else { log.error(`[Rentals Cancel v6.2] Tenant ${tenantUserId} not found! Refund cannot be processed.`); }
        } else { log.info(`[Rentals Cancel v6.2] No refund needed for tenant.`); }
        if (amountToDebitCompany > 0) {
            const company = await firebaseService.getCompanyById(companyId);
            if (!company) { throw new Error(`Компания ${companyId} не найдена для списания средств.`); }
            const currentCompanyBalance = company.Balance || 0;
            const newCompanyBalance = parseFloat((currentCompanyBalance - amountToDebitCompany).toFixed(2));
            const companyHistoryKey = db.ref(`companies/${companyId}/balanceHistory`).push().key;
            if(!companyHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для компании при аннуляции.");
            updates[`/companies/${companyId}/Balance`] = newCompanyBalance;
            updates[`/companies/${companyId}/balanceHistory/${companyHistoryKey}`] = { Id: companyHistoryKey, Date: timestamp, Amount: -amountToDebitCompany, OperationType: "Списание (Аннул. адм.)", Description: `Аннул. адм./влад. (${cancellerUser.username}) брони #${bookingId.substring(0,6)}`, NewBalance: newCompanyBalance };
            log.info(`[Rentals Cancel v6.2] Company ${companyId} debit prepared. New balance: ${newCompanyBalance}.`);
        } else { log.info(`[Rentals Cancel v6.2] No company debit needed.`); }
        await db.ref().update(updates);
        log.info(`[Rentals Cancel v6.2] SUCCESS. Booking ${bookingId} status changed to: ${newStatus}.`);
        const tenantNotificationCancel = { type: 'error', title: 'Бронь аннулирована', message: `Ваша активная бронь (#${bookingId.substring(0,6)}) для объекта "<strong>${property?.Title || '?'}</strong>" была аннулирована администрацией (пользователь ${cancellerUser.username}).${finalTenantBalance !== null ? ' Средства возвращены на баланс.' : ''}`, bookingId: bookingId };
        await firebaseService.addNotification(tenantUserId, tenantNotificationCancel);
        const tenantRoomCancel = `user:${tenantUserId}`;
        if (finalTenantBalance !== null) { io.to(tenantRoomCancel).emit('balance_updated', finalTenantBalance); }
        io.to(tenantRoomCancel).emit('booking_cancelled_by_owner', { bookingId: bookingId, propertyTitle: property?.Title || '?', cancelledBy: cancellerUser.username });
        log.info(`[Rentals Cancel v6.2] Emitted notifications to tenant room ${tenantRoomCancel}`);
        const teamNotificationCancel = { type: 'error', title: 'Бронь аннулирована', message: `Активная бронь (#${bookingId.substring(0,6)}) для "<strong>${property?.Title || '?'}</strong>" (Арендатор: ${tenant?.FullName || tenant?.Username || '?'}) <strong>аннулирована</strong> пользователем ${cancellerUser.username}.`, bookingId: bookingId };
        const socketDataCancel = { bookingId: bookingId, newStatus: newStatus, changedBy: cancellerUser.username, propertyTitle: property?.Title || '?', tenantName: tenant?.FullName || tenant?.Username || '?' };
        await notifyCompanyTeam(companyId, 'booking_status_changed', socketDataCancel, cancellerUser.username, io, userSockets, 'cancel_admin', teamNotificationCancel);
        if (cancellerUser.username === tenantUserId && finalTenantBalance !== null) {
             req.session.user.balance = finalTenantBalance;
             req.session.save(err => { if(err) console.error("[Rentals Cancel v6.2] Error saving canceller's own session:", err); });
        }
        let successMessage = `Бронирование успешно аннулировано.`;
        if (refundAmountTenant > 0 && finalTenantBalance !== null) { successMessage += ` Средства (${refundAmountTenant.toFixed(2)} RUB) возвращены арендатору.`; }
        else if (refundAmountTenant > 0 && finalTenantBalance === null) { successMessage += ` Ошибка возврата средств арендатору (не найден).`; }
        res.status(200).json({ success: true, message: successMessage, newStatus: newStatus, tenantName: tenant?.FullName || tenant?.Username || '?', propertyTitle: property?.Title || '?' });
    } catch (error) {
        log.error(`[Rentals Cancel v6.2] ERROR cancelling booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдено") ? 404 : 400;
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка аннулирования бронирования.' });
    }
});

// POST /:id/delete (Admin Only)
router.post('/:id/delete', isLoggedIn, isAdmin, async (req, res, next) => {
    const bookingId = req.params.id;
    const adminUsername = req.session.user.username;
    log.info(`[Rentals AJAX Delete v6.2] START: Admin ${adminUsername} deleting booking ${bookingId}`);
     try {
         const booking = await firebaseService.getBookingById(bookingId);
         if (!booking) { throw new Error("Запись бронирования не найдена."); }
         if (booking.Status === 'Активна' || booking.Status === 'Ожидает подтверждения') { throw new Error("Нельзя удалить запись об активном или ожидающем бронировании. Сначала измените его статус."); }
         await firebaseService.deleteBooking(bookingId);
         log.info(`[Rentals AJAX Delete v6.2] SUCCESS: Booking ${bookingId} record deleted.`);
         res.status(200).json({ success: true, message: 'Запись о бронировании успешно удалена.' });
    } catch (error) {
        log.error(`[Rentals AJAX Delete v6.2] ERROR deleting booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдена") ? 404 : (error.message.includes("Нельзя удалить") ? 400 : 500);
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка удаления записи о бронировании.' });
    }
});

module.exports = router;