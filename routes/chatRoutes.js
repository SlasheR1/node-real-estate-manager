// routes/chatRoutes.js
const express = require('express');
const { isLoggedIn } = require('../middleware/authMiddleware');
const firebaseService = require('../services/firebaseService'); // Убедитесь, что он экспортирует нужные функции
const admin = require('firebase-admin');
const db = admin.database();
const log = require('electron-log');

const router = express.Router();

// --- Middleware: Проверка участия в чате ---
async function isChatParticipant(req, res, next) {
    const chatId = req.params.chatId;
    const currentUser = req.session.user;

    if (!chatId || !currentUser || !currentUser.username) {
        log.warn('[isChatParticipant] chatId or currentUser missing.');
        // Если это API запрос, отвечаем JSON, иначе редирект (хотя для API лучше статус)
        if (req.path.startsWith('/api/')) {
             return res.status(401).json({ success: false, error: 'Требуется авторизация.' });
        } else {
             req.session.message = { type: 'error', text: 'Требуется авторизация.' };
             return res.redirect('/login');
        }
    }

    try {
        const chat = await firebaseService.getChatById(chatId);
        if (!chat) {
            log.warn(`[isChatParticipant] Chat ${chatId} not found.`);
             if (req.path.startsWith('/api/')) {
                 return res.status(404).json({ success: false, error: 'Чат не найден.' });
             } else {
                  req.session.message = { type: 'error', text: 'Чат не найден.' };
                  return res.redirect('/chats');
             }
        }

        const participants = chat.participants || {};
        const isUserParticipant = participants[currentUser.username];
        const isCompanyParticipant = (currentUser.role === 'Owner' || currentUser.role === 'Staff')
                                      && currentUser.companyId
                                      && participants[currentUser.companyId];

        if (isUserParticipant || isCompanyParticipant) {
            req.chatData = chat; // Сохраняем данные чата для использования в маршруте
            log.debug(`[isChatParticipant] Access granted for user ${currentUser.username} to chat ${chatId}`);
            return next();
        } else {
            log.warn(`[isChatParticipant] User ${currentUser.username} (Company: ${currentUser.companyId}) is not a participant of chat ${chatId}. Participants:`, participants);
             if (req.path.startsWith('/api/')) {
                 return res.status(403).json({ success: false, error: 'Доступ к этому чату запрещен.' });
             } else {
                 req.session.message = { type: 'error', text: 'Доступ к этому чату запрещен.' };
                 return res.redirect('/chats');
             }
        }
    } catch (error) {
        log.error(`[isChatParticipant] Error checking participation for chat ${chatId}:`, error);
        if (req.path.startsWith('/api/')) {
             return res.status(500).json({ success: false, error: 'Ошибка проверки доступа к чату.' });
        } else {
             next(error); // Передаем в общий обработчик ошибок для HTML страниц
        }
    }
}

// --- Маршруты ---

// GET /chats - Получить список чатов для текущего пользователя (HTML страница)
router.get('/chats', isLoggedIn, async (req, res, next) => {
    const currentUser = req.session.user;
    log.info(`[GET /chats] Fetching chats for user: ${currentUser.username}, Role: ${currentUser.role}, Company: ${currentUser.companyId}`);

    try {
        // Получаем чаты, в которых участвует пользователь или его компания
        const chats = await firebaseService.getUserChats(currentUser.username, currentUser.companyId);

        // Обогащение данных чатов для отображения
        const enrichedChats = await Promise.all(chats.map(async (chat) => {
            if (!chat || !chat.id) return null;

            const participants = chat.participants || {};
            const otherParticipantId = Object.keys(participants).find(pId =>
                pId !== currentUser.username &&
                !((currentUser.role === 'Owner' || currentUser.role === 'Staff') && pId === currentUser.companyId)
            );

            let otherParticipantName = 'Неизвестный';
            let otherParticipantAvatar = '/images/placeholder-avatar.png';
            let chatSubject = chat.subject || 'Чат';

            if (otherParticipantId) {
                const isCompanyParticipant = !(otherParticipantId.includes('@') || otherParticipantId.length < 10); // Простая эвристика ID компании

                if (isCompanyParticipant) {
                    const company = await firebaseService.getCompanyById(otherParticipantId).catch(e => null);
                    if (company) {
                        otherParticipantName = company.companyName || `Компания #${otherParticipantId.substring(0, 5)}...`;
                        otherParticipantAvatar = await firebaseService.getCompanyLogoDataUri(otherParticipantId);
                    } else {
                        otherParticipantName = `Компания #${otherParticipantId.substring(0, 5)}...`;
                        otherParticipantAvatar = '/images/placeholder-company.png';
                    }
                } else {
                    const tenantUser = await firebaseService.getUserByUsername(otherParticipantId).catch(e => null);
                    if (tenantUser) {
                        otherParticipantName = tenantUser.FullName || tenantUser.Username;
                        otherParticipantAvatar = await firebaseService.getUserAvatarDataUri(otherParticipantId);
                    } else {
                        otherParticipantName = `Пользователь ${otherParticipantId.substring(0, 5)}...`;
                    }
                }
            } else {
                 log.warn(`[GET /chats] Could not determine other participant for chat ${chat.id}`);
                 otherParticipantName = "Неизвестный собеседник";
            }

            // Обновляем тему чата, если она связана с объектом
            if (!chat.subject && chat.propertyId) {
                const property = await firebaseService.getPropertyById(chat.propertyId).catch(e => null);
                chatSubject = property?.Title ? `Объект: ${property.Title}` : `Объект #${chat.propertyId.substring(0,5)}...`;
            } else if (!chat.subject && chat.bookingId) {
                 chatSubject = `Бронь #${chat.bookingId.substring(0,6)}...`;
            }

            // Определяем непрочитанные для ТЕКУЩЕГО пользователя/компании
            let unreadCount = 0;
            const currentReaderId = (currentUser.role === 'Owner' || currentUser.role === 'Staff') ? currentUser.companyId : currentUser.username;
            if (chat.unreadCounts && currentReaderId && chat.unreadCounts[currentReaderId]) {
                 unreadCount = chat.unreadCounts[currentReaderId];
            }

            // Форматируем последнее сообщение и время
            const lastTimestamp = chat.lastMessageTimestamp;
            let timestampRelative = '';
            if (lastTimestamp) {
                const msgDate = new Date(lastTimestamp);
                const today = new Date();
                const yesterday = new Date(today);
                yesterday.setDate(today.getDate() - 1);

                if (msgDate.toDateString() === today.toDateString()) {
                    timestampRelative = msgDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                } else if (msgDate.toDateString() === yesterday.toDateString()) {
                    timestampRelative = 'Вчера';
                } else {
                    timestampRelative = msgDate.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
                }
            }
            const snippet = chat.lastMessageText ? (chat.lastMessageText.length > 35 ? chat.lastMessageText.substring(0, 32) + '...' : chat.lastMessageText) : 'Нет сообщений';

            return {
                id: chat.id,
                otherParticipantName,
                otherParticipantAvatar,
                displaySubject: chatSubject, // Тема чата
                unreadCountForCurrentUser: unreadCount,
                lastMessageTimestampRelative: timestampRelative, // Время последнего сообщения
                lastMessageTextSnippet: snippet, // Превью последнего сообщения
                lastMessageSenderId: chat.lastMessageSenderId // ID отправителя последнего
            };
        }));

        const validEnrichedChats = enrichedChats.filter(Boolean);

        // Сортировка: сначала с непрочитанными, потом по дате последнего сообщения
        validEnrichedChats.sort((a, b) => {
            const unreadA = a.unreadCountForCurrentUser || 0;
            const unreadB = b.unreadCountForCurrentUser || 0;
            // Сначала те, где ЕСТЬ непрочитанные (больше 0)
            if (unreadA > 0 && unreadB === 0) return -1;
            if (unreadA === 0 && unreadB > 0) return 1;
            // Если у обоих есть или нет непрочитанных, сортируем по времени
            return (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0);
        });

        res.render('chats', {
            title: 'Мои чаты',
            chats: validEnrichedChats,
            currentUser: currentUser // Передаем текущего пользователя для префикса "Вы:"
        });

    } catch (error) {
        log.error('[GET /chats] Error fetching user chats:', error);
        next(error);
    }
});

// GET /chats/:chatId - Получить конкретный чат и его сообщения (HTML страница)
router.get('/chats/:chatId', isLoggedIn, isChatParticipant, async (req, res, next) => {
    const chatId = req.params.chatId;
    const currentUser = req.session.user; // { username, role, companyId, fullName }
    const chatData = req.chatData; // Данные чата из middleware
    const io = req.app.get('socketio'); // Получаем Socket.IO

    log.info(`[GET /chats/:chatId] User ${currentUser.username} accessing chat ${chatId}`);

    try {
        // --- Определение другого участника ---
        const participants = chatData.participants || {};
        const otherParticipantId = Object.keys(participants).find(pId =>
            pId !== currentUser.username &&
            !((currentUser.role === 'Owner' || currentUser.role === 'Staff') && pId === currentUser.companyId)
        );
        let otherParticipantName = 'Неизвестный';
        if (otherParticipantId) {
             const isCompanyParticipant = !(otherParticipantId.includes('@') || otherParticipantId.length < 10);
             if (isCompanyParticipant) {
                 const company = await firebaseService.getCompanyById(otherParticipantId).catch(e => null);
                 otherParticipantName = company?.companyName || `Компания #${otherParticipantId.substring(0, 5)}...`;
             } else {
                 const tenantUser = await firebaseService.getUserByUsername(otherParticipantId).catch(e => null);
                 otherParticipantName = tenantUser?.FullName || tenantUser?.Username || `Пользователь ${otherParticipantId.substring(0, 5)}...`;
             }
        }

        // --- Получение сообщений ---
        const limit = 50; // Начальный лимит загрузки
        // Передаем объект текущего пользователя для определения прочитанных
        const messages = await firebaseService.getChatMessages(chatId, currentUser, limit);

        // --- Обогащение сообщений ---
        const enrichedMessages = await Promise.all(messages.map(async (msg) => {
            if (!msg || !msg.senderId) return null;
            const sender = await firebaseService.getUserByUsername(msg.senderId).catch(e => null);
            return {
                ...msg, // Включая isReadByRecipient
                senderName: sender?.FullName || sender?.Username || msg.senderId,
                senderAvatar: sender ? await firebaseService.getUserAvatarDataUri(sender.Username) : '/images/placeholder-avatar.png',
                isOwnMessage: msg.senderId === currentUser.username, // Флаг для рендеринга
                timestampFormatted: msg.timestamp ? new Date(msg.timestamp).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '??:??'
            };
        }));
        const validEnrichedMessages = enrichedMessages.filter(Boolean);

        // --- Пометка чата прочитанным ---
        const readerId = (currentUser.role === 'Owner' || currentUser.role === 'Staff') ? currentUser.companyId : currentUser.username;
        const readTimestamp = Date.now();
        if (readerId) {
            await firebaseService.resetUnreadCount(chatId, readerId);
            await firebaseService.updateLastReadTimestamp(chatId, readerId, readTimestamp);
            log.info(`[GET /chats/:chatId] Chat marked as read up to ${readTimestamp} by reader ${readerId}`);
            // --- Уведомляем ДРУГИХ участников о прочтении через Socket.IO ---
             const otherUsernamesToNotify = [];
             const companyIdsToNotify = [];
             otherParticipantIds.forEach(pId => { /* ... определение otherUsernamesToNotify и companyIdsToNotify ... */
                  const isCompany = !(pId.includes('@') || pId.length < 10);
                  if(isCompany) { companyIdsToNotify.push(pId); } else { otherUsernamesToNotify.push(pId); }
             });
             for (const companyId of companyIdsToNotify) { /* ... добавление персонала компании ... */
                  const company = await firebaseService.getCompanyById(companyId);
                  if (company) { if (company.ownerUsername) otherUsernamesToNotify.push(company.ownerUsername); if (company.staff) otherUsernamesToNotify.push(...Object.keys(company.staff)); }
             }
             const finalUsernames = [...new Set(otherUsernamesToNotify)].filter(Boolean);
             finalUsernames.forEach(username => {
                 const userRoom = `user:${username}`;
                 io.to(userRoom).emit('messages_read_up_to', { chatId: chatId, readerId: readerId, readUpToTimestamp: readTimestamp });
                 log.info(`[Socket.IO] Emitted 'messages_read_up_to' to room ${userRoom} for chat ${chatId}`);
             });
            // Отправляем обновление счетчика себе
            const userRoom = `user:${currentUser.username}`;
            io.to(userRoom).emit('unread_count_update', { chatId: chatId, unreadCount: 0 });
        } else { log.warn(`[GET /chats/:chatId] Could not determine readerId`); }

        // --- Определение темы и ссылки ---
        let chatSubjectDisplay = chatData.subject || 'Чат';
        let subjectLink = null;
        if(chatData.propertyId) {
             const property = await firebaseService.getPropertyById(chatData.propertyId).catch(e => null);
             if (property) { chatSubjectDisplay = `Объект: ${property.Title}`; subjectLink = `/properties/${chatData.propertyId}`; }
             else if (chatData.propertyId) { chatSubjectDisplay = `Объект #${chatData.propertyId.substring(0,5)}...`; }
        } else if (chatData.bookingId) { chatSubjectDisplay = `Бронь #${chatData.bookingId.substring(0,6)}...`; }

        // --- Рендеринг ---
        res.render('chat-view', {
            title: `Чат: ${otherParticipantName}`,
            chatId: chatId,
            chatSubject: chatSubjectDisplay,
            subjectLink: subjectLink,
            messages: validEnrichedMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)), // Старые сверху
            otherParticipantName: otherParticipantName,
            propertyId: chatData.propertyId,
            bookingId: chatData.bookingId,
            currentUser: currentUser // Передаем для рендеринга сообщений
        });

    } catch (error) {
        log.error(`[GET /chats/:chatId] Error fetching chat details for ${chatId}:`, error);
        next(error);
    }
});


// --- API Маршрут для деталей чата (JSON) ---
// GET /api/chats/:chatId/details - Получить JSON с деталями чата и сообщениями
router.get('/api/chats/:chatId/details', isLoggedIn, isChatParticipant, async (req, res) => { // Убрали next, т.к. ошибки обрабатываются try/catch
    const chatId = req.params.chatId;
    const currentUser = req.session.user;
    const chatData = req.chatData; // Данные чата из middleware
    const io = req.app.get('socketio'); // Получаем io для уведомлений
    const limit = 50; // Лимит сообщений

    log.info(`[API GET /chats/:chatId/details] User ${currentUser.username} requesting details for chat ${chatId}`);

    try {
        // --- Определение другого участника (как и раньше) ---
        const participants = chatData.participants || {};
        // <<< ОПРЕДЕЛЯЕМ otherParticipantIds ЗДЕСЬ >>>
        const otherParticipantIds = Object.keys(participants).filter(pId =>
            pId !== currentUser.username &&
            !((currentUser.role === 'Owner' || currentUser.role === 'Staff') && pId === currentUser.companyId)
        );
        // Находим первый ID другого участника (для имени)
        const otherParticipantId = otherParticipantIds.length > 0 ? otherParticipantIds[0] : null;
        let otherParticipantName = 'Неизвестный';
        if (otherParticipantId) {
             const isCompany = !(otherParticipantId.includes('@') || otherParticipantId.length < 10);
             if (isCompany) {
                 const company = await firebaseService.getCompanyById(otherParticipantId).catch(e => null);
                 otherParticipantName = company?.companyName || `Компания #${otherParticipantId.substring(0, 5)}...`;
             } else {
                 const user = await firebaseService.getUserByUsername(otherParticipantId).catch(e => null);
                 otherParticipantName = user?.FullName || user?.Username || `Пользователь ${otherParticipantId.substring(0, 5)}...`;
             }
        }
        log.debug(`[API GET /chats/:chatId/details] Other participant: ${otherParticipantName} (${otherParticipantId})`);

        // --- Получение сообщений ---
        const messages = await firebaseService.getChatMessages(chatId, currentUser, limit); // Передаем currentUser

        // --- Обогащение сообщений ---
        const enrichedMessages = await Promise.all(messages.map(async msg => {
            if (!msg || !msg.senderId) return null;
            const sender = await firebaseService.getUserByUsername(msg.senderId).catch(e => null);
            return {
                id: msg.id, chatId: msg.chatId, senderId: msg.senderId,
                text: msg.text, timestamp: msg.timestamp,
                isOwnMessage: msg.senderId === currentUser.username,
                isReadByRecipient: msg.isReadByRecipient, // Флаг прочтения
                senderName: sender?.FullName || sender?.Username || msg.senderId,
                senderAvatar: sender ? await firebaseService.getUserAvatarDataUri(sender.Username) : '/images/placeholder-avatar.png',
                timestampFormatted: msg.timestamp ? new Date(msg.timestamp).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '??:??'
            };
        }));
        const validMessages = enrichedMessages.filter(Boolean).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)); // Старые сверху

        // --- Определение темы/ссылки ---
        let chatSubjectDisplay = chatData.subject || 'Чат';
        let subjectLink = null;
        if(chatData.propertyId) {
            const property = await firebaseService.getPropertyById(chatData.propertyId).catch(e=>null);
            if(property) { chatSubjectDisplay = `Объект: ${property.Title}`; subjectLink = `/properties/${chatData.propertyId}`; }
            else if (chatData.propertyId) { chatSubjectDisplay = `Объект #${chatData.propertyId.substring(0,5)}...`; }
        } else if (chatData.bookingId) { chatSubjectDisplay = `Бронь #${chatData.bookingId.substring(0,6)}...`; }

        // --- Пометка прочитанным и уведомление других ---
        const readerId = (currentUser.role === 'Owner' || currentUser.role === 'Staff') ? currentUser.companyId : currentUser.username;
        const readTimestamp = Date.now();
        if (readerId) {
            await firebaseService.resetUnreadCount(chatId, readerId);
            await firebaseService.updateLastReadTimestamp(chatId, readerId, readTimestamp);
            log.info(`[API GET /chats/:chatId/details] Marked read for ${readerId}`);

            // --- Уведомляем других (ИСПОЛЬЗУЕМ УЖЕ ОПРЕДЕЛЕННУЮ otherParticipantIds) ---
            const otherUsernamesToNotify = [];
            const companyIdsToNotify = [];
             otherParticipantIds.forEach(pId => { // <<< ИСПОЛЬЗУЕМ эту переменную
                 const isCompany = !(pId.includes('@') || pId.length < 10);
                 if(isCompany) { companyIdsToNotify.push(pId); } else { otherUsernamesToNotify.push(pId); }
             });
             for (const companyId of companyIdsToNotify) {
                 const company = await firebaseService.getCompanyById(companyId);
                 if (company) { if (company.ownerUsername) otherUsernamesToNotify.push(company.ownerUsername); if (company.staff) otherUsernamesToNotify.push(...Object.keys(company.staff)); }
             }
             const finalUsernames = [...new Set(otherUsernamesToNotify)].filter(Boolean);
             finalUsernames.forEach(username => {
                 const userRoom = `user:${username}`;
                 io.to(userRoom).emit('messages_read_up_to', { chatId: chatId, readerId: readerId, readUpToTimestamp: readTimestamp });
                 log.info(`[Socket.IO] Emitted 'messages_read_up_to' to room ${userRoom} for chat ${chatId}`);
             });
            // Уведомление себе об обновлении счетчика
            const userRoom = `user:${currentUser.username}`;
            io.to(userRoom).emit('unread_count_update', { chatId: chatId, unreadCount: 0 });
        } else { log.warn(`[API GET /chats/:chatId/details] Could not determine readerId`); }

        // --- Отправка JSON ответа ---
        res.json({
            success: true,
            chatId: chatId,
            otherParticipantName: otherParticipantName,
            chatSubject: chatSubjectDisplay,
            subjectLink: subjectLink,
            messages: validMessages,
            limit: limit
        });

    } catch (error) {
        log.error(`[API GET /chats/:chatId/details] Error:`, error);
        res.status(500).json({ success: false, error: 'Ошибка загрузки данных чата.' });
    }
});

// POST /chats/:chatId/messages - Отправить новое сообщение
router.post('/chats/:chatId/messages', isLoggedIn, isChatParticipant, async (req, res, next) => {
    const chatId = req.params.chatId;
    const currentUser = req.session.user;
    const chatData = req.chatData;
    const { text } = req.body;
    const io = req.app.get('socketio');

    log.info(`[POST /chats/:chatId/messages] User ${currentUser.username} sending to chat ${chatId}`);

    if (!text || !text.trim()) { return res.status(400).json({ success: false, error: 'Сообщение пустое.' }); }
    if (text.trim().length > 2000) { return res.status(400).json({ success: false, error: 'Сообщение > 2000 симв.' }); }

    try {
        const senderId = currentUser.username;
        const senderRole = currentUser.role;

        // 1. Создаем сообщение
        const newMessageData = { chatId, senderId, senderRole, text: text.trim(), timestamp: admin.database.ServerValue.TIMESTAMP };
        const newMessage = await firebaseService.createMessage(newMessageData);
        const messageTimestamp = newMessage.timestamp || Date.now();

        // 2. Определяем ID других участников
        const participants = chatData.participants || {};
        const otherParticipantIds = Object.keys(participants).filter(pId => pId !== senderId && pId !== currentUser.companyId);

        // 3. Обновляем метаданные чата (УПРОЩЕНО - без транзакции для счетчиков)
        //    Сначала обновляем основные поля
        await db.ref(`chats/${chatId}`).update({
             lastMessageText: newMessage.text,
             lastMessageTimestamp: messageTimestamp,
             lastMessageSenderId: senderId
        });
        //    Затем атомарно инкрементируем счетчики
        const incrementPromises = otherParticipantIds.map(recipientId => {
             if (!recipientId) return Promise.resolve();
             const unreadRef = db.ref(`chats/${chatId}/unreadCounts/${recipientId}`);
             return unreadRef.transaction(currentCount => (currentCount || 0) + 1);
        });
        await Promise.all(incrementPromises);
        log.info(`[POST /chats/:chatId/messages] Chat metadata and unread counts updated for ${chatId}.`);

        // Обновляем timestamp в user_chats/company_chats
        const chatUpdateTime = Date.now();
        const updateLinksPromises = [];
        // ... (логика обновления ссылок без изменений) ...
        if (participants[senderId]) updateLinksPromises.push(db.ref(`user_chats/${senderId}/${chatId}`).set(chatUpdateTime));
        if (currentUser.companyId && participants[currentUser.companyId]) updateLinksPromises.push(db.ref(`company_chats/${currentUser.companyId}/${chatId}`).set(chatUpdateTime));
        otherParticipantIds.forEach(pId => {
             const isCompany = !(pId.includes('@') || pId.length < 10);
             const refPath = isCompany ? `company_chats/${pId}/${chatId}` : `user_chats/${pId}/${chatId}`;
             updateLinksPromises.push(db.ref(refPath).set(chatUpdateTime));
        });
        await Promise.all(updateLinksPromises);


        // 4. Готовим данные для Socket.IO
        const senderInfo = { senderId: senderId, senderName: currentUser.fullName || senderId, senderAvatar: await firebaseService.getUserAvatarDataUri(senderId) };
        const messageForEmit = { /* ... (данные сообщения как раньше) ... */
             id: newMessage.id, chatId: newMessage.chatId, senderId: newMessage.senderId,
             senderRole: newMessage.senderRole, text: newMessage.text, timestamp: messageTimestamp,
             ...senderInfo,
             timestampFormatted: new Date(messageTimestamp).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
             isOwnMessage: false, isReadByRecipient: false
        };

        // 5. Отправляем сообщение и ОБНОВЛЕННЫЙ СЧЕТЧИК получателям
        await Promise.all(otherParticipantIds.map(async (participantId) => {
            if (!participants[participantId]) return;
            let recipientUsernames = [];
            let recipientCompanyId = null;
            const isCompanyRecipient = !(participantId.includes('@') || participantId.length < 10);

            if (isCompanyRecipient) {
                recipientCompanyId = participantId;
                try {
                    const company = await firebaseService.getCompanyById(participantId);
                    if (company) { if (company.ownerUsername) recipientUsernames.push(company.ownerUsername); if (company.staff) recipientUsernames.push(...Object.keys(company.staff)); }
                } catch (e) { log.error(`Error fetching company ${participantId}:`, e); }
            } else { recipientUsernames.push(participantId); }

            const finalRecipients = [...new Set(recipientUsernames)].filter(Boolean);

            // <<< ПОЛУЧАЕМ АКТУАЛЬНЫЙ СЧЕТЧИК ДЛЯ КАЖДОГО ПОЛУЧАТЕЛЯ >>>
            let totalUnreadForRecipient = 0;
            try {
                // Определяем ID для чтения счетчика (либо username, либо companyId)
                const readerIdForRecipient = isCompanyRecipient ? recipientCompanyId : participantId;
                if (readerIdForRecipient) {
                     const chatSnapshot = await db.ref(`chats/${chatId}/unreadCounts/${readerIdForRecipient}`).once('value');
                     totalUnreadForRecipient = chatSnapshot.val() || 0; // Получаем актуальное значение
                }
            } catch (e) { log.error(`Failed to get recipient unread count for ${participantId}/${recipientCompanyId}`, e); }


            finalRecipients.forEach(recipientUsername => {
                if (recipientUsername !== senderId) {
                    const userRoom = `user:${recipientUsername}`;
                    // Отправляем сообщение
                    io.to(userRoom).emit('new_message', { chatId: chatId, message: messageForEmit });
                    // Отправляем АКТУАЛЬНЫЙ ОБЩИЙ счетчик
                    io.to(userRoom).emit('total_unread_update', { totalUnreadCount: totalUnreadForRecipient });
                    log.info(`[Socket.IO] Emitted new_message & total_unread_update(${totalUnreadForRecipient}) to room ${userRoom} for chat ${chatId}`);
                }
            });
        })); // Конец Promise.all

        // 6. Отвечаем успехом отправителю
        res.status(201).json({
            success: true, message: 'Сообщение отправлено.',
            sentMessage: { ...messageForEmit, isOwnMessage: true }
        });

    } catch (error) { log.error(`[POST /chats/:chatId/messages] Error:`, error); next(error); }
});


// POST /chats - Создать новый чат
router.post('/chats', isLoggedIn, async (req, res, next) => {
    const currentUser = req.session.user;
    const { recipientCompanyId, propertyId, bookingId, initialMessage } = req.body;

    log.info(`[POST /chats] User ${currentUser.username} initiating chat with company ${recipientCompanyId}. Property: ${propertyId}, Booking: ${bookingId}`);

    // Валидация
    if (!recipientCompanyId) return res.status(400).json({ success: false, error: 'Нет ID компании.' });
    if (!initialMessage?.trim()) return res.status(400).json({ success: false, error: 'Нужен текст сообщения.' });
    if (initialMessage.trim().length > 2000) return res.status(400).json({ success: false, error: 'Сообщение > 2000 симв.' });

    try {
        const tenantId = currentUser.username;
        const companyId = recipientCompanyId;
        const io = req.app.get('socketio'); // Получаем io

        const company = await firebaseService.getCompanyById(companyId);
        if (!company) return res.status(404).json({ success: false, error: 'Компания не найдена.' });

        // Ищем существующий чат (или создаем)
        let chatId = await firebaseService.findExistingChat(tenantId, companyId, propertyId);
        let isNewChat = false;
        const currentTimestamp = Date.now();

        if (!chatId) {
            isNewChat = true;
            log.info(`[POST /chats] Creating new chat`);
            const participants = { [tenantId]: true, [companyId]: true };
            let subject = `Чат с ${company.companyName || companyId}`;
            if (propertyId) { const property = await firebaseService.getPropertyById(propertyId).catch(e=>null); subject = property?.Title ? `Объект: ${property.Title}` : `Объект #${propertyId.substring(0,5)}...`; }
            const newChatData = { participants, propertyId: propertyId || null, bookingId: bookingId || null, createdAt: admin.database.ServerValue.TIMESTAMP, lastMessageText: initialMessage.trim(), lastMessageTimestamp: admin.database.ServerValue.TIMESTAMP, lastMessageSenderId: tenantId, unreadCounts: { [tenantId]: 0, [companyId]: 1 }, subject };
            chatId = await firebaseService.createChat(newChatData);
            await db.ref(`user_chats/${tenantId}/${chatId}`).set(currentTimestamp);
            await db.ref(`company_chats/${companyId}/${chatId}`).set(currentTimestamp);
            log.info(`[POST /chats] New chat ${chatId} created and links added.`);
        } else {
            log.info(`[POST /chats] Found existing chat ${chatId}`);
        }

        // Создаем сообщение
        const newMessageData = { chatId, senderId: tenantId, senderRole: currentUser.role, text: initialMessage.trim(), timestamp: admin.database.ServerValue.TIMESTAMP };
        const newMessage = await firebaseService.createMessage(newMessageData);
        const messageTimestamp = newMessage.timestamp || currentTimestamp;

        // Обновляем метаданные чата (даже для нового, чтобы записать время первого сообщения)
        await firebaseService.updateChatMetadataOnNewMessage(chatId, {
            lastMessageText: newMessage.text,
            lastMessageTimestamp: messageTimestamp,
            lastMessageSenderId: tenantId,
            // Увеличиваем счетчик только для компании, т.к. это первое сообщение от Tenant'а
            recipientsToIncrementUnread: [companyId]
        });
        // Обновляем время последнего сообщения в индексах
        await db.ref(`user_chats/${tenantId}/${chatId}`).set(messageTimestamp);
        await db.ref(`company_chats/${companyId}/${chatId}`).set(messageTimestamp);

        // Отправка уведомления через Socket.IO
        const senderInfo = { senderId: tenantId, senderName: currentUser.fullName || tenantId, senderAvatar: await firebaseService.getUserAvatarDataUri(tenantId) };
        const messageForEmit = { ...newMessage, timestamp: messageTimestamp, ...senderInfo, timestampFormatted: new Date(messageTimestamp).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' }), isOwnMessage: false, isReadByRecipient: false };
        const recipientUsernames = [company.ownerUsername, ...(company.staff ? Object.keys(company.staff) : [])].filter(Boolean);
        recipientUsernames.forEach(recipientUsername => {
            if (recipientUsername !== tenantId) {
                const userRoom = `user:${recipientUsername}`;
                io.to(userRoom).emit('new_message', { chatId, message: messageForEmit });
                io.to(userRoom).emit('unread_count_increment', { chatId });
                log.info(`[Socket.IO] Emitted new_message & unread_count_increment to room ${userRoom} for chat ${chatId}`);
            }
        });

        res.status(201).json({ success: true, message: 'Сообщение отправлено.', chatId: chatId });

    } catch (error) { log.error('[POST /chats] Error:', error); next(error); }
});


// GET /chats/:chatId/messages/history - Получить историю сообщений (AJAX)
router.get('/chats/:chatId/messages/history', isLoggedIn, isChatParticipant, async (req, res) => {
    const chatId = req.params.chatId;
    const currentUser = req.session.user;
    const limit = parseInt(req.query.limit) || 20;
    const beforeTimestamp = req.query.beforeTimestamp ? parseInt(req.query.beforeTimestamp) : null;

    log.info(`[GET /chats/:chatId/messages/history] User ${currentUser.username} loading older for chat ${chatId}, before: ${beforeTimestamp}`);

    try {
        const messages = await firebaseService.getChatMessages(chatId, currentUser, limit, beforeTimestamp);

        const enrichedMessages = await Promise.all(messages.map(async (msg) => {
             if (!msg || !msg.senderId) return null;
            const sender = await firebaseService.getUserByUsername(msg.senderId).catch(e => null);
            return {
                id: msg.id, chatId: msg.chatId, senderId: msg.senderId,
                text: msg.text, timestamp: msg.timestamp,
                isOwnMessage: msg.senderId === currentUser.username,
                isReadByRecipient: msg.isReadByRecipient,
                senderName: sender?.FullName || sender?.Username || msg.senderId,
                senderAvatar: sender ? await firebaseService.getUserAvatarDataUri(sender.Username) : '/images/placeholder-avatar.png',
                timestampFormatted: msg.timestamp ? new Date(msg.timestamp).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '??:??'
            };
        }));
        const validMessages = enrichedMessages.filter(Boolean).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)); // Старые сверху

        res.json({
            success: true,
            messages: validMessages,
            hasMore: messages.length === limit // Если загрузили ровно лимит, скорее всего есть еще
        });

    } catch (error) {
        log.error(`[GET /chats/:chatId/messages/history] Error fetching history for chat ${chatId}:`, error);
        res.status(500).json({ success: false, error: 'Ошибка загрузки истории сообщений.' });
    }
});

module.exports = router;