// routes/bookingRoutes.js
const express = require('express');
const firebaseService = require('../services/firebaseService');
const { isLoggedIn } = require('../middleware/authMiddleware'); // Убедитесь, что middleware существует
const admin = require('firebase-admin');
const db = admin.database();
const log = require('electron-log'); // Используем electron-log

const router = express.Router();
// Определяем константу комиссии на уровне модуля
const COMMISSION_RATE = 0.15; // 15%

// Middleware isTenant: Проверяет, что пользователь имеет роль Tenant
function isTenant(req, res, next) {
    // Ensure user session exists and has a role property
    if (req.session && req.session.user && req.session.user.role === 'Tenant') {
        return next(); // Пропускаем, если арендатор
    }
    // Log the denial more robustly
    const username = req.session?.user?.username || 'Guest';
    const role = req.session?.user?.role || 'Unknown';
    log.warn(`[isTenant Middleware] Access denied for user ${username} (Role: ${role}) to path ${req.originalUrl}`);

    // Set message and redirect safely
    req.session.message = { type: 'error', text: 'Доступно только арендаторам.' };
    // Use session save to ensure message persists across redirect
    req.session.save(err => {
        if (err) {
            log.error("[isTenant Middleware] Session save error:", err);
            // Fallback redirect if session save fails
            return res.status(403).redirect('/');
        }
        // Redirect to referrer or home page
        res.status(403).redirect(req.header('Referer') || '/');
    });
}


// GET /: Отображение списка бронирований ТЕКУЩЕГО арендатора (с пагинацией на клиенте)
router.get('/', isLoggedIn, isTenant, async (req, res, next) => {
    const currentUsername = req.session.user.username;
    log.info(`[GET /bookings v6 - Client Pagination] Fetching bookings for user: ${currentUsername}`);
    try {
        // Загружаем ВСЕ бронирования пользователя и ВСЕ объекты параллельно
        const [tenantBookingsResult, allPropertiesResult] = await Promise.allSettled([
            firebaseService.getBookingsByUserId(currentUsername),
            firebaseService.getAllProperties() // Получаем все объекты для проверки существования и названий
        ]);

        // Обрабатываем результаты Promise.allSettled
        const tenantBookings = tenantBookingsResult.status === 'fulfilled' ? (Array.isArray(tenantBookingsResult.value) ? tenantBookingsResult.value : []) : [];
        const allProperties = allPropertiesResult.status === 'fulfilled' ? (Array.isArray(allPropertiesResult.value) ? allPropertiesResult.value : []) : [];

        if (tenantBookingsResult.status !== 'fulfilled') {
            log.error(`[GET /bookings v6] Failed to fetch bookings for ${currentUsername}:`, tenantBookingsResult.reason);
            // Можно отобразить ошибку или пустой список
        }
        if (allPropertiesResult.status !== 'fulfilled') {
            log.error(`[GET /bookings v6] Failed to fetch all properties:`, allPropertiesResult.reason);
            // Можно продолжить без названий или показать ошибку
        }

        // Создаем карту объектов для быстрого поиска названий И ПРОВЕРКИ СУЩЕСТВОВАНИЯ
        const propertiesMap = new Map( allProperties.filter(p => p && p.Id).map(p => [p.Id, p.Title]) ); // Убедимся, что p и p.Id существуют

        log.info(`[GET /bookings v6] Found ${tenantBookings.length} raw bookings for user. Found ${propertiesMap.size} total properties.`);

        // ФИЛЬТРУЕМ бронирования: оставляем только те, чьи PropertyId существуют в propertiesMap
        const validBookings = tenantBookings.filter(booking => {
            if (!booking || !booking.PropertyId) {
                log.warn(`[GET /bookings v6] Skipping booking due to missing data or PropertyId:`, booking ? booking.Id : 'No ID');
                return false; // Пропускаем некорректные бронирования
            }
            const propertyExists = propertiesMap.has(booking.PropertyId);
            if (!propertyExists) {
                log.warn(`[GET /bookings v6] Filtering out booking ID ${booking.Id} because property ${booking.PropertyId} does not exist.`);
            }
            return propertyExists; // Оставляем только существующие
        });

        log.info(`[GET /bookings v6] Filtered down to ${validBookings.length} bookings with existing properties.`);

        // Форматируем ОСТАВШИЕСЯ валидные бронирования для отображения
        const bookingsWithDetails = validBookings.map(booking => {
            // Здесь мы уверены, что booking и booking.PropertyId существуют и PropertyId есть в карте
            const propertyTitle = propertiesMap.get(booking.PropertyId) || 'Ошибка названия'; // Должно найтись, но добавим запасной вариант
            return {
                ...booking,
                PropertyTitle: propertyTitle,
                StartDateFormatted: booking.StartDate ? new Date(booking.StartDate).toLocaleDateString('ru-RU') : '?',
                EndDateFormatted: booking.EndDate ? new Date(booking.EndDate).toLocaleDateString('ru-RU') : '?',
                RejectedReason: booking.RejectedReason || null // Передаем причину для title в EJS
            };
        }).sort((a, b) => { // Сортировка: Ожидающие сверху, потом Активные, потом остальные по дате
            const statusOrder = { 'Ожидает подтверждения': 1, 'Активна': 2 };
            const statusA = statusOrder[a.Status] || 3;
            const statusB = statusOrder[b.Status] || 3;
            if (statusA !== statusB) return statusA - statusB;
            return new Date(b.CreatedAt || 0) - new Date(a.CreatedAt || 0); // Внутри группы - новые сверху
        });

        // Flash сообщение из сессии (если есть)
        const message = req.session.message || null;
        if (req.session.message) delete req.session.message;

        res.render('bookings-list', {
            title: 'Мои бронирования',
            // Передаем отфильтрованный и отсортированный список
            bookings: bookingsWithDetails,
            message: message
            // Данные для пагинации будут обрабатываться на клиенте
        });

    } catch (error) {
        log.error(`[GET /bookings v6] Error fetching or processing bookings for user ${currentUsername}:`, error);
        next(error); // Передаем ошибку глобальному обработчику
    }
});


// POST /new (Создание бронирования) - Без изменений, оставляем как было
router.post('/new', isLoggedIn, isTenant, async (req, res, next) => {
    const { propertyId, startDate, endDate } = req.body;
    const currentUsername = req.session.user.username;
    const io = req.app.get('socketio');
    const userSockets = req.app.get('userSockets'); // Получаем карту сокетов
    log.info(`[Booking POST v6 - DB Store] Attempt by ${currentUsername} for property ${propertyId}. Dates: ${startDate} to ${endDate}`);

    let errorRedirectUrl = '/properties';
    if (propertyId) { errorRedirectUrl = `/bookings/new?propertyId=${propertyId}&startDate=${encodeURIComponent(startDate || '')}&endDate=${encodeURIComponent(endDate || '')}`; }

    try {
         // --- Валидация Дат и Длительности ---
         if (!propertyId || !startDate || !endDate) { throw new Error('Укажите объект и даты.'); }
         const start = new Date(startDate); const end = new Date(endDate); const today = new Date(); today.setHours(0, 0, 0, 0);
         if (isNaN(start.getTime()) || isNaN(end.getTime())) { throw new Error('Неверный формат дат.'); }
         if (start < today) { throw new Error('Дата начала не может быть в прошлом.'); }
         if (end <= start) { throw new Error('Дата окончания должна быть позже даты начала.'); }
         const durationMs = end.getTime() - start.getTime(); const durationDays = Math.ceil(durationMs / (1000 * 60 * 60 * 24));
         if (durationDays <= 0 || durationDays > 90) { throw new Error('Некорректный срок бронирования (от 1 до 90 дней).'); }

         // --- Получение данных ---
         const [property, user, allBookings] = await Promise.all([
             firebaseService.getPropertyById(propertyId),
             firebaseService.getUserByUsername(currentUsername),
             firebaseService.getAllBookings()
         ]);

         if (!property) throw new Error('Объект не найден.');
         if (!property.companyId) throw new Error('Ошибка: объект не привязан к компании.');
         if (!property.IsAvailable) throw new Error('Этот объект сейчас недоступен для бронирования.');
         if (!user) throw new Error('Пользователь не найден.');

         // --- Расчеты ---
         const dailyPrice = property.Price ? (parseFloat(property.Price) / 30) : 0;
         if (dailyPrice <= 0) { throw new Error('Некорректная цена объекта. Обратитесь к владельцу.'); }
         const totalCost = parseFloat((durationDays * dailyPrice).toFixed(2));
         if (totalCost <= 0) { throw new Error('Некорректная итоговая стоимость.'); }
         const commissionAmount = parseFloat((totalCost * COMMISSION_RATE).toFixed(2));
         const amountToCompany = parseFloat((totalCost - commissionAmount).toFixed(2));
         const companyId = property.companyId;
         log.info(`[Booking POST v6] Calculated Cost: ${totalCost}, Commission: ${commissionAmount}, To Company (${companyId}): ${amountToCompany}`);

         // --- Проверки ---
         const currentBalance = user.Balance || 0;
         if (currentBalance < totalCost) {
             log.warn(`[Booking POST v6] Insufficient funds for ${currentUsername}. Required: ${totalCost}, Available: ${currentBalance}`);
             throw new Error(`Недостаточно средств на балансе (${currentBalance.toFixed(2)} / ${totalCost.toFixed(2)} RUB). Пожалуйста, пополните баланс.`);
         }
         const startMs = start.getTime(); const endMs = end.getTime();
         const overlappingBooking = (Array.isArray(allBookings)?allBookings:[]).find(b =>
             b && b.PropertyId === propertyId &&
             (b.Status === 'Активна' || b.Status === 'Ожидает подтверждения') &&
             new Date(b.StartDate).getTime() < endMs &&
             new Date(b.EndDate).getTime() > startMs
         );
         if (overlappingBooking) {
              log.warn(`[Booking POST v6] Date overlap detected with booking ${overlappingBooking.Id} (Status: ${overlappingBooking.Status})`);
              throw new Error(`Выбранные даты (${startDate} - ${endDate}) пересекаются с существующей или ожидающей подтверждения бронью.`);
          }

         // --- Подготовка данных для новой брони ---
         const newBookingId = db.ref('bookings').push().key;
         const timestamp = new Date().toISOString();
         const newBooking = {
             Id: newBookingId, PropertyId: propertyId, UserId: currentUsername,
             StartDate: start.toISOString().split('T')[0], EndDate: end.toISOString().split('T')[0],
             TotalCost: totalCost, Commission: commissionAmount, AmountPaidToCompany: amountToCompany,
             Status: 'Ожидает подтверждения', CreatedAt: timestamp,
         };

         // --- Сохранение брони ---
         log.info(`[Booking POST v6] Saving booking ${newBookingId} with status 'Ожидает подтверждения'...`);
         await db.ref(`/bookings/${newBookingId}`).set(newBooking);
         log.info(`[Booking POST v6] SUCCESS. Booking ${newBookingId} created.`);

         // *** ОТПРАВКА УВЕДОМЛЕНИЯ ВЛАДЕЛЬЦУ/СТАФФУ В КОМНАТЫ ***
         const company = await firebaseService.getCompanyById(companyId);
         if (company) {
             const ownerUsername = company.ownerUsername;
             const staffUsernames = company.staff ? Object.keys(company.staff) : [];
             const recipients = [...new Set([ownerUsername, ...staffUsernames])].filter(Boolean);
             log.info(`[Booking POST v6] Saving 'new_booking_pending' notification to DB for recipients: ${recipients.join(', ')}`);

             const notificationData = {
                  type: 'info', // Тип уведомления
                  title: 'Новый запрос на бронь',
                  message: `Поступил запрос (#${newBookingId.substring(0,6)}) на бронь объекта "<strong>${property.Title || '?'}</strong>" от пользователя ${user.FullName || currentUsername}. Даты: ${newBooking.StartDate} - ${newBooking.EndDate}. Сумма: ${new Intl.NumberFormat('ru-RU',{style:'currency', currency:'RUB'}).format(newBooking.TotalCost || 0)}.`,
                  bookingId: newBookingId
             };

             // Добавляем уведомление для каждого получателя в БД
             for (const recipient of recipients) {
                  await firebaseService.addNotification(recipient, notificationData);
                  // Дополнительно: Пытаемся отправить мгновенное уведомление, если пользователь онлайн
                  const targetRoom = `user:${recipient}`;
                  io.to(targetRoom).emit('new_booking_pending', {
                        bookingId: newBookingId,
                        propertyTitle: property.Title || '?',
                        tenantName: user.FullName || currentUsername,
                        startDate: newBooking.StartDate,
                        endDate: newBooking.EndDate,
                        totalCost: newBooking.TotalCost
                  });
                  log.info(`[Booking POST v6] Emitted 'new_booking_pending' to room ${targetRoom}`);

                   // --->>> ДОБАВЛЕНО: Отправка задачи на Dashboard <<<---
                   try {
                       const taskData = {
                            id: `book-${newBookingId}`, // Уникальный ID задачи
                            type: 'pending-booking',
                            details: `Заявка на "${property.Title || '?'}" от ${user.FullName || currentUsername}`,
                            link: `/rentals#booking-${newBookingId}`, // Ссылка на управление арендами
                            time: new Date(timestamp).toLocaleDateString('ru-RU') // Дата создания
                       };
                       io.to(targetRoom).emit('dashboard:new_task', taskData);
                       log.info(`[Booking POST v6] Emitted 'dashboard:new_task' (new booking) to room ${targetRoom}`);
                   } catch (taskError) {
                       log.error(`[Booking POST v6] Error preparing/sending dashboard task for ${recipient}:`, taskError);
                   }
                   // --->>> КОНЕЦ ДОБАВЛЕНИЯ <<<---
             }
         } else { log.warn(`[Booking POST v6] Company ${companyId} not found for notification.`); }

         req.session.message = { type: 'success', text: 'Запрос на бронирование отправлен! Ожидайте подтверждения владельцем.' };
         req.session.save(err => {
             if (err) log.error("[Booking POST v6] Session save error:", err);
             res.redirect('/bookings'); // Редирект на "Мои бронирования"
         });

     } catch (error) {
          log.error("[Booking POST v6] Error creating booking:", error);
          req.session.message = { type: 'error', text: error.message || 'Произошла ошибка при запросе бронирования.'};
          req.session.save(err => {
               if (err) log.error("[Booking POST v6] Session save error (catch):", err);
               res.redirect(errorRedirectUrl);
          });
     }
 });

// POST /:id/cancel (Отмена Tenant'ом) - Используем перезагрузку для обновления пагинации
router.post('/:id/cancel', isLoggedIn, isTenant, async (req, res, next) => {
    const bookingId = req.params.id;
    const currentUsername = req.session.user.username; // Арендатор
    const io = req.app.get('socketio');
    const userSockets = req.app.get('userSockets');
    log.info(`[Booking Cancel AJAX v6.1 - Reload] Tenant ${currentUsername} cancelling booking ${bookingId}`); // Пометили Reload

    try {
        const booking = await firebaseService.getBookingById(bookingId);
        if (!booking) throw new Error('Бронирование не найдено.');
        if (booking.UserId !== currentUsername) throw new Error('Вы не можете отменить это бронирование.');

        const property = await firebaseService.getPropertyById(booking.PropertyId);
        // Важно: Проверяем существование свойства перед получением companyId
        if (!property) {
            log.warn(`[Booking Cancel AJAX v6.1] Property ${booking.PropertyId} for booking ${bookingId} not found. Cannot determine companyId or notify owner.`);
            // Можно либо просто отменить бронь без уведомления, либо выдать ошибку
            // Давайте отменим, но залогируем
            await db.ref(`bookings/${bookingId}`).update({ Status: 'Отменена', CancelledAt: new Date().toISOString(), CancelledBy: currentUsername });
            log.info(`[Booking Cancel AJAX v6.1] Booking ${bookingId} (for deleted property) status changed to 'Отменена'. No refund or notifications possible.`);
            return res.status(200).json({ success: true, message: 'Бронирование отменено (объект удален).', newStatus: 'Отменена', reloadPage: true }); // Добавляем флаг перезагрузки
        }
        const companyId = property.companyId; // Теперь это безопасно
        const tenantFullName = req.session.user.fullName || currentUsername;

        // --- Логика отмены в зависимости от статуса ---
        if (booking.Status === 'Ожидает подтверждения') {
            const newStatus = 'Отменена';
            await db.ref(`bookings/${bookingId}`).update({ Status: newStatus, CancelledAt: new Date().toISOString(), CancelledBy: currentUsername });
            log.info(`[Booking Cancel AJAX v6.1] Booking ${bookingId} (Pending) status changed to '${newStatus}'.`);

            // Уведомление команде компании (если companyId определен)
            if (companyId) {
                const company = await firebaseService.getCompanyById(companyId);
                if (company) {
                    const ownerUsername = company.ownerUsername;
                    const staffUsernames = company.staff ? Object.keys(company.staff) : [];
                    const recipients = [...new Set([ownerUsername, ...staffUsernames])].filter(Boolean);
                    log.info(`[Booking Cancel AJAX v6.1] Saving 'pending_booking_cancelled' notification to DB for: ${recipients.join(', ')}`);
                    const notificationData = { type: 'warning', title: 'Запрос отменен арендатором', message: `Арендатор <strong>${tenantFullName}</strong> отменил запрос (#${bookingId.substring(0,6)}) на бронирование объекта "<strong>${property?.Title || '?'}</strong>".`, bookingId: bookingId };
                    for (const recipient of recipients) {
                         await firebaseService.addNotification(recipient, notificationData);
                         const targetRoom = `user:${recipient}`;
                         io.to(targetRoom).emit('pending_booking_cancelled', { bookingId: bookingId, propertyTitle: property?.Title || '?', tenantName: tenantFullName });
                         log.info(`[Booking Cancel AJAX v6.1] Also emitted 'pending_booking_cancelled' to room ${targetRoom}`);
                    }
                } else { log.warn(`[Booking Cancel AJAX v6.1] Company ${companyId} not found for notification (pending cancel).`); }
            }
            // ИЗМЕНЕНО: Отправляем флаг перезагрузки
            return res.status(200).json({ success: true, message: 'Запрос на бронирование успешно отменен.', newStatus: newStatus, reloadPage: true });

        } else if (booking.Status === 'Активна') {
            // --- Отмена Активной брони (с возвратом) ---
            if (!companyId) throw new Error('Критическая ошибка: не найдена компания объекта для обработки возврата.');

            const refundAmountTenant = booking.TotalCost || 0;
            const amountToDebitCompany = booking.AmountPaidToCompany ?? parseFloat(((booking.TotalCost || 0) * (1 - COMMISSION_RATE)).toFixed(2));
            if (refundAmountTenant <= 0) { log.warn(`[Booking Cancel AJAX v6.1] Refund amount is ${refundAmountTenant} for active booking ${bookingId}.`); }

            const updates = {}; const timestamp = new Date().toISOString(); const newStatus = 'Отменена';
            updates[`/bookings/${bookingId}/Status`] = newStatus;
            updates[`/bookings/${bookingId}/CancelledAt`] = timestamp;
            updates[`/bookings/${bookingId}/CancelledBy`] = currentUsername;

            let finalTenantBalance = null;
            const user = await firebaseService.getUserByUsername(currentUsername);
            if (!user) throw new Error("Не удалось найти пользователя для возврата средств.");
            const currentTenantBalance = user.Balance || 0;
            finalTenantBalance = parseFloat((currentTenantBalance + refundAmountTenant).toFixed(2));
            updates[`/users/${currentUsername}/Balance`] = finalTenantBalance;
            const tenantHistoryKey = db.ref(`users/${currentUsername}/BalanceHistory`).push().key;
            if(!tenantHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для арендатора.");
            updates[`/users/${currentUsername}/BalanceHistory/${tenantHistoryKey}`] = { Id: tenantHistoryKey, Date: timestamp, Amount: refundAmountTenant, OperationType: "Возврат (Отмена)", Description: `Отмена брони #${bookingId.substring(0,6)}`, NewBalance: finalTenantBalance };

            let companyBalanceUpdated = false;
            if (amountToDebitCompany > 0) {
                const company = await firebaseService.getCompanyById(companyId);
                if (!company) throw new Error(`Компания ${companyId} не найдена для списания средств.`);
                const currentCompanyBalance = company.Balance || 0; const newCompanyBalance = parseFloat((currentCompanyBalance - amountToDebitCompany).toFixed(2));
                const companyHistoryKey = db.ref(`companies/${companyId}/balanceHistory`).push().key;
                 if(!companyHistoryKey) throw new Error("Не удалось сгенерировать ключ истории для компании.");
                updates[`/companies/${companyId}/Balance`] = newCompanyBalance;
                updates[`/companies/${companyId}/balanceHistory/${companyHistoryKey}`] = { Id: companyHistoryKey, Date: timestamp, Amount: -amountToDebitCompany, OperationType: "Списание (Отмена аренд.)", Description: `Отмена #${bookingId.substring(0,6)} арендатором`, NewBalance: newCompanyBalance };
                companyBalanceUpdated = true;
            }

            await db.ref().update(updates);
            log.info(`[Booking Cancel AJAX v6.1] SUCCESS. Active Booking ${bookingId} cancelled by tenant.`);
            if (companyBalanceUpdated) log.info(`[Booking Cancel AJAX v6.1] Company ${companyId} balance updated.`);

            // Уведомление команде компании (если companyId определен)
            if (companyId) {
                 const company = await firebaseService.getCompanyById(companyId);
                 if (company) {
                     const ownerUsername = company.ownerUsername;
                     const staffUsernames = company.staff ? Object.keys(company.staff) : [];
                     const recipients = [...new Set([ownerUsername, ...staffUsernames])].filter(Boolean);
                     log.info(`[Booking Cancel AJAX v6.1] Saving 'active_booking_cancelled' notification to DB for: ${recipients.join(', ')}`);
                     const notificationData = { type: 'error', title: 'Активная бронь отменена арендатором', message: `Арендатор <strong>${tenantFullName}</strong> отменил <strong>активную</strong> бронь (#${bookingId.substring(0,6)}) объекта "<strong>${property?.Title || '?'}</strong>".`, bookingId: bookingId };
                     for (const recipient of recipients) {
                         await firebaseService.addNotification(recipient, notificationData);
                         const targetRoom = `user:${recipient}`;
                         io.to(targetRoom).emit('active_booking_cancelled', { bookingId: bookingId, propertyTitle: property?.Title || '?', tenantName: tenantFullName });
                         log.info(`[Booking Cancel AJAX v6.1] Also emitted 'active_booking_cancelled' to room ${targetRoom}`);
                     }
                 } else { log.warn(`[Booking Cancel AJAX v6.1] Company ${companyId} not found for notification (active cancel).`); }
            }

            // Обновляем баланс в СЕССИИ перед отправкой ответа
            req.session.user.balance = finalTenantBalance;

            // Сохраняем сессию (на всякий случай, хотя перезагрузка все обновит)
            return req.session.save(err => {
                if(err) log.error("[Booking Cancel AJAX v6.1] Session save error before reload:", err);
                let successMessage = `Бронь успешно отменена.`;
                if (refundAmountTenant > 0) { successMessage += ` ${refundAmountTenant.toFixed(2)} RUB возвращено на ваш баланс.`; }
                // Отправляем успех и флаг перезагрузки
                res.status(200).json({ success: true, message: successMessage, newStatus: newStatus, newBalance: finalTenantBalance, reloadPage: true });
            });
        } else {
            // Нельзя отменить брони в других конечных статусах
            throw new Error(`Нельзя отменить бронь со статусом "${booking.Status}".`);
        }
    } catch (error) {
        log.error(`[Booking Cancel AJAX v6.1] Error cancelling booking ${bookingId}:`, error);
        // Не добавляем reloadPage при ошибке
        res.status(400).json({ success: false, error: error.message || 'Ошибка отмены бронирования.' });
    }
});


// GET /new - Показ формы для нового бронирования - Без изменений, оставляем как было
router.get('/new', isLoggedIn, isTenant, async (req, res, next) => {
    const propertyId = req.query.propertyId;
    const startDateFromQuery = req.query.startDate || '';
    const endDateFromQuery = req.query.endDate || '';
    const currentUsername = req.session.user.username;
    log.info(`[GET /bookings/new v6] Request for propertyId: ${propertyId} by user: ${currentUsername}`);

    if (!propertyId) {
        req.session.message = { type: 'error', text: 'Не указан объект для бронирования.' };
        return req.session.save(err => res.redirect('/properties'));
    }

    try {
        // Загружаем данные параллельно
        const [property, user, allBookings] = await Promise.allSettled([
            firebaseService.getPropertyById(propertyId),
            firebaseService.getUserByUsername(currentUsername),
            firebaseService.getAllBookings()
        ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

        if (!property) {
             req.session.message = { type: 'error', text: 'Объект не найден.' };
             return req.session.save(err => res.redirect('/properties'));
        }
        if (!user) {
              log.error(`[GET /bookings/new v6] User ${currentUsername} not found in DB! Session invalid.`);
              return req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect('/login'); });
         }
        if (!property.IsAvailable) {
            req.session.message = { type: 'warning', text: 'Этот объект сейчас недоступен для бронирования.' };
            return req.session.save(err => res.redirect(`/properties/${propertyId}`));
        }

        // Готовим данные для шаблона
        const monthlyPrice = parseFloat(property.Price);
        const dailyPrice = (monthlyPrice && monthlyPrice > 0) ? (monthlyPrice / 30) : 0;
        property.CalculatedDailyPrice = dailyPrice > 0 ? dailyPrice.toFixed(2) : '0.00';

        // Даты, занятые Активными и Ожидающими бронями
        const busyPeriods = (Array.isArray(allBookings)? allBookings : [])
            .filter(b => b && b.PropertyId === propertyId && (b.Status === 'Активна' || b.Status === 'Ожидает подтверждения'))
            .map(b => ({ start: b.StartDate, end: b.EndDate }));

        const currentBalance = user.Balance || 0; // Баланс арендатора
        const message = req.session.message || null; if (req.session.message) delete req.session.message;

        log.info(`[GET /bookings/new v6] Rendering booking-new template for ${propertyId}`);
        res.render('booking-new', {
            title: `Бронирование: ${property.Title}`,
            property: property,
            busyPeriods: JSON.stringify(busyPeriods), // Передаем занятые периоды
            currentBalance: currentBalance,
            message: message,
            startDateValue: startDateFromQuery,
            endDateValue: endDateFromQuery
        });

    } catch (error) {
        log.error(`[GET /bookings/new v6] Error for property ${propertyId}:`, error);
        next(error);
    }
});


module.exports = router; // Экспорт роутера