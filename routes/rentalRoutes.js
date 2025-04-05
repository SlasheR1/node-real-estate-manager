// routes/rentalRoutes.js
const express = require('express');
const firebaseService = require('../services/firebaseService');
const { isLoggedIn, isAdmin } = require('../middleware/authMiddleware'); // isAdmin нужен для delete
const { isCompanyMemberOrAdmin } = require('../middleware/companyMiddleware'); // Для confirm/reject/cancel
const admin = require('firebase-admin');
const db = admin.database();

const router = express.Router();
const COMMISSION_RATE = 0.15; // Ставка комиссии

// GET /: Отображение страницы управления арендами
router.get('/', isLoggedIn, async (req, res, next) => {
    const currentUser = req.session.user;
    // Доступ только для Admin, Owner, Staff
    if (!currentUser || (currentUser.role !== 'Admin' && currentUser.role !== 'Owner' && currentUser.role !== 'Staff')) {
        req.session.message = {type:'error', text:'Доступ запрещен.'};
        return res.redirect('/');
    }
    console.log(`[GET /rentals v4 - Rooms] Accessing rentals management for user: ${currentUser.username}, Role: ${currentUser.role}`);

    try {
        let properties = [];
        let allBookings = [];
        let allUsers = [];

        // Загрузка данных с фильтрацией по компании
        if (currentUser.role === 'Admin') {
            console.log("[Rentals GET v4] Fetching all data for Admin");
            [allBookings, properties, allUsers] = await Promise.allSettled([
                firebaseService.getAllBookings(),
                firebaseService.getAllProperties(),
                firebaseService.getAllUsers()
            ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));
        } else if ((currentUser.role === 'Owner' || currentUser.role === 'Staff') && currentUser.companyId) {
            const companyId = currentUser.companyId;
            console.log(`[Rentals GET v4] Fetching data for Company ID ${companyId}`);
            [properties, allBookings, allUsers] = await Promise.allSettled([
                 firebaseService.getPropertiesByCompanyId(companyId),
                 firebaseService.getAllBookings(), // Получаем все брони, отфильтруем ниже
                 firebaseService.getAllUsers()    // Получаем всех пользователей для имен
             ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));
        } else {
             // Если Owner/Staff, но нет companyId (маловероятно из-за middleware, но для надежности)
             console.warn(`[Rentals GET v4] Access denied or invalid state for ${currentUser.username} (Role: ${currentUser.role}, CompanyId: ${currentUser.companyId})`);
             return res.render('rentals-management', { title: 'Управление арендами', bookings: [], message: {type:'error', text:'Ошибка: Не удалось определить вашу компанию.'} });
        }

        // Подготовка карт для быстрого поиска
        const propertiesMap = new Map( (Array.isArray(properties)?properties:[]).map(p => [p?.Id, { title: p?.Title, companyId: p?.companyId }]).filter(e => e[0]));
        const usersMap = new Map( (Array.isArray(allUsers)?allUsers:[]).map(u => [u?.Username, u?.FullName || u?.Username]).filter(e => e[0]));

        // Фильтрация бронирований по объектам (нужно только если НЕ админ)
        let filteredBookings;
        if (currentUser.role === 'Admin') {
            filteredBookings = Array.isArray(allBookings) ? allBookings : [];
        } else {
            // Оставляем только брони по объектам, которые принадлежат компании пользователя
            const companyPropertyIds = Array.from(propertiesMap.keys());
            filteredBookings = (Array.isArray(allBookings) ? allBookings : []).filter(booking => booking && booking.PropertyId && companyPropertyIds.includes(booking.PropertyId));
        }

        // Форматирование данных для отображения
        const bookingsWithDetails = filteredBookings.map(booking => {
             if(!booking || !booking.Id) return null; // Доп проверка
             const propInfo = booking.PropertyId ? propertiesMap.get(booking.PropertyId) : null;
             const tenantName = booking.UserId ? usersMap.get(booking.UserId) : '???';
             return {
                 ...booking,
                 PropertyTitle: propInfo ? propInfo.title : 'Объект удален?',
                 TenantName: tenantName,
                 StartDateFormatted: booking.StartDate ? new Date(booking.StartDate).toLocaleDateString('ru-RU') : '?',
                 EndDateFormatted: booking.EndDate ? new Date(booking.EndDate).toLocaleDateString('ru-RU') : '?',
                 RejectedReason: booking.RejectedReason || null // Передаем причину для EJS
             };
        }).filter(Boolean) // Убираем null значения
          .sort((a, b) => { // Сортировка: Ожидающие -> Активные -> Остальные по дате
                const statusOrder = { 'Ожидает подтверждения': 1, 'Активна': 2 };
                const statusA = statusOrder[a.Status] || 3;
                const statusB = statusOrder[b.Status] || 3;
                if (statusA !== statusB) return statusA - statusB;
                return new Date(b.CreatedAt || 0) - new Date(a.CreatedAt || 0);
            });

        const message = req.session.message || null; if (req.session.message) delete req.session.message;

        // Передаем все брони в один шаблон, разделение будет в EJS
        res.render('rentals-management', {
            title: 'Управление арендами',
            bookings: bookingsWithDetails,
            message: message
            // currentUser передается автоматически через res.locals
        });

    } catch (error) {
        console.error("[Rentals GET v4] Error fetching rentals list:", error);
        next(error); // Передаем ошибку дальше
    }
});

// POST /:id/confirm (Подтверждение брони)
router.post('/:id/confirm', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => {
    const bookingId = req.params.id;
    const confirmerUser = req.session.user; // Пользователь, который подтверждает
    const io = req.app.get('socketio'); // Получаем io из app
    console.log(`[Rental Confirm AJAX v4 - Rooms] User ${confirmerUser.username} confirming booking ${bookingId}`);

    try {
        const booking = await firebaseService.getBookingById(bookingId);
        if (!booking) { throw new Error('Бронирование не найдено.'); }
        if (booking.Status !== 'Ожидает подтверждения') { throw new Error(`Броню нельзя подтвердить (статус: ${booking.Status}).`); }

        // Получаем объект и ID компании
        const property = await firebaseService.getPropertyById(booking.PropertyId);
        if (!property) { throw new Error('Объект недвижимости не найден.'); }
        const companyId = property.companyId;
        if (!companyId) { throw new Error('Не удалось определить компанию объекта.'); }

        // Получаем арендатора и компанию
        const [tenant, company] = await Promise.all([
            firebaseService.getUserByUsername(booking.UserId),
            firebaseService.getCompanyById(companyId)
        ]);
        if (!tenant) { throw new Error(`Арендатор (${booking.UserId}) не найден.`); }
        if (!company) { throw new Error(`Компания (${companyId}) не найдена.`); }

        // Проверяем баланс арендатора
        const currentBalance = tenant.Balance || 0;
        const totalCost = booking.TotalCost || 0;
        if (totalCost <= 0) { throw new Error("Некорректная сумма бронирования."); } // Доп. проверка

        // Если средств недостаточно, отклоняем бронь
        if (currentBalance < totalCost) {
            console.warn(`[Rental Confirm AJAX v4] Insufficient funds for tenant ${tenant.Username} on confirm.`);
            const rejectionReason = 'Недостаточно средств на момент подтверждения';
            await db.ref(`bookings/${bookingId}`).update({ Status: 'Отклонена', RejectedAt: new Date().toISOString(), RejectedBy: confirmerUser.username, RejectedReason: rejectionReason });

            // Отправляем уведомление об отклонении арендатору
            const tenantRoomReject = `user:${tenant.Username}`;
            io.to(tenantRoomReject).emit('booking_rejected', {
                bookingId: bookingId,
                reason: rejectionReason,
                propertyTitle: property.Title || '?'
            });
            console.log(`[Rental Confirm AJAX v4] Emitted 'booking_rejected' (insufficient funds) to room ${tenantRoomReject}`);

            throw new Error('Недостаточно средств у арендатора для подтверждения. Бронь отклонена.');
        }

        // Готовим атомарное обновление
        const updates = {};
        const timestamp = new Date().toISOString();
        const newStatus = 'Активна';

        // 1. Обновляем бронь
        updates[`/bookings/${bookingId}/Status`] = newStatus;
        updates[`/bookings/${bookingId}/ConfirmedAt`] = timestamp;
        updates[`/bookings/${bookingId}/ConfirmedBy`] = confirmerUser.username; // Кто подтвердил

        // 2. Списываем у арендатора
        const tenantNewBalance = parseFloat((currentBalance - totalCost).toFixed(2));
        const tenantHistoryKey = db.ref(`users/${tenant.Username}/BalanceHistory`).push().key;
        if(!tenantHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для арендатора.");
        updates[`/users/${tenant.Username}/Balance`] = tenantNewBalance;
        updates[`/users/${tenant.Username}/BalanceHistory/${tenantHistoryKey}`] = { Id: tenantHistoryKey, Date: timestamp, Amount: -totalCost, OperationType: "Оплата брони", Description: `Бронь #${bookingId.substring(0,6)}: "${property.Title}"`, NewBalance: tenantNewBalance };

        // 3. Начисляем компании (если сумма > 0)
        const amountToCreditCompany = booking.AmountPaidToCompany || 0;
        if(amountToCreditCompany > 0) {
            const currentCompanyBalance = company.Balance || 0;
            const newCompanyBalance = parseFloat((currentCompanyBalance + amountToCreditCompany).toFixed(2));
            const companyHistoryKey = db.ref(`companies/${companyId}/balanceHistory`).push().key;
             if(!companyHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для компании.");
            updates[`/companies/${companyId}/Balance`] = newCompanyBalance;
            updates[`/companies/${companyId}/balanceHistory/${companyHistoryKey}`] = { Id: companyHistoryKey, Date: timestamp, Amount: amountToCreditCompany, OperationType: "Поступление (Аренда)", Description: `Подтверждение #${bookingId.substring(0,6)} (Общ:${totalCost.toFixed(2)}, Ком:${(booking.Commission || 0).toFixed(2)})`, NewBalance: newCompanyBalance };
            console.log(`[Rental Confirm AJAX v4] Company ${companyId} credit prepared. New balance: ${newCompanyBalance}.`);
        } else {
            console.log(`[Rental Confirm AJAX v4] Calculated amountToCreditCompany is zero or negative for booking ${bookingId}. Skipping company credit.`);
        }

        // Выполняем обновление
        await db.ref().update(updates);
        console.log(`[Rental Confirm AJAX v4] SUCCESS. Booking ${bookingId} confirmed. Tenant balance: ${tenantNewBalance}.`);

        // Отправляем уведомления арендатору
        const tenantRoomConfirm = `user:${tenant.Username}`;
        io.to(tenantRoomConfirm).emit('balance_updated', tenantNewBalance); // Обновляем баланс
        io.to(tenantRoomConfirm).emit('booking_confirmed', { // Событие подтверждения
             bookingId: bookingId,
             propertyTitle: property.Title || '?',
             startDate: booking.StartDate,
             endDate: booking.EndDate
        });
        console.log(`[Rental Confirm AJAX v4] Emitted 'booking_confirmed' and 'balance_updated' to room ${tenantRoomConfirm}`);

        // Отправляем успешный ответ
        res.status(200).json({ success: true, message: 'Бронирование подтверждено.', newStatus: newStatus });

    } catch (error) {
        console.error(`[Rental Confirm AJAX v4] ERROR confirming booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдено") ? 404 : (error.message.includes("Недостаточно средств") ? 400 : 500);
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка подтверждения бронирования.' });
    }
});

// POST /:id/reject (Отклонение брони)
router.post('/:id/reject', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => {
    const bookingId = req.params.id;
    const rejecterUser = req.session.user;
    const reason = req.body.reason || 'Отклонено владельцем/администрацией'; // Получаем причину из тела
    const io = req.app.get('socketio');
    console.log(`[Rental Reject AJAX v4 - Rooms] User ${rejecterUser.username} rejecting booking ${bookingId} with reason: ${reason}`);

    try {
        const booking = await firebaseService.getBookingById(bookingId);
        if (!booking) { throw new Error('Бронирование не найдено.'); }
        if (booking.Status !== 'Ожидает подтверждения') { throw new Error(`Броню нельзя отклонить (статус: ${booking.Status}).`); }

        // Обновляем статус и добавляем информацию об отклонении
        const newStatus = 'Отклонена';
        await db.ref(`bookings/${bookingId}`).update({
            Status: newStatus,
            RejectedAt: new Date().toISOString(),
            RejectedBy: rejecterUser.username,
            RejectedReason: reason // Сохраняем причину
        });
        console.log(`[Rental Reject AJAX v4] SUCCESS. Booking ${bookingId} rejected.`);

        // Отправляем уведомление арендатору
        const tenantRoom = `user:${booking.UserId}`;
        const property = await firebaseService.getPropertyById(booking.PropertyId); // Получаем для названия
        io.to(tenantRoom).emit('booking_rejected', {
             bookingId: bookingId,
             propertyTitle: property?.Title || 'объекта', // Используем безопасный доступ
             reason: reason
        });
        console.log(`[Rental Reject AJAX v4] Emitted 'booking_rejected' notification to room ${tenantRoom}`);

        // Возвращаем причину в ответе для возможного отображения на клиенте
        res.status(200).json({ success: true, message: 'Бронирование отклонено.', newStatus: newStatus, rejectedReason: reason });

    } catch (error) {
        console.error(`[Rental Reject AJAX v4] ERROR rejecting booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдено") ? 404 : 400;
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка отклонения бронирования.' });
    }
});

// POST /:id/cancel (Аннулирование Админом/Владельцем/Стаффом активной брони)
router.post('/:id/cancel', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => {
    const bookingId = req.params.id;
    const currentUser = req.session.user; // Админ/Владелец/Стафф
    const io = req.app.get('socketio');
    console.log(`[Rentals Cancel AJAX v4 - Rooms] User ${currentUser.username} cancelling booking ${bookingId}`);

    try {
        const booking = await firebaseService.getBookingById(bookingId);
        if (!booking) { throw new Error('Бронирование не найдено.'); }
        // Аннулировать можно только АКТИВНЫЕ брони этим маршрутом
        if (booking.Status !== 'Активна') { throw new Error(`Статус брони: "${booking.Status}". Аннуляция активной брони невозможна.`); }

        const property = await firebaseService.getPropertyById(booking.PropertyId);
        if (!property?.companyId) { throw new Error('Ошибка: не найдена компания объекта для обработки отмены.'); }
        const companyId = property.companyId;

        // Готовим обновления
        const updates = {};
        const timestamp = new Date().toISOString();
        const tenantUserId = booking.UserId;
        const refundAmountTenant = booking.TotalCost || 0;
        // Сумма к списанию с компании (если она была начислена)
        const amountToDebitCompany = booking.AmountPaidToCompany ?? parseFloat(((booking.TotalCost || 0) * (1 - COMMISSION_RATE)).toFixed(2));
        let finalTenantBalance = null;
        const newStatus = 'Аннулирована'; // Статус при отмене владельцем/админом

        // 1. Обновляем бронь
        updates[`/bookings/${bookingId}/Status`] = newStatus;
        updates[`/bookings/${bookingId}/CancelledAt`] = timestamp; // Время аннуляции
        updates[`/bookings/${bookingId}/CancelledBy`] = currentUser.username; // Кто аннулировал

        // 2. Возвращаем средства арендатору (если сумма > 0 и арендатор существует)
        if (refundAmountTenant > 0 && tenantUserId) {
            const tenant = await firebaseService.getUserByUsername(tenantUserId);
            if (tenant) {
                 const currentTenantBalance = tenant.Balance || 0;
                 finalTenantBalance = parseFloat((currentTenantBalance + refundAmountTenant).toFixed(2));
                 updates[`/users/${tenantUserId}/Balance`] = finalTenantBalance;
                 const tenantHistoryKey = db.ref(`users/${tenantUserId}/BalanceHistory`).push().key;
                 if(!tenantHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для арендатора при аннуляции.");
                 updates[`/users/${tenantUserId}/BalanceHistory/${tenantHistoryKey}`] = { Id: tenantHistoryKey, Date: timestamp, Amount: refundAmountTenant, OperationType: "Возврат (Аннул. адм.)", Description: `Аннул. адм./влад. (${currentUser.username}) брони #${bookingId.substring(0,6)}`, NewBalance: finalTenantBalance };
                 console.log(`[Rentals Cancel v4] Tenant ${tenantUserId} refund prepared. New balance: ${finalTenantBalance}`);
            } else {
                 // Если арендатор удален, деньги "сгорают"? Или нужно обработать иначе? Пока логируем ошибку.
                 console.error(`[Rentals Cancel v4] Tenant ${tenantUserId} not found! Refund cannot be processed.`);
                 // Возможно, стоит здесь прервать операцию или просто не обновлять баланс арендатора
                 // throw new Error(`Арендатор ${tenantUserId} не найден, возврат невозможен.`);
            }
        } else {
            console.log(`[Rentals Cancel v4] No refund needed (Amount: ${refundAmountTenant}) or Tenant UserId missing.`);
        }

        // 3. Списываем средства с компании (если были начислены и сумма > 0)
        if (amountToDebitCompany > 0) {
            const company = await firebaseService.getCompanyById(companyId);
            if (!company) { throw new Error(`Компания ${companyId} не найдена для списания средств.`); }
            const currentCompanyBalance = company.Balance || 0;
            const newCompanyBalance = parseFloat((currentCompanyBalance - amountToDebitCompany).toFixed(2));
            const companyHistoryKey = db.ref(`companies/${companyId}/balanceHistory`).push().key;
            if(!companyHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для компании при аннуляции.");
            updates[`/companies/${companyId}/Balance`] = newCompanyBalance;
            updates[`/companies/${companyId}/balanceHistory/${companyHistoryKey}`] = { Id: companyHistoryKey, Date: timestamp, Amount: -amountToDebitCompany, OperationType: "Списание (Аннул. адм.)", Description: `Аннул. адм./влад. (${currentUser.username}) брони #${bookingId.substring(0,6)}`, NewBalance: newCompanyBalance };
            console.log(`[Rentals Cancel v4] Company ${companyId} debit prepared. New balance: ${newCompanyBalance}.`);
        } else {
            console.log(`[Rentals Cancel v4] No company debit needed (Amount: ${amountToDebitCompany}).`);
        }

        // Выполняем атомарное обновление
        await db.ref().update(updates);
        console.log(`[Rentals Cancel v4] SUCCESS. Booking ${bookingId} status changed to: ${newStatus}.`);

        // Отправляем уведомление арендатору
        const tenantRoom = `user:${tenantUserId}`;
        if (finalTenantBalance !== null) { // Отправляем обновленный баланс, если он изменился
            io.to(tenantRoom).emit('balance_updated', finalTenantBalance);
        }
        io.to(tenantRoom).emit('booking_cancelled_by_owner', { // Отправляем событие аннуляции
             bookingId: bookingId,
             propertyTitle: property?.Title || 'объекта',
             cancelledBy: currentUser.username // Кто аннулировал
        });
        console.log(`[Rentals Cancel v4] Emitted 'booking_cancelled_by_owner' and potentially 'balance_updated' to room ${tenantRoom}`);

        // Обновляем сессию текущего пользователя, если он каким-то образом оказался арендатором этой брони
        if (currentUser.username === tenantUserId && finalTenantBalance !== null) {
             req.session.user.balance = finalTenantBalance;
             req.session.save(err => { if(err) console.error("[Rentals Cancel v4] Error saving session:", err); });
        }

        // Формируем сообщение для ответа
        let successMessage = `Бронирование успешно аннулировано.`;
        if (refundAmountTenant > 0 && finalTenantBalance !== null) {
            successMessage += ` Средства (${refundAmountTenant.toFixed(2)} RUB) возвращены арендатору.`;
        } else if (refundAmountTenant > 0 && finalTenantBalance === null) {
            successMessage += ` Ошибка возврата средств арендатору (не найден).`;
        }
        res.status(200).json({ success: true, message: successMessage, newStatus: newStatus });

    } catch (error) {
        console.error(`[Rentals Cancel v4] ERROR cancelling booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдено") ? 404 : 400;
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка аннулирования бронирования.' });
    }
});


// POST /:id/delete (Удалить ИСТОРИЮ бронирования - Admin Only)
router.post('/:id/delete', isLoggedIn, isAdmin, async (req, res, next) => {
    const bookingId = req.params.id;
    const adminUsername = req.session.user.username;
    console.log(`[Rentals AJAX Delete v4] START: Admin ${adminUsername} deleting booking ${bookingId}`);
     try {
         const booking = await firebaseService.getBookingById(bookingId);
         if (!booking) { throw new Error("Запись бронирования не найдена."); }
         // Запрещаем удалять активные и ожидающие брони
         if (booking.Status === 'Активна' || booking.Status === 'Ожидает подтверждения') {
             throw new Error("Нельзя удалить запись об активном или ожидающем бронировании. Сначала измените его статус (аннулируйте/отклоните).");
         }
         // Удаляем запись из базы данных
         await firebaseService.deleteBooking(bookingId);
         console.log(`[Rentals AJAX Delete v4] SUCCESS: Booking ${bookingId} record deleted.`);
         res.status(200).json({ success: true, message: 'Запись о бронировании успешно удалена.' });
    } catch (error) {
        console.error(`[Rentals AJAX Delete v4] ERROR deleting booking ${bookingId}:`, error);
        const statusCode = error.message.includes("не найдена") ? 404 : (error.message.includes("Нельзя удалить") ? 400 : 500);
        res.status(statusCode).json({ success: false, error: error.message || 'Ошибка удаления записи о бронировании.' });
    }
});

module.exports = router; // Экспорт роутера