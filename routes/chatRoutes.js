// routes/chatRoutes.js
const express = require('express');
const { isLoggedIn } = require('../middleware/authMiddleware');
const firebaseService = require('../services/firebaseService'); // Убедитесь, что он экспортирует нужные функции
const admin = require('firebase-admin');
const db = admin.database();
const log = require('electron-log');

const router = express.Router();

// --- Middleware: Проверка участия в чате ---
// (Код middleware isChatParticipant остается без изменений, как в предыдущем ответе)
async function isChatParticipant(req, res, next) {
    const chatId = req.params.chatId;
    const currentUser = req.session.user;

    if (!chatId || !currentUser || !currentUser.username) {
        log.warn('[isChatParticipant] chatId or currentUser missing.');
        return res.status(401).json({ success: false, error: 'Требуется авторизация.' });
    }

    try {
        const chat = await firebaseService.getChatById(chatId);
        if (!chat) {
            log.warn(`[isChatParticipant] Chat ${chatId} not found.`);
            return res.status(404).json({ success: false, error: 'Чат не найден.' });
        }

        const participants = chat.participants || {};
        // Проверяем прямое участие пользователя
        const isUserParticipant = participants[currentUser.username];
        // Проверяем участие через компанию (если пользователь Owner или Staff)
        const isCompanyParticipant = (currentUser.role === 'Owner' || currentUser.role === 'Staff')
                                      && currentUser.companyId
                                      && participants[currentUser.companyId];

        if (isUserParticipant || isCompanyParticipant) {
            req.chatData = chat; // Сохраняем данные чата для использования в маршруте
            log.debug(`[isChatParticipant] Access granted for user ${currentUser.username} to chat ${chatId}`);
            return next();
        } else {
            log.warn(`[isChatParticipant] User ${currentUser.username} (Company: ${currentUser.companyId}) is not a participant of chat ${chatId}. Participants:`, participants);
            return res.status(403).json({ success: false, error: 'Доступ к этому чату запрещен.' });
        }
    } catch (error) {
        log.error(`[isChatParticipant] Error checking participation for chat ${chatId}:`, error);
        return res.status(500).json({ success: false, error: 'Ошибка проверки доступа к чату.' });
    }
}

// --- Маршруты ---

// GET /chats - Получить список чатов для текущего пользователя
// (Код маршрута GET /chats остается без изменений, как в предыдущем ответе)
router.get('/chats', isLoggedIn, async (req, res, next) => {
    const currentUser = req.session.user;
    log.info(`[GET /chats] Fetching chats for user: ${currentUser.username}, Role: ${currentUser.role}, Company: ${currentUser.companyId}`);

    try {
        const chats = await firebaseService.getUserChats(currentUser.username, currentUser.companyId);

        // Обогащение данных чатов
        const enrichedChats = await Promise.all(chats.map(async (chat) => {
            if (!chat || !chat.id) return null; // Пропускаем невалидные чаты

            const participants = chat.participants || {};
            // Находим ID другого участника (не текущего юзера и не его компанию)
            const otherParticipantId = Object.keys(participants).find(pId =>
                pId !== currentUser.username && // Не сам пользователь
                !((currentUser.role === 'Owner' || currentUser.role === 'Staff') && pId === currentUser.companyId) // Не его компания
            );

            let otherParticipantName = 'Неизвестный';
            let otherParticipantAvatar = '/images/placeholder-avatar.png'; // Дефолтный аватар
            let chatSubject = chat.subject || 'Чат';

            if (otherParticipantId) {
                // Определяем, кто второй участник: пользователь или компания
                const isCompanyParticipant = !(otherParticipantId.includes('@') || otherParticipantId.length < 10); // Простая эвристика

                if (isCompanyParticipant) { // Другой участник - компания
                    const company = await firebaseService.getCompanyById(otherParticipantId).catch(e => null);
                    if (company) {
                        otherParticipantName = company.companyName || `Компания #${otherParticipantId.substring(0, 5)}...`;
                        otherParticipantAvatar = await firebaseService.getCompanyLogoDataUri(otherParticipantId);
                    } else {
                        otherParticipantName = `Компания #${otherParticipantId.substring(0, 5)}...`;
                        otherParticipantAvatar = '/images/placeholder-company.png';
                    }
                } else { // Другой участник - пользователь (Tenant)
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
                 // Можно установить имя по умолчанию или пропустить чат
                 otherParticipantName = "Групповой чат?"; // Или другое обозначение
            }


            // Обновляем тему чата, если она связана с объектом
            if (!chat.subject && chat.propertyId) {
                const property = await firebaseService.getPropertyById(chat.propertyId).catch(e => null);
                if (property && property.Title) {
                    chatSubject = `Объект: ${property.Title}`;
                } else if (chat.propertyId) {
                     chatSubject = `Объект #${chat.propertyId.substring(0,5)}...`;
                }
            }

            // Определяем непрочитанные сообщения для ТЕКУЩЕГО пользователя/компании
            let unreadCount = 0;
            const currentReaderId = (currentUser.role === 'Owner' || currentUser.role === 'Staff')
                ? currentUser.companyId
                : currentUser.username;

            if (chat.unreadCounts && currentReaderId && chat.unreadCounts[currentReaderId]) {
                 unreadCount = chat.unreadCounts[currentReaderId];
            }


            return {
                id: chat.id, // Убедимся, что ID передается
                participants: chat.participants,
                propertyId: chat.propertyId,
                bookingId: chat.bookingId,
                lastMessageText: chat.lastMessageText,
                lastMessageTimestamp: chat.lastMessageTimestamp,
                lastMessageSenderId: chat.lastMessageSenderId,
                createdAt: chat.createdAt,
                unreadCounts: chat.unreadCounts, // Передаем все счетчики
                // Обогащенные поля:
                otherParticipantId: otherParticipantId, // Передаем ID другого участника
                otherParticipantName,
                otherParticipantAvatar,
                displaySubject: chatSubject,
                unreadCountForCurrentUser: unreadCount,
                lastMessageTimestampRelative: chat.lastMessageTimestamp
                    ? new Date(chat.lastMessageTimestamp).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
                    : '',
                lastMessageTextSnippet: chat.lastMessageText
                    ? (chat.lastMessageText.length > 40 ? chat.lastMessageText.substring(0, 37) + '...' : chat.lastMessageText)
                    : 'Нет сообщений'
            };
        }));

        const validEnrichedChats = enrichedChats.filter(Boolean); // Удаляем null (ошибки)

        // Сортировка: сначала с непрочитанными, потом по дате последнего сообщения
        validEnrichedChats.sort((a, b) => {
            const unreadDiff = (b.unreadCountForCurrentUser || 0) - (a.unreadCountForCurrentUser || 0);
            if (unreadDiff !== 0) return unreadDiff;
            return (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0);
        });

        res.render('chats', {
            title: 'Мои чаты',
            chats: validEnrichedChats
        });

    } catch (error) {
        log.error('[GET /chats] Error fetching user chats:', error);
        next(error);
    }
});


// GET /chats/:chatId - Получить конкретный чат и его сообщения
// (Код маршрута GET /chats/:chatId остается без изменений, как в предыдущем ответе)
router.get('/chats/:chatId', isLoggedIn, isChatParticipant, async (req, res, next) => {
    const chatId = req.params.chatId;
    const currentUser = req.session.user;
    const chatData = req.chatData;
    log.info(`[GET /chats/:chatId] User ${currentUser.username} accessing chat ${chatId}`);

    try {
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
                otherParticipantName = company ? (company.companyName || `Компания #${otherParticipantId.substring(0, 5)}...`) : `Компания #${otherParticipantId.substring(0, 5)}...`;
            } else {
                const tenantUser = await firebaseService.getUserByUsername(otherParticipantId).catch(e => null);
                otherParticipantName = tenantUser ? (tenantUser.FullName || tenantUser.Username) : `Пользователь ${otherParticipantId.substring(0, 5)}...`;
            }
        }

        const limit = 50;
        const messages = await firebaseService.getChatMessages(chatId, limit);

        const enrichedMessages = await Promise.all(messages.map(async (msg) => {
            if (!msg || !msg.senderId) return null; // Добавим проверку
            const sender = await firebaseService.getUserByUsername(msg.senderId).catch(e => null);
            return {
                ...msg,
                senderName: sender ? (sender.FullName || sender.Username) : msg.senderId,
                senderAvatar: sender ? await firebaseService.getUserAvatarDataUri(sender.Username) : '/images/placeholder-avatar.png',
                isOwnMessage: msg.senderId === currentUser.username,
                timestampFormatted: msg.timestamp ? new Date(msg.timestamp).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '??:??'
            };
        }));

        const validEnrichedMessages = enrichedMessages.filter(Boolean);

        // Определяем ID текущего пользователя/компании для маркировки непрочитанных
        const readerId = (currentUser.role === 'Owner' || currentUser.role === 'Staff')
            ? currentUser.companyId
            : currentUser.username;

        // Сбрасываем счетчик непрочитанных для ТЕКУЩЕГО пользователя/компании, если ID определен
        if (readerId) {
             await firebaseService.resetUnreadCount(chatId, readerId);
             log.info(`[GET /chats/:chatId] Unread count reset attempt for reader ${readerId}`);
              // Отправляем сокет-событие для обновления счетчика в списке чатов у самого себя
              const io = req.app.get('socketio');
              const userRoom = `user:${currentUser.username}`;
              io.to(userRoom).emit('unread_count_update', { chatId: chatId, unreadCount: 0 });
              log.info(`[Socket.IO] Emitted 'unread_count_update' to self (${userRoom}) for chat ${chatId}`);
        } else {
             log.warn(`[GET /chats/:chatId] Could not determine readerId for user ${currentUser.username}`);
        }

        let chatSubjectDisplay = chatData.subject || 'Чат';
        let subjectLink = null;
        if(chatData.propertyId) {
             const property = await firebaseService.getPropertyById(chatData.propertyId).catch(e => null);
             if (property) {
                  chatSubjectDisplay = `Объект: ${property.Title}`;
                  subjectLink = `/properties/${chatData.propertyId}`;
             } else if (chatData.propertyId) {
                  chatSubjectDisplay = `Объект #${chatData.propertyId.substring(0,5)}...`;
             }
        } else if (chatData.bookingId) {
             chatSubjectDisplay = `Бронь #${chatData.bookingId.substring(0,6)}...`;
             // TODO: Добавить ссылку на бронь, если будет такая страница
        }

        res.render('chat-view', {
            title: `Чат: ${otherParticipantName}`,
            chatId: chatId,
            chatSubject: chatSubjectDisplay, // Название темы чата
            subjectLink: subjectLink, // Ссылка на связанный объект/бронь (если есть)
            messages: validEnrichedMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)), // Старые сверху
            otherParticipantName: otherParticipantName,
            propertyId: chatData.propertyId,
            bookingId: chatData.bookingId
        });

    } catch (error) {
        log.error(`[GET /chats/:chatId] Error fetching chat details for ${chatId}:`, error);
        next(error);
    }
});


// POST /chats/:chatId/messages - Отправить новое сообщение (ИСПРАВЛЕНО)
router.post('/chats/:chatId/messages', isLoggedIn, isChatParticipant, async (req, res, next) => {
    const chatId = req.params.chatId;
    const currentUser = req.session.user;
    const chatData = req.chatData;
    const { text } = req.body;
    const io = req.app.get('socketio');

    log.info(`[POST /chats/:chatId/messages] User ${currentUser.username} sending message to chat ${chatId}`);

    if (!text || text.trim().length === 0) {
        return res.status(400).json({ success: false, error: 'Сообщение не может быть пустым.' });
    }
    if (text.trim().length > 2000) {
        return res.status(400).json({ success: false, error: 'Сообщение слишком длинное (макс. 2000 симв.).' });
    }

    try {
        const senderId = currentUser.username;
        const senderRole = currentUser.role;

        // 1. Создаем сообщение
        const newMessageData = {
            chatId: chatId,
            senderId: senderId,
            senderRole: senderRole,
            text: text.trim(),
            timestamp: admin.database.ServerValue.TIMESTAMP
        };
        // Функция createMessage должна возвращать объект с реальным timestamp или Date.now()
        const newMessage = await firebaseService.createMessage(newMessageData);
        // Убедимся, что timestamp числовой для дальнейшей работы
        const messageTimestamp = newMessage.timestamp && typeof newMessage.timestamp === 'object' ? Date.now() : (newMessage.timestamp || Date.now());


        // 2. Определяем ID других участников чата
        const participants = chatData.participants || {};
        const otherParticipantIds = Object.keys(participants).filter(pId =>
            pId !== senderId && // Не сам отправитель
            !((senderRole === 'Owner' || senderRole === 'Staff') && pId === currentUser.companyId) // Не его же компания
        );

        // 3. Обновляем метаданные чата (последнее сообщение, timestamp, счетчики)
        await firebaseService.updateChatMetadataOnNewMessage(chatId, {
            lastMessageText: newMessage.text,
            lastMessageTimestamp: messageTimestamp, // Используем полученный timestamp
            lastMessageSenderId: senderId,
            recipientsToIncrementUnread: otherParticipantIds // Увеличиваем счетчик для ВСЕХ других
        });
         // Обновляем timestamp в user_chats и company_chats для сортировки
         const chatUpdateTime = Date.now();
         const updateLinksPromises = [];
         if (participants[senderId]) { // Обновляем для отправителя
             updateLinksPromises.push(db.ref(`user_chats/${senderId}/${chatId}`).set(chatUpdateTime));
         }
         if (currentUser.companyId && participants[currentUser.companyId]) { // Обновляем для компании отправителя
              updateLinksPromises.push(db.ref(`company_chats/${currentUser.companyId}/${chatId}`).set(chatUpdateTime));
         }
         otherParticipantIds.forEach(pId => { // Обновляем для получателей
              const isCompany = !(pId.includes('@') || pId.length < 10);
              if (isCompany) {
                   updateLinksPromises.push(db.ref(`company_chats/${pId}/${chatId}`).set(chatUpdateTime));
              } else {
                   updateLinksPromises.push(db.ref(`user_chats/${pId}/${chatId}`).set(chatUpdateTime));
              }
         });
         await Promise.all(updateLinksPromises);


        // 4. Готовим данные об отправителе для Socket.IO
        const senderInfo = {
            senderId: senderId,
            senderName: currentUser.fullName || currentUser.username,
            senderAvatar: await firebaseService.getUserAvatarDataUri(senderId)
        };

        // 5. Отправляем сообщение через Socket.IO ВСЕМ ПОЛУЧАТЕЛЯМ
        // Используем Promise.all для асинхронного получения данных компаний
        await Promise.all(otherParticipantIds.map(async (participantId) => {
            if (!participants[participantId]) return; // Пропускаем, если ID некорректен

            let recipientUsernames = [];
            const isCompanyRecipient = !(participantId.includes('@') || participantId.length < 10);

            if (isCompanyRecipient) {
                try {
                    const company = await firebaseService.getCompanyById(participantId);
                    if (company) {
                        if (company.ownerUsername) recipientUsernames.push(company.ownerUsername);
                        if (company.staff) recipientUsernames.push(...Object.keys(company.staff));
                        log.debug(`[Socket Emit Prep] Company ${participantId}: Notifying ${recipientUsernames.join(', ')}`);
                    } else {
                        log.warn(`[Socket Emit Prep] Company recipient ${participantId} not found.`);
                    }
                } catch (companyError) {
                    log.error(`[Socket Emit Prep] Error fetching company ${participantId}:`, companyError);
                }
            } else { // Получатель - пользователь
                recipientUsernames.push(participantId);
                log.debug(`[Socket Emit Prep] User recipient: ${participantId}`);
            }

            // Фильтруем уникальные и непустые имена
            const finalRecipients = [...new Set(recipientUsernames)].filter(Boolean);
            log.debug(`[Socket Emit Prep] Final usernames to notify for participant ${participantId}: ${finalRecipients.join(', ')}`);

            // Отправляем в комнаты
            finalRecipients.forEach(recipientUsername => {
                // Не отправляем уведомление самому себе
                if (recipientUsername !== senderId) {
                    const userRoom = `user:${recipientUsername}`;
                    log.info(`[Socket.IO] Emitting 'new_message' to room ${userRoom} for chat ${chatId}`);
                    io.to(userRoom).emit('new_message', {
                        chatId: chatId,
                        message: { // Отправляем полные данные сообщения
                            id: newMessage.id,
                            chatId: newMessage.chatId,
                            senderId: newMessage.senderId,
                            senderRole: newMessage.senderRole,
                            text: newMessage.text,
                            timestamp: messageTimestamp, // Реальный или примерный timestamp
                            senderName: senderInfo.senderName,
                            senderAvatar: senderInfo.senderAvatar,
                            timestampFormatted: new Date(messageTimestamp).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                            isOwnMessage: false // Для получателя это не своё сообщение
                        }
                    });
                     // Отправляем обновление счетчика непрочитанных
                    io.to(userRoom).emit('unread_count_increment', { chatId: chatId });
                    log.info(`[Socket.IO] Emitted 'unread_count_increment' to room ${userRoom} for chat ${chatId}`);
                } else {
                     log.debug(`[Socket Emit Skip] Skipping notification to self (${senderId})`);
                }
            });
        })); // Конец Promise.all

        // 6. Отвечаем успехом отправителю
        res.status(201).json({
            success: true,
            message: 'Сообщение отправлено.',
            sentMessage: { // Возвращаем полные данные для UI
                id: newMessage.id,
                chatId: newMessage.chatId,
                senderId: newMessage.senderId,
                senderRole: newMessage.senderRole,
                text: newMessage.text,
                timestamp: messageTimestamp,
                senderName: senderInfo.senderName,
                senderAvatar: senderInfo.senderAvatar,
                timestampFormatted: new Date(messageTimestamp).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                isOwnMessage: true // Для отправителя это своё сообщение
            }
        });

    } catch (error) {
        log.error(`[POST /chats/:chatId/messages] Error sending message to chat ${chatId}:`, error);
        next(error);
    }
});


// POST /chats - Создать новый чат
// (Код маршрута POST /chats остается без изменений, как в предыдущем ответе)
router.post('/chats', isLoggedIn, async (req, res, next) => {
    const currentUser = req.session.user;
    const { recipientCompanyId, propertyId, bookingId, initialMessage } = req.body;

    log.info(`[POST /chats] User ${currentUser.username} initiating chat with company ${recipientCompanyId}. Property: ${propertyId}, Booking: ${bookingId}`);

    if (!recipientCompanyId) { return res.status(400).json({ success: false, error: 'Не указан получатель (ID компании).' }); }
    if (!initialMessage || initialMessage.trim().length === 0) { return res.status(400).json({ success: false, error: 'Необходимо ввести текст первого сообщения.' }); }
    if (initialMessage.trim().length > 2000) { return res.status(400).json({ success: false, error: 'Сообщение слишком длинное (макс. 2000 симв.).' }); }

    try {
        const tenantId = currentUser.username;
        const companyId = recipientCompanyId;

        const company = await firebaseService.getCompanyById(companyId);
        if (!company) { return res.status(404).json({ success: false, error: 'Компания-получатель не найдена.' }); }

        let existingChatId = await firebaseService.findExistingChat(tenantId, companyId, propertyId);
        let chatId;
        let isNewChat = false;
        const currentTimestamp = Date.now(); // Используем одинаковое время для всех обновлений

        if (existingChatId) {
            log.info(`[POST /chats] Found existing chat ${existingChatId}`);
            chatId = existingChatId;
        } else {
            log.info(`[POST /chats] Creating new chat`);
            isNewChat = true;
            const participants = { [tenantId]: true, [companyId]: true };
            let subject = `Чат с компанией ${company.companyName || companyId}`;
            if (propertyId) {
                const property = await firebaseService.getPropertyById(propertyId).catch(e=>null);
                subject = property?.Title ? `Объект: ${property.Title}` : `Объект #${propertyId.substring(0,5)}...`;
            }
            const newChatData = {
                participants: participants,
                propertyId: propertyId || null,
                bookingId: bookingId || null,
                createdAt: admin.database.ServerValue.TIMESTAMP, // Время создания чата
                lastMessageText: initialMessage.trim(),
                lastMessageTimestamp: admin.database.ServerValue.TIMESTAMP, // Время первого сообщения
                lastMessageSenderId: tenantId,
                unreadCounts: { [tenantId]: 0, [companyId]: 1 },
                subject: subject
            };
            chatId = await firebaseService.createChat(newChatData);
            log.info(`[POST /chats] New chat created with ID: ${chatId}`);
             // Добавляем ссылки на чат в user_chats и company_chats
             await db.ref(`user_chats/${tenantId}/${chatId}`).set(currentTimestamp);
             await db.ref(`company_chats/${companyId}/${chatId}`).set(currentTimestamp);
             log.info(`[POST /chats] Chat links added for ${chatId}`);
        }

        // Создаем сообщение
        const newMessageData = { chatId: chatId, senderId: tenantId, senderRole: currentUser.role, text: initialMessage.trim(), timestamp: admin.database.ServerValue.TIMESTAMP };
        const newMessage = await firebaseService.createMessage(newMessageData);
        const messageTimestamp = newMessage.timestamp && typeof newMessage.timestamp === 'object' ? currentTimestamp : (newMessage.timestamp || currentTimestamp);

        // Обновляем метаданные, если чат не новый (т.к. для нового они уже установлены при создании)
        if (!isNewChat) {
            await firebaseService.updateChatMetadataOnNewMessage(chatId, {
                lastMessageText: newMessage.text,
                lastMessageTimestamp: messageTimestamp,
                lastMessageSenderId: tenantId,
                recipientsToIncrementUnread: [companyId]
            });
             // Обновляем timestamp в user_chats и company_chats
             await db.ref(`user_chats/${tenantId}/${chatId}`).set(messageTimestamp);
             await db.ref(`company_chats/${companyId}/${chatId}`).set(messageTimestamp);
        }

        // Отправка уведомления через Socket.IO
        const io = req.app.get('socketio');
        const senderInfo = { senderId: tenantId, senderName: currentUser.fullName || tenantId, senderAvatar: await firebaseService.getUserAvatarDataUri(tenantId) };
        const recipientUsernames = [company.ownerUsername, ...(company.staff ? Object.keys(company.staff) : [])].filter(Boolean);

        recipientUsernames.forEach(recipientUsername => { // Переименовали для ясности
            if (recipientUsername !== tenantId) { // <<< ИСПРАВЛЕНО: Сравниваем с tenantId (отправителем)
                const userRoom = `user:${recipientUsername}`;
                log.info(`[Socket.IO] Emitting 'new_message' (from new chat/first msg) to room ${userRoom} for chat ${chatId}`);
                io.to(userRoom).emit('new_message', {
                    chatId: chatId,
                    message: { /* ... полные данные сообщения ... */ } // Убедитесь, что здесь все данные передаются
                });
                io.to(userRoom).emit('unread_count_increment', { chatId: chatId });
                log.info(`[Socket.IO] Emitted 'unread_count_increment' to room ${userRoom} for chat ${chatId}`);
            } else {
                 log.debug(`[Socket Emit Skip] Skipping notification to self (${tenantId})`);
            }
       });

        res.status(201).json({
            success: true,
            message: isNewChat ? 'Чат создан и сообщение отправлено.' : 'Сообщение отправлено в существующий чат.',
            chatId: chatId
        });

    } catch (error) {
        log.error('[POST /chats] Error creating chat:', error);
        next(error);
    }
});


// GET /chats/:chatId/messages/history - Получить историю сообщений
// (Код маршрута GET /chats/:chatId/messages/history остается без изменений)
router.get('/chats/:chatId/messages/history', isLoggedIn, isChatParticipant, async (req, res, next) => {
    const chatId = req.params.chatId;
    const currentUser = req.session.user;
    const limit = parseInt(req.query.limit) || 20;
    const beforeTimestamp = req.query.beforeTimestamp ? parseInt(req.query.beforeTimestamp) : null;

    log.info(`[GET /chats/:chatId/messages/history] User ${currentUser.username} loading older messages for chat ${chatId}, before: ${beforeTimestamp}`);

    try {
        const messages = await firebaseService.getChatMessages(chatId, limit, beforeTimestamp);

        const enrichedMessages = await Promise.all(messages.map(async (msg) => {
             if (!msg || !msg.senderId) return null;
            const sender = await firebaseService.getUserByUsername(msg.senderId).catch(e => null);
            return {
                ...msg,
                senderName: sender ? (sender.FullName || sender.Username) : msg.senderId,
                senderAvatar: sender ? await firebaseService.getUserAvatarDataUri(sender.Username) : '/images/placeholder-avatar.png',
                isOwnMessage: msg.senderId === currentUser.username,
                timestampFormatted: msg.timestamp ? new Date(msg.timestamp).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '??:??'
            };
        }));

        const validEnrichedMessages = enrichedMessages.filter(Boolean);

        res.json({
            success: true,
            messages: validEnrichedMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)), // Старые сверху
            hasMore: messages.length === limit
        });

    } catch (error) {
        log.error(`[GET /chats/:chatId/messages/history] Error fetching message history for chat ${chatId}:`, error);
        res.status(500).json({ success: false, error: 'Ошибка загрузки истории сообщений.' });
    }
});

module.exports = router;