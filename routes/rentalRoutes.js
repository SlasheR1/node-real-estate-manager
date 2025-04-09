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

// --- Helper Функция для отправки уведомлений команде ---
// Сохраняет в БД И отправляет онлайн-юзерам, исключая пользователя, совершившего действие
async function notifyCompanyTeam(companyId, eventName, data, excludedUsername, ioInstance, userSocketsMap, actionSource = 'system', notificationDetails = null) {
    if (!companyId || !ioInstance || !notificationDetails || !userSocketsMap) { // Добавлена проверка userSocketsMap
        log.warn(`[notifyCompanyTeamV6.1] Missing required data. CompanyID: ${companyId}, Event: ${eventName}, Details: ${!!notificationDetails}, SocketsProvided: ${!!userSocketsMap}`);
        return;
    }
    log.info(`[notifyCompanyTeamV6.1] Preparing '${eventName}' DB notification for company ${companyId}, excluding ${excludedUsername}. Source: ${actionSource}`);
    try {
        const company = await firebaseService.getCompanyById(companyId);
        if (!company) { log.warn(`[notifyCompanyTeamV6.1] Company ${companyId} not found.`); return; }

        const ownerUsername = company.ownerUsername;
        const staffUsernames = company.staff ? Object.keys(company.staff) : [];
        const recipients = [...new Set([ownerUsername, ...staffUsernames])].filter(uname => uname && uname !== excludedUsername);

        if (recipients.length > 0) {
            log.info(`[notifyCompanyTeamV6.1] Recipients for '${eventName}' (Company ${companyId}): ${recipients.join(', ')}`);
            const dbPromises = recipients.map(recipient =>
                firebaseService.addNotification(recipient, notificationDetails)
            );
            await Promise.all(dbPromises);
            log.info(`[notifyCompanyTeamV6.1] Saved DB notifications for ${recipients.length} recipients.`);

            recipients.forEach(recipient => {
                 // Используем переданную карту userSocketsMap
                 const recipientSocketId = userSocketsMap[recipient];
                 // Изменено: Эмитим в комнату, а не напрямую по ID сокета
                 const targetRoom = `user:${recipient}`;
                 if (recipientSocketId) { // Проверяем, что пользователь онлайн (сокет ID известен)
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

// GET /: Отображение страницы управления арендами
router.get('/', isLoggedIn, async (req, res, next) => {
    const currentUser = req.session.user;
    // Доступ только для Admin, Owner, Staff
    if (!currentUser || (currentUser.role !== 'Admin' && currentUser.role !== 'Owner' && currentUser.role !== 'Staff')) {
        req.session.message = {type:'error', text:'Доступ запрещен.'};
        return res.redirect('/');
    }
    log.info(`[GET /rentals v6.1] Accessing rentals management for user: ${currentUser.username}, Role: ${currentUser.role}`); // Увеличена версия в логе

    try {
        let properties = [];
        let allBookings = [];
        let allUsers = [];

        // Загрузка данных с фильтрацией по компании
        if (currentUser.role === 'Admin') {
            log.info("[Rentals GET v6.1] Fetching all data for Admin");
            [allBookings, properties, allUsers] = await Promise.allSettled([
                firebaseService.getAllBookings(),
                firebaseService.getAllProperties(),
                firebaseService.getAllUsers()
            ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));
        } else if ((currentUser.role === 'Owner' || currentUser.role === 'Staff') && currentUser.companyId) {
            const companyId = currentUser.companyId;
            log.info(`[Rentals GET v6.1] Fetching data for Company ID ${companyId}`);
            [properties, allBookings, allUsers] = await Promise.allSettled([
                 firebaseService.getPropertiesByCompanyId(companyId),
                 firebaseService.getAllBookings(), // Получаем все брони, отфильтруем ниже
                 firebaseService.getAllUsers()    // Получаем всех пользователей для имен
             ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));
        } else {
             log.warn(`[Rentals GET v6.1] Access denied or invalid state for ${currentUser.username} (Role: ${currentUser.role}, CompanyId: ${currentUser.companyId})`);
             return res.render('rentals-management', { title: 'Управление арендами', bookings: [], message: {type:'error', text:'Ошибка: Не удалось определить вашу компанию.'} });
        }

        // Подготовка карт для быстрого поиска
        const propertiesMap = new Map( (Array.isArray(properties)?properties:[]).map(p => p ? [p.Id, { title: p.Title, companyId: p.companyId }] : null).filter(Boolean)); // Добавлена проверка p
        const usersMap = new Map( (Array.isArray(allUsers)?allUsers:[]).map(u => u ? [u.Username, u.FullName || u.Username] : null).filter(Boolean)); // Добавлена проверка u

        // Фильтрация бронирований по объектам (нужно только если НЕ админ)
        let filteredBookings;
        if (currentUser.role === 'Admin') {
            filteredBookings = Array.isArray(allBookings) ? allBookings : [];
        } else {
            const companyPropertyIds = Array.from(propertiesMap.keys());
            filteredBookings = (Array.isArray(allBookings) ? allBookings : []).filter(booking => booking && booking.PropertyId && companyPropertyIds.includes(booking.PropertyId));
        }

        // Форматирование данных для отображения
        const bookingsWithDetails = filteredBookings.map(booking => {
             if(!booking || !booking.Id) return null;
             const propInfo = booking.PropertyId ? propertiesMap.get(booking.PropertyId) : null;
             const tenantName = booking.UserId ? usersMap.get(booking.UserId) : '???';
             return {
                 ...booking,
                 PropertyTitle: propInfo ? propInfo.title : 'Объект удален?',
                 TenantName: tenantName,
                 StartDateFormatted: booking.StartDate ? new Date(booking.StartDate).toLocaleDateString('ru-RU') : '?',
                 EndDateFormatted: booking.EndDate ? new Date(booking.EndDate).toLocaleDateString('ru-RU') : '?',
                 RejectedReason: booking.RejectedReason || null
             };
        }).filter(Boolean)
          .sort((a, b) => {
                const statusOrder = { 'Ожидает подтверждения': 1, 'Активна': 2 };
                const statusA = statusOrder[a.Status] || 3;
                const statusB = statusOrder[b.Status] || 3;
                if (statusA !== statusB) return statusA - statusB;
                return new Date(b.CreatedAt || 0) - new Date(a.CreatedAt || 0);
            });

        const message = req.session.message || null; if (req.session.message) delete req.session.message;

        res.render('rentals-management', {
            title: 'Управление арендами',
            bookings: bookingsWithDetails,
            message: message,
            // Передаем isAdminUser в шаблон для JS
            isAdminUser: currentUser.role === 'Admin'
        });

    } catch (error) {
        log.error("[Rentals GET v6.1] Error fetching rentals list:", error);
        next(error);
    }
});

// POST /:id/confirm (Подтверждение брони)
router.post('/:id/confirm', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => {
    const bookingId = req.params.id;
    const confirmerUser = req.session.user;
    const io = req.app.get('socketio');
    const userSockets = req.app.get('userSockets'); // Получаем актуальную карту
    log.info(`[Rental Confirm AJAX v6.1] User ${confirmerUser.username} confirming booking ${bookingId}`);

    try {
        const booking = await firebaseService.getBookingById(bookingId);
        if (!booking) { throw new Error('Бронирование не найдено.'); }
        if (booking.Status !== 'Ожидает подтверждения') { throw new Error(`Броню нельзя подтвердить (статус: ${booking.Status}).`); }
        const tenantUserId = booking.UserId; // Получаем ID арендатора
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

        // --- Если средств недостаточно, отклоняем бронь ---
        if (currentBalance < totalCost) {
            log.warn(`[Rental Confirm AJAX v6.1] Insufficient funds for tenant ${tenant.Username} on confirm.`);
            const rejectionReason = 'Недостаточно средств на момент подтверждения';
            const timestampReject = new Date().toISOString();
            await db.ref(`bookings/${bookingId}`).update({ Status: 'Отклонена', RejectedAt: timestampReject, RejectedBy: confirmerUser.username, RejectedReason: rejectionReason });

            // Уведомление арендатору (через БД и сокет В КОМНАТУ)
            const tenantNotificationReject = { type: 'warning', title: 'Запрос отклонен', message: `Ваш запрос (#${bookingId.substring(0,6)}) на бронирование объекта "<strong>${property.Title || '?'}</strong>" был отклонен. Причина: ${rejectionReason}.`, bookingId: bookingId };
            await firebaseService.addNotification(tenant.Username, tenantNotificationReject);
            // Изменено: эмитим в комнату
            const tenantRoomReject = `user:${tenant.Username}`;
            io.to(tenantRoomReject).emit('booking_rejected', { bookingId: bookingId, reason: rejectionReason, propertyTitle: property.Title || '?' });
            log.info(`[Rental Confirm AJAX v6.1] Emitted 'booking_rejected' to tenant room ${tenantRoomReject}`);
            // УБРАНО: const tenantSocketIdReject = userSockets[tenant.Username]; if (tenantSocketIdReject) { ... }

             // Уведомление команде (через БД и сокет В КОМНАТУ)
             const teamNotificationReject = {
                  type: 'warning', title: 'Бронь отклонена (средства)',
                  message: `Запрос (#${bookingId.substring(0,6)}) для "<strong>${property.Title || '?'}</strong>" (Арендатор: ${tenant.FullName || tenant.Username}) <strong>автоматически отклонен</strong> из-за недостатка средств при попытке подтверждения пользователем ${confirmerUser.username}.`,
                  bookingId: bookingId
             };
             const socketDataReject = { bookingId: bookingId, newStatus: 'Отклонена', reason: rejectionReason, changedBy: confirmerUser.username, propertyTitle: property.Title || '?', tenantName: tenant.FullName || tenant.Username };
             // Изменено: Передаем userSockets
             await notifyCompanyTeam(companyId, 'booking_status_changed', socketDataReject, confirmerUser.username, io, userSockets, 'confirm_insufficient_funds', teamNotificationReject);

            // Важно: бросаем ошибку, чтобы ответ клиенту был с кодом 400
            throw new Error('Недостаточно средств у арендатора для подтверждения. Бронь отклонена.');
        }

        // Готовим атомарное обновление
        const updates = {};
        const timestamp = new Date().toISOString();
        const newStatus = 'Активна';
        updates[`/bookings/${bookingId}/Status`] = newStatus;
        updates[`/bookings/${bookingId}/ConfirmedAt`] = timestamp;
        updates[`/bookings/${bookingId}/ConfirmedBy`] = confirmerUser.username;
        updates[`/bookings/${bookingId}/RejectedReason`] = null; // Очищаем причину отказа, если была

        const tenantNewBalance = parseFloat((currentBalance - totalCost).toFixed(2));
        const tenantHistoryKey = db.ref(`users/${tenant.Username}/BalanceHistory`).push().key;
        if(!tenantHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для арендатора.");
        updates[`/users/${tenant.Username}/Balance`] = tenantNewBalance;
        updates[`/users/${tenant.Username}/BalanceHistory/${tenantHistoryKey}`] = { Id: tenantHistoryKey, Date: timestamp, Amount: -totalCost, OperationType: "Оплата брони", Description: `Бронь #${bookingId.substring(0,6)}: "${property.Title}"`, NewBalance: tenantNewBalance };

        const amountToCreditCompany = booking.AmountPaidToCompany || parseFloat(((booking.TotalCost || 0) * (1 - COMMISSION_RATE)).toFixed(2)); // Пересчитываем на всякий случай
        if(amountToCreditCompany > 0) {
            const currentCompanyBalance = company.Balance || 0;
            const newCompanyBalance = parseFloat((currentCompanyBalance + amountToCreditCompany).toFixed(2));
            const companyHistoryKey = db.ref(`companies/${companyId}/balanceHistory`).push().key;
             if(!companyHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для компании.");
            updates[`/companies/${companyId}/Balance`] = newCompanyBalance;
            updates[`/companies/${companyId}/balanceHistory/${companyHistoryKey}`] = { Id: companyHistoryKey, Date: timestamp, Amount: amountToCreditCompany, OperationType: "Поступление (Аренда)", Description: `Подтверждение #${bookingId.substring(0,6)} (Общ:${totalCost.toFixed(2)}, Ком:${(totalCost - amountToCreditCompany).toFixed(2)})`, NewBalance: newCompanyBalance };
            log.info(`[Rental Confirm AJAX v6.1] Company ${companyId} credit prepared. New balance: ${newCompanyBalance}.`);
        } else { log.warn(`[Rental Confirm AJAX v6.1] Calculated amountToCreditCompany is zero or negative. Skipping company credit.`); } // Изменено на warn

        // Выполняем обновление
        await db.ref().update(updates);
        log.info(`[Rental Confirm AJAX v6.1] SUCCESS. Booking ${bookingId} confirmed. Tenant balance: ${tenantNewBalance}.`);

        // --- УВЕДОМЛЕНИЯ ---
        // Арендатору
        const tenantNotificationConfirm = { type: 'success', title: 'Бронь подтверждена', message: `Ваша бронь (#${bookingId.substring(0,6)}) для объекта "<strong>${property.Title || '?'}</strong>" (${booking.StartDate} - ${booking.EndDate}) была подтверждена.`, bookingId: bookingId };
        await firebaseService.addNotification(tenant.Username, tenantNotificationConfirm);
        // Изменено: Эмитим в комнату
        const tenantRoomConfirm = `user:${tenant.Username}`;
        io.to(tenantRoomConfirm).emit('balance_updated', tenantNewBalance);
        io.to(tenantRoomConfirm).emit('booking_confirmed', { bookingId: bookingId, propertyTitle: property.Title || '?', startDate: booking.StartDate, endDate: booking.EndDate });
        log.info(`[Rental Confirm AJAX v6.1] Emitted 'booking_confirmed' and 'balance_updated' to tenant room ${tenantRoomConfirm}`);
        // УБРАНО: const tenantSocketIdConfirm = userSockets[tenant.Username]; if (tenantSocketIdConfirm) { ... }

        // Команде
        const teamNotificationConfirm = {
             type: 'success', title: 'Бронь подтверждена',
             message: `Бронь (#${bookingId.substring(0,6)}) для "<strong>${property.Title || '?'}</strong>" (Арендатор: ${tenant.FullName || tenant.Username}) <strong>подтверждена</strong> пользователем ${confirmerUser.username}.`,
             bookingId: bookingId
        };
        const socketDataConfirm = { bookingId: bookingId, newStatus: newStatus, changedBy: confirmerUser.username, propertyTitle: property.Title || '?', tenantName: tenant.FullName || tenant.Username };
        // Изменено: Передаем userSockets
        await notifyCompanyTeam(companyId, 'booking_status_changed', socketDataConfirm, confirmerUser.username, io, userSockets, 'confirm', teamNotificationConfirm);
        // --- КОНЕЦ УВЕДОМЛЕНИЙ ---

        res.status(200).json({ success: true, message: 'Бронирование подтверждено.', newStatus: newStatus, tenantName: tenant.FullName || tenant.Username, propertyTitle: property.Title || '?' });

    } catch (error) {
        log.error(`[Rental Confirm AJAX v6.1] ERROR confirming booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдено") ? 404 : (error.message.includes("Недостаточно средств") ? 400 : 500);
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка подтверждения бронирования.' });
    }
});

// POST /:id/reject (Отклонение брони)
router.post('/:id/reject', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => {
    const bookingId = req.params.id;
    const rejecterUser = req.session.user;
    const reason = req.body.reason || 'Отклонено владельцем/администрацией'; // Получаем причину из тела запроса
    const io = req.app.get('socketio');
    const userSockets = req.app.get('userSockets'); // Получаем карту сокетов
    log.info(`[Rental Reject AJAX v6.1] User ${rejecterUser.username} rejecting booking ${bookingId} with reason: ${reason}`);

    try {
        const booking = await firebaseService.getBookingById(bookingId);
        if (!booking) { throw new Error('Бронирование не найдено.'); }
        if (booking.Status !== 'Ожидает подтверждения') { throw new Error(`Броню нельзя отклонить (статус: ${booking.Status}).`); }
        const tenantUserId = booking.UserId; // ID арендатора
        if (!tenantUserId) { throw new Error('Не указан ID арендатора в бронировании.'); }

        const property = await firebaseService.getPropertyById(booking.PropertyId);
        const tenant = await firebaseService.getUserByUsername(tenantUserId); // Получаем данные арендатора
        const companyId = property?.companyId;
        const newStatus = 'Отклонена';

        await db.ref(`bookings/${bookingId}`).update({ Status: newStatus, RejectedAt: new Date().toISOString(), RejectedBy: rejecterUser.username, RejectedReason: reason });
        log.info(`[Rental Reject AJAX v6.1] SUCCESS. Booking ${bookingId} rejected.`);

        // --- УВЕДОМЛЕНИЯ ---
        // Арендатору
        const tenantNotificationReject = { type: 'warning', title: 'Запрос отклонен', message: `Ваш запрос (#${bookingId.substring(0,6)}) на бронирование объекта "<strong>${property?.Title || '?'}</strong>" был отклонен.${reason ? ' Причина: ' + reason : ''}`, bookingId: bookingId };
        await firebaseService.addNotification(tenantUserId, tenantNotificationReject);
        // Изменено: Эмитим в комнату
        const tenantRoomReject = `user:${tenantUserId}`;
        io.to(tenantRoomReject).emit('booking_rejected', { bookingId: bookingId, propertyTitle: property?.Title || '?', reason: reason });
        log.info(`[Rental Reject AJAX v6.1] Emitted 'booking_rejected' to tenant room ${tenantRoomReject}`);
        // УБРАНО: const tenantSocketIdReject = userSockets[booking.UserId]; if (tenantSocketIdReject) { ... }

        // Команде
         if (companyId) {
              const teamNotificationReject = {
                   type: 'warning', title: 'Бронь отклонена',
                   message: `Запрос (#${bookingId.substring(0,6)}) для "<strong>${property?.Title || '?'}</strong>" (Арендатор: ${tenant?.FullName || tenant?.Username || '?'}) <strong>отклонен</strong> пользователем ${rejecterUser.username}.${reason ? ' Причина: '+reason : ''}`,
                   bookingId: bookingId
              };
              const socketDataReject = { bookingId: bookingId, newStatus: newStatus, reason: reason, changedBy: rejecterUser.username, propertyTitle: property?.Title || '?', tenantName: tenant?.FullName || tenant?.Username || '?' };
              // Изменено: Передаем userSockets
              await notifyCompanyTeam(companyId, 'booking_status_changed', socketDataReject, rejecterUser.username, io, userSockets, 'reject', teamNotificationReject);
         }
        // --- КОНЕЦ УВЕДОМЛЕНИЙ ---

        res.status(200).json({ success: true, message: 'Бронирование отклонено.', newStatus: newStatus, rejectedReason: reason, tenantName: tenant?.FullName || tenant?.Username || '?', propertyTitle: property?.Title || '?' });

    } catch (error) {
        log.error(`[Rental Reject AJAX v6.1] ERROR rejecting booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдено") ? 404 : 400;
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка отклонения бронирования.' });
    }
});

// POST /:id/cancel (Аннулирование админом/владельцем)
router.post('/:id/cancel', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => {
    const bookingId = req.params.id;
    const cancellerUser = req.session.user;
    const io = req.app.get('socketio');
    const userSockets = req.app.get('userSockets'); // Получаем карту сокетов
    log.info(`[Rentals Cancel AJAX v6.1] User ${cancellerUser.username} cancelling booking ${bookingId}`);

    try {
        const booking = await firebaseService.getBookingById(bookingId);
        if (!booking) { throw new Error('Бронирование не найдено.'); }
        if (booking.Status !== 'Активна') { throw new Error(`Статус брони: "${booking.Status}". Аннуляция возможна только для активных броней.`); } // Уточнил сообщение
        const tenantUserId = booking.UserId; // ID арендатора
        if (!tenantUserId) { throw new Error('Не указан ID арендатора в бронировании.'); }

        const property = await firebaseService.getPropertyById(booking.PropertyId);
        if (!property?.companyId) { throw new Error('Ошибка: не найдена компания объекта для обработки отмены.'); }
        const companyId = property.companyId;

        // Подготовка обновлений
        const updates = {};
        const timestamp = new Date().toISOString();
        const refundAmountTenant = booking.TotalCost || 0;
        // Пересчет суммы для списания с компании на случай, если AmountPaidToCompany не было записано
        const amountToDebitCompany = booking.AmountPaidToCompany ?? parseFloat(((booking.TotalCost || 0) * (1 - COMMISSION_RATE)).toFixed(2));
        let finalTenantBalance = null;
        const newStatus = 'Аннулирована'; // Статус для отмены админом/владельцем

        // 1. Обновляем бронь
        updates[`/bookings/${bookingId}/Status`] = newStatus;
        updates[`/bookings/${bookingId}/CancelledAt`] = timestamp;
        updates[`/bookings/${bookingId}/CancelledBy`] = cancellerUser.username; // Записываем кто аннулировал

        let tenant = null;
        // 2. Возвращаем средства арендатору
        if (refundAmountTenant > 0) {
            tenant = await firebaseService.getUserByUsername(tenantUserId);
            if (tenant) {
                 const currentTenantBalance = tenant.Balance || 0;
                 finalTenantBalance = parseFloat((currentTenantBalance + refundAmountTenant).toFixed(2));
                 updates[`/users/${tenantUserId}/Balance`] = finalTenantBalance;
                 const tenantHistoryKey = db.ref(`users/${tenantUserId}/BalanceHistory`).push().key;
                 if(!tenantHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для арендатора при аннуляции.");
                 updates[`/users/${tenantUserId}/BalanceHistory/${tenantHistoryKey}`] = { Id: tenantHistoryKey, Date: timestamp, Amount: refundAmountTenant, OperationType: "Возврат (Аннул. адм.)", Description: `Аннул. адм./влад. (${cancellerUser.username}) брони #${bookingId.substring(0,6)}`, NewBalance: finalTenantBalance };
                 log.info(`[Rentals Cancel v6.1] Tenant ${tenantUserId} refund prepared. New balance: ${finalTenantBalance}`);
            } else { log.error(`[Rentals Cancel v6.1] Tenant ${tenantUserId} not found! Refund cannot be processed.`); }
        } else { log.info(`[Rentals Cancel v6.1] No refund needed for tenant.`); }

        // 3. Списываем средства с компании
        if (amountToDebitCompany > 0) {
            const company = await firebaseService.getCompanyById(companyId);
            if (!company) { throw new Error(`Компания ${companyId} не найдена для списания средств.`); }
            const currentCompanyBalance = company.Balance || 0;
            const newCompanyBalance = parseFloat((currentCompanyBalance - amountToDebitCompany).toFixed(2));
            const companyHistoryKey = db.ref(`companies/${companyId}/balanceHistory`).push().key;
            if(!companyHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для компании при аннуляции.");
            updates[`/companies/${companyId}/Balance`] = newCompanyBalance;
            updates[`/companies/${companyId}/balanceHistory/${companyHistoryKey}`] = { Id: companyHistoryKey, Date: timestamp, Amount: -amountToDebitCompany, OperationType: "Списание (Аннул. адм.)", Description: `Аннул. адм./влад. (${cancellerUser.username}) брони #${bookingId.substring(0,6)}`, NewBalance: newCompanyBalance };
            log.info(`[Rentals Cancel v6.1] Company ${companyId} debit prepared. New balance: ${newCompanyBalance}.`);
        } else { log.info(`[Rentals Cancel v6.1] No company debit needed.`); }

        // Выполняем атомарное обновление
        await db.ref().update(updates);
        log.info(`[Rentals Cancel v6.1] SUCCESS. Booking ${bookingId} status changed to: ${newStatus}.`);

        // --- УВЕДОМЛЕНИЯ ---
        // Арендатору
        const tenantNotificationCancel = { type: 'error', title: 'Бронь аннулирована', message: `Ваша активная бронь (#${bookingId.substring(0,6)}) для объекта "<strong>${property?.Title || '?'}</strong>" была аннулирована администрацией (пользователь ${cancellerUser.username}).${finalTenantBalance !== null ? ' Средства возвращены на баланс.' : ''}`, bookingId: bookingId };
        await firebaseService.addNotification(tenantUserId, tenantNotificationCancel);
        // Изменено: Эмитим в комнату
        const tenantRoomCancel = `user:${tenantUserId}`;
        if (finalTenantBalance !== null) { io.to(tenantRoomCancel).emit('balance_updated', finalTenantBalance); }
        io.to(tenantRoomCancel).emit('booking_cancelled_by_owner', { bookingId: bookingId, propertyTitle: property?.Title || '?', cancelledBy: cancellerUser.username });
        log.info(`[Rentals Cancel v6.1] Emitted notifications to tenant room ${tenantRoomCancel}`);
        // УБРАНО: const tenantSocketIdCancel = userSockets[tenantUserId]; if (tenantSocketIdCancel) { ... }

        // Команде
        const teamNotificationCancel = {
             type: 'error', title: 'Бронь аннулирована',
             message: `Активная бронь (#${bookingId.substring(0,6)}) для "<strong>${property?.Title || '?'}</strong>" (Арендатор: ${tenant?.FullName || tenant?.Username || '?'}) <strong>аннулирована</strong> пользователем ${cancellerUser.username}.`,
             bookingId: bookingId
        };
        const socketDataCancel = { bookingId: bookingId, newStatus: newStatus, changedBy: cancellerUser.username, propertyTitle: property?.Title || '?', tenantName: tenant?.FullName || tenant?.Username || '?' };
        // Изменено: Передаем userSockets
        await notifyCompanyTeam(companyId, 'booking_status_changed', socketDataCancel, cancellerUser.username, io, userSockets, 'cancel_admin', teamNotificationCancel);
        // --- КОНЕЦ УВЕДОМЛЕНИЙ ---

        // Обновляем сессию cancellerUser только если это арендатор сам себе отменил (очень маловероятно здесь)
        if (cancellerUser.username === tenantUserId && finalTenantBalance !== null) {
             req.session.user.balance = finalTenantBalance;
             req.session.save(err => { if(err) console.error("[Rentals Cancel v6.1] Error saving canceller's own session:", err); });
        }

        let successMessage = `Бронирование успешно аннулировано.`;
        if (refundAmountTenant > 0 && finalTenantBalance !== null) { successMessage += ` Средства (${refundAmountTenant.toFixed(2)} RUB) возвращены арендатору.`; }
        else if (refundAmountTenant > 0 && finalTenantBalance === null) { successMessage += ` Ошибка возврата средств арендатору (не найден).`; }
        res.status(200).json({ success: true, message: successMessage, newStatus: newStatus, tenantName: tenant?.FullName || tenant?.Username || '?', propertyTitle: property?.Title || '?' });

    } catch (error) {
        log.error(`[Rentals Cancel v6.1] ERROR cancelling booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдено") ? 404 : 400;
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка аннулирования бронирования.' });
    }
});

// POST /:id/delete (Admin Only)
router.post('/:id/delete', isLoggedIn, isAdmin, async (req, res, next) => {
    const bookingId = req.params.id;
    const adminUsername = req.session.user.username; // Используем username из сессии
    log.info(`[Rentals AJAX Delete v6.1] START: Admin ${adminUsername} deleting booking ${bookingId}`);
     try {
         const booking = await firebaseService.getBookingById(bookingId);
         if (!booking) { throw new Error("Запись бронирования не найдена."); }
         // Проверяем статус - нельзя удалять активные или ожидающие
         if (booking.Status === 'Активна' || booking.Status === 'Ожидает подтверждения') {
             throw new Error("Нельзя удалить запись об активном или ожидающем бронировании. Сначала измените его статус (аннулируйте/отклоните).");
         }
         await firebaseService.deleteBooking(bookingId); // Удаляем из Firebase
         log.info(`[Rentals AJAX Delete v6.1] SUCCESS: Booking ${bookingId} record deleted.`);
         res.status(200).json({ success: true, message: 'Запись о бронировании успешно удалена.' });
    } catch (error) {
        log.error(`[Rentals AJAX Delete v6.1] ERROR deleting booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдена") ? 404 : (error.message.includes("Нельзя удалить") ? 400 : 500);
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка удаления записи о бронировании.' });
    }
});

module.exports = router; // Экспорт роутера