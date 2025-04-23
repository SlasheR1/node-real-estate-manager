// routes/chatRoutes.js (ПОЛНАЯ ВЕРСИЯ v3 - Исправлены счетчики и isOwnMessage)
const express = require('express');
const { isLoggedIn } = require('../middleware/authMiddleware');
const firebaseService = require('../services/firebaseService'); // Используем общую функцию подсчета
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
        if (req.path.startsWith('/api/')) {
             return res.status(401).json({ success: false, error: 'Требуется авторизация.' });
        } else {
             req.session.message = { type: 'error', text: 'Требуется авторизация.' };
             return req.session.save(err => { if(err) log.error("Session save error:", err); res.redirect('/login'); });
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
                  return req.session.save(err => { if(err) log.error("Session save error:", err); res.redirect('/chats'); });
             }
        }

        const participants = chat.participants || {};
        const currentParticipantId = (currentUser.role === 'Owner' || currentUser.role === 'Staff') ? currentUser.companyId : currentUser.username;

        if (!currentParticipantId) { // Добавим проверку, что ID определился
             log.error(`[isChatParticipant] Failed to determine participant ID for user ${currentUser.username} (Role: ${currentUser.role}, CompanyId: ${currentUser.companyId})`);
             if (req.path.startsWith('/api/')) {
                 return res.status(500).json({ success: false, error: 'Ошибка определения участника.' });
             } else {
                  req.session.message = { type: 'error', text: 'Ошибка определения участника.' };
                  return req.session.save(err => { if(err) log.error("Session save error:", err); res.redirect('/'); });
             }
        }

        if (participants[currentParticipantId]) {
            req.chatData = chat;
            log.debug(`[isChatParticipant] Access granted for participant ${currentParticipantId} to chat ${chatId}`);
            return next();
        } else {
            log.warn(`[isChatParticipant] User/Company ${currentParticipantId} is not a participant of chat ${chatId}. Participants:`, participants);
             if (req.path.startsWith('/api/')) {
                 return res.status(403).json({ success: false, error: 'Доступ к этому чату запрещен.' });
             } else {
                 req.session.message = { type: 'error', text: 'Доступ к этому чату запрещен.' };
                 return req.session.save(err => { if(err) log.error("Session save error:", err); res.redirect('/chats'); });
             }
        }
    } catch (error) {
        log.error(`[isChatParticipant] Error checking participation for chat ${chatId}:`, error);
        if (req.path.startsWith('/api/')) {
             return res.status(500).json({ success: false, error: 'Ошибка проверки доступа к чату.' });
        } else {
             next(error);
        }
    }
}

// --- Маршруты ---

// GET /chats - Получить список чатов для текущего пользователя (HTML страница)
router.get('/chats', isLoggedIn, async (req, res, next) => {
    const currentUser = req.session.user;
    if (!currentUser) return res.redirect('/login');
    log.info(`[GET /chats] Fetching chats for user: ${currentUser.username}, Role: ${currentUser.role}, Company: ${currentUser.companyId}`);
    try {
        const chats = await firebaseService.getUserChats(currentUser.username, currentUser.companyId);
        const currentReaderId = (currentUser.role === 'Owner' || currentUser.role === 'Staff') ? currentUser.companyId : currentUser.username;

        if (!currentReaderId) {
             log.error(`[GET /chats] Critical: Could not determine readerId for user ${currentUser.username}`);
             return res.render('chats', { title: 'Мои чаты', chats: [], currentUser: currentUser, totalUnreadChatCount: 0 });
        }

        const enrichedChats = await Promise.all(chats.map(async (chat) => {
            if (!chat || !chat.id) return null;
            const participants = chat.participants || {};
            const otherParticipantId = Object.keys(participants).find(pId => pId !== currentUser.username && pId !== currentUser.companyId);
            let otherParticipantName = 'Неизвестный';
            let otherParticipantAvatar = '/images/placeholder-avatar.png';
            let chatSubject = chat.subject || 'Чат';

            // Определение имени, аватара и темы собеседника
            if (otherParticipantId) {
                const isCompanyParticipant = !(otherParticipantId.includes('@') || otherParticipantId.length < 10);
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
                log.warn(`[GET /chats] Could not determine other participant for chat ${chat.id}. Participants:`, participants);
                otherParticipantName = "Удаленный собеседник";
            }
            if (!chat.subject && chat.propertyId) {
                const property = await firebaseService.getPropertyById(chat.propertyId).catch(e => null);
                chatSubject = property?.Title ? `Объект: ${property.Title}` : `Объект #${chat.propertyId.substring(0,5)}...`;
            } else if (!chat.subject && chat.bookingId) {
                chatSubject = `Бронь #${chat.bookingId.substring(0,6)}...`;
            }

            // Получаем количество непрочитанных СООБЩЕНИЙ для текущего читателя
            const unreadCount = chat.unreadCounts?.[currentReaderId] || 0;

            // Форматируем время
            const lastTimestamp = chat.lastMessageTimestamp;
            let timestampRelative = '';
            if (lastTimestamp) {
                 const msgDate = new Date(lastTimestamp); const today = new Date(); const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
                 if (!isNaN(msgDate.getTime())) { if (msgDate.toDateString() === today.toDateString()) { timestampRelative = msgDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); } else if (msgDate.toDateString() === yesterday.toDateString()) { timestampRelative = 'Вчера'; } else { timestampRelative = msgDate.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }); } }
                 else { log.warn(`[GET /chats] Invalid lastMessageTimestamp in chat ${chat.id}: ${lastTimestamp}`); timestampRelative = '??.??.??'; }
            }

            const snippet = chat.lastMessageText ? (chat.lastMessageText.length > 35 ? chat.lastMessageText.substring(0, 32) + '...' : chat.lastMessageText) : 'Нет сообщений';

            return {
                id: chat.id, otherParticipantName, otherParticipantAvatar, displaySubject: chatSubject,
                unreadCountForCurrentUser: unreadCount, // Кол-во сообщений
                lastMessageTimestamp: lastTimestamp, lastMessageTimestampRelative: timestampRelative,
                lastMessageTextSnippet: snippet, lastMessageSenderId: chat.lastMessageSenderId
            };
        }));

        const validEnrichedChats = enrichedChats.filter(Boolean);
        // Сортируем по наличию непрочитанных, затем по времени
        validEnrichedChats.sort((a, b) => {
             const unreadA = a.unreadCountForCurrentUser > 0 ? 1 : 0;
             const unreadB = b.unreadCountForCurrentUser > 0 ? 1 : 0;
             if (unreadA > unreadB) return -1; if (unreadA < unreadB) return 1;
             return (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0);
        });

        // Общий счетчик передается из middleware (res.locals.totalUnreadChatCount)

        res.render('chats', {
            title: 'Мои чаты',
            chats: validEnrichedChats,
            currentUser: currentUser,
            // totalUnreadChatCount уже в locals
        });

    } catch (error) { log.error('[GET /chats] Error fetching user chats:', error); next(error); }
});


// GET /chats/:chatId - Получить конкретный чат и его сообщения (HTML страница)
router.get('/chats/:chatId', isLoggedIn, isChatParticipant, async (req, res, next) => {
    const chatId = req.params.chatId;
    const currentUser = req.session.user;
    const chatData = req.chatData;
    const io = req.app.get('socketio');
    log.info(`[GET /chats/:chatId] User ${currentUser.username} accessing chat ${chatId}`);
    try {
        const participants = chatData.participants || {};
        const otherParticipantIds = Object.keys(participants).filter(pId => pId !== currentUser.username && pId !== currentUser.companyId);
        const firstOtherParticipantId = otherParticipantIds[0] || null;
        let otherParticipantName = 'Неизвестный';
        // Определение имени собеседника
        if (firstOtherParticipantId) { const isCompanyParticipant = !(firstOtherParticipantId.includes('@') || firstOtherParticipantId.length < 10); if (isCompanyParticipant) { const company = await firebaseService.getCompanyById(firstOtherParticipantId).catch(e => null); otherParticipantName = company?.companyName || `Компания #${firstOtherParticipantId.substring(0, 5)}...`; } else { const tenantUser = await firebaseService.getUserByUsername(firstOtherParticipantId).catch(e => null); otherParticipantName = tenantUser?.FullName || tenantUser?.Username || `Пользователь ${firstOtherParticipantId.substring(0, 5)}...`; } }

        const limit = 50;
        const messages = await firebaseService.getChatMessages(chatId, currentUser, limit);

        const enrichedMessages = await Promise.all(messages.map(async (msg) => {
             if (!msg || !msg.senderId) return null; const sender = await firebaseService.getUserByUsername(msg.senderId).catch(e => null); let senderNameDisplay = msg.senderId; if(sender) { senderNameDisplay = sender.FullName || sender.Username; } let timeFormatted = '??:??'; if (msg.timestamp) { const date = new Date(msg.timestamp); if (!isNaN(date.getTime())) { timeFormatted = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); } } return { ...msg, senderName: senderNameDisplay, timestampFormatted: timeFormatted };
        }));
        const validEnrichedMessages = enrichedMessages.filter(Boolean);

        // --- ПОМЕТКА ЧАТА ПРОЧИТАННЫМ ---
        const readerId = (currentUser.role === 'Owner' || currentUser.role === 'Staff') ? currentUser.companyId : currentUser.username;
        const readTimestamp = Date.now();
        if (readerId) {
             const markSuccess = await firebaseService.resetUnreadCountAndTimestamp(chatId, readerId, readTimestamp);
             if (markSuccess) {
                 log.info(`[GET /chats/:chatId] Chat ${chatId} marked as read by ${readerId}`);
                 // Обновляем ОБЩИЙ СЧЕТЧИК СООБЩЕНИЙ для текущего юзера
                 const totalUnread = await firebaseService.calculateTotalUnreadChats(currentUser.username, currentUser.companyId, readerId);
                 const userRoom = `user:${currentUser.username}`;
                 io.to(userRoom).emit('total_unread_update', { totalUnreadCount: totalUnread, timestamp: Date.now() });
                 log.debug(`[GET /chats/:chatId] Sent total_unread_update to self (${userRoom}): ${totalUnread}`);
                 // Уведомляем ДРУГИХ участников о прочтении (для галочек)
                 const otherUsernamesToNotify = new Set();
                 for (const pId of otherParticipantIds) { if (participants[pId]) { const isCompany = !(pId.includes('@') || pId.length < 10); if (isCompany) { try { const company = await firebaseService.getCompanyById(pId); if (company) { if (company.ownerUsername) otherUsernamesToNotify.add(company.ownerUsername); if (company.staff) Object.keys(company.staff).forEach(uname => otherUsernamesToNotify.add(uname)); } } catch(e){} } else { otherUsernamesToNotify.add(pId); } } }
                 const finalUsernames = Array.from(otherUsernamesToNotify).filter(Boolean);
                 finalUsernames.forEach(username => { if (username !== currentUser.username) { const targetRoom = `user:${username}`; io.to(targetRoom).emit('messages_read_up_to', { chatId: chatId, readerId: readerId, readUpToTimestamp: readTimestamp }); log.info(`[Socket.IO Mark Read] Emitted 'messages_read_up_to' to room ${targetRoom}`); } });
             } else { log.error(`[GET /chats/:chatId] Failed to mark chat ${chatId} as read for ${readerId}.`); }
        } else { log.warn(`[GET /chats/:chatId] Could not determine readerId for user ${currentUser.username}.`); }
        // --- КОНЕЦ ПОМЕТКИ О ПРОЧТЕНИИ ---

        // Определяем тему чата
        let chatSubjectDisplay = chatData.subject || 'Чат'; let subjectLink = null;
        if (chatData.propertyId) { const property = await firebaseService.getPropertyById(chatData.propertyId).catch(e => null); if (property) { chatSubjectDisplay = `Объект: ${property.Title}`; subjectLink = `/properties/${chatData.propertyId}`; } else if (chatData.propertyId) { chatSubjectDisplay = `Объект #${chatData.propertyId.substring(0,5)}...`; } } else if (chatData.bookingId) { chatSubjectDisplay = `Бронь #${chatData.bookingId.substring(0,6)}...`; }

        res.render('chat-view', {
            title: `Чат: ${otherParticipantName}`, chatId, chatSubject: chatSubjectDisplay, subjectLink,
            messages: validEnrichedMessages, otherParticipantName,
            propertyId: chatData.propertyId, bookingId: chatData.bookingId, currentUser
        });
    } catch (error) { log.error(`[GET /chats/:chatId] Error fetching chat details for ${chatId}:`, error); next(error); }
});


// API GET /api/chats/:chatId/details - Получить JSON с деталями чата и сообщениями
router.get('/api/chats/:chatId/details', isLoggedIn, isChatParticipant, async (req, res) => {
    const chatId = req.params.chatId;
    const currentUser = req.session.user;
    const chatData = req.chatData;
    const io = req.app.get('socketio');
    const limit = 50;
    log.info(`[API GET /chats/:chatId/details] User ${currentUser.username} requesting details for chat ${chatId}`);
    try {
        const participants = chatData.participants || {};
        const otherParticipantIds = Object.keys(participants).filter(pId => pId !== currentUser.username && pId !== currentUser.companyId);
        const otherParticipantId = otherParticipantIds.length > 0 ? otherParticipantIds[0] : null;
        let otherParticipantName = 'Неизвестный';
        // Определение имени собеседника
        if (otherParticipantId) { const isCompany = !(otherParticipantId.includes('@') || otherParticipantId.length < 10); if (isCompany) { const company = await firebaseService.getCompanyById(otherParticipantId).catch(e => null); otherParticipantName = company?.companyName || `Компания #${otherParticipantId.substring(0, 5)}...`; } else { const user = await firebaseService.getUserByUsername(otherParticipantId).catch(e => null); otherParticipantName = user?.FullName || user?.Username || `Пользователь ${otherParticipantId.substring(0, 5)}...`; } }
        log.debug(`[API GET /chats/:chatId/details] Other participant: ${otherParticipantName} (${otherParticipantId})`);

        const messages = await firebaseService.getChatMessages(chatId, currentUser, limit);
        const enrichedMessages = await Promise.all(messages.map(async msg => {
             if (!msg || !msg.senderId) return null; const sender = await firebaseService.getUserByUsername(msg.senderId).catch(e => null); let timeFormatted = '??:??'; if (msg.timestamp) { const d=new Date(msg.timestamp); if(!isNaN(d.getTime())) timeFormatted = d.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'}); } return { id: msg.id, chatId: msg.chatId, senderId: msg.senderId, text: msg.text, timestamp: msg.timestamp, isOwnMessage: msg.isOwnMessage, isReadByRecipient: msg.isReadByRecipient, senderName: sender?.FullName || sender?.Username || msg.senderId, timestampFormatted: timeFormatted };
        }));
        const validMessages = enrichedMessages.filter(Boolean);
        let chatSubjectDisplay = chatData.subject || 'Чат'; let subjectLink = null;
        // Определение темы
        if(chatData.propertyId) { const property = await firebaseService.getPropertyById(chatData.propertyId).catch(e=>null); if(property) { chatSubjectDisplay = `Объект: ${property.Title}`; subjectLink = `/properties/${chatData.propertyId}`; } else if (chatData.propertyId) { chatSubjectDisplay = `Объект #${chatData.propertyId.substring(0,5)}...`; } } else if (chatData.bookingId) { chatSubjectDisplay = `Бронь #${chatData.bookingId.substring(0,6)}...`; }

        // --- ПОМЕТКА ЧАТА ПРОЧИТАННЫМ ---
        const readerId = (currentUser.role === 'Owner' || currentUser.role === 'Staff') ? currentUser.companyId : currentUser.username;
        const readTimestamp = Date.now();
        if (readerId) {
             const markSuccess = await firebaseService.resetUnreadCountAndTimestamp(chatId, readerId, readTimestamp);
             if (markSuccess) {
                 log.info(`[API GET /chats/:chatId/details] Marked read for ${readerId}`);
                 // Обновляем ОБЩИЙ СЧЕТЧИК СООБЩЕНИЙ для текущего юзера
                 const totalUnread = await firebaseService.calculateTotalUnreadChats(currentUser.username, currentUser.companyId, readerId);
                 const userRoom = `user:${currentUser.username}`;
                 io.to(userRoom).emit('total_unread_update', { totalUnreadCount: totalUnread, timestamp: Date.now() });
                 log.debug(`[API GET /chats/:chatId/details] Sent total_unread_update to self (${userRoom}): ${totalUnread}`);
                 // Уведомляем ДРУГИХ участников о прочтении
                 const otherUsernamesToNotify = new Set();
                 for (const pId of otherParticipantIds) { if (participants[pId]) { const isCompany = !(pId.includes('@') || pId.length < 10); if (isCompany) { try { const company = await firebaseService.getCompanyById(pId); if (company) { if (company.ownerUsername) otherUsernamesToNotify.add(company.ownerUsername); if (company.staff) Object.keys(company.staff).forEach(uname => otherUsernamesToNotify.add(uname)); } } catch(e){} } else { otherUsernamesToNotify.add(pId); } } }
                 const finalUsernames = Array.from(otherUsernamesToNotify).filter(Boolean);
                 finalUsernames.forEach(username => { if (username !== currentUser.username) { const targetRoom = `user:${username}`; io.to(targetRoom).emit('messages_read_up_to', { chatId: chatId, readerId: readerId, readUpToTimestamp: readTimestamp }); log.info(`[Socket.IO API] Emitted 'messages_read_up_to' to room ${targetRoom}`); } });
             } else { log.error(`[API GET /chats/:chatId/details] Failed to mark chat ${chatId} as read for ${readerId}.`); }
        } else { log.warn(`[API GET /chats/:chatId/details] Could not determine readerId`); }
        // --- КОНЕЦ ПОМЕТКИ О ПРОЧТЕНИИ ---

        res.json({ success: true, chatId, otherParticipantName, chatSubject: chatSubjectDisplay, subjectLink, messages: validMessages, limit });
    } catch (error) { log.error(`[API GET /chats/:chatId/details] Error:`, error); res.status(500).json({ success: false, error: 'Ошибка загрузки данных чата.' }); }
});

// POST /chats/:chatId/messages - Отправить новое сообщение
router.post('/chats/:chatId/messages', isLoggedIn, isChatParticipant, async (req, res, next) => {
    const chatId = req.params.chatId;
    const currentUser = req.session.user;
    const chatData = req.chatData;
    const { text } = req.body;
    const io = req.app.get('socketio');
    log.info(`[POST /chats/:chatId/messages] User ${currentUser.username} sending to chat ${chatId}`);
    if (!text?.trim()) { return res.status(400).json({ success: false, error: 'Сообщение не может быть пустым.' }); }
    if (text.trim().length > 2000) { return res.status(400).json({ success: false, error: 'Сообщение слишком длинное (макс. 2000 символов).' }); }

    try {
        const senderId = currentUser.username;
        const senderRole = currentUser.role;
        const messageTimestamp = Date.now();
        const newMessageData = { chatId, senderId, senderRole, text: text.trim(), timestamp: messageTimestamp };
        const savedMessage = await firebaseService.createMessage(newMessageData);

        const participants = chatData.participants || {};
        const allParticipantIds = Object.keys(participants);
        const senderParticipantId = (senderRole === 'Owner' || senderRole === 'Staff') ? currentUser.companyId : senderId;
        const recipientsToIncrement = allParticipantIds.filter(pId => pId !== senderParticipantId && participants[pId]);

        log.debug(`[POST /chats/:chatId/messages] Sender ID: ${senderId}, Sender Participant ID: ${senderParticipantId}, Recipients to increment: ${recipientsToIncrement.join(', ')}`);

        await firebaseService.updateChatMetadata(chatId, {
             lastMessageText: savedMessage.text, lastMessageTimestamp: messageTimestamp,
             lastMessageSenderId: senderId, recipientsToIncrementUnread: recipientsToIncrement
        });
        const updateLinksPromises = allParticipantIds.map(pId => { if (!participants[pId]) return Promise.resolve(); const isCompany = !(pId.includes('@') || pId.length < 10); const refPath = isCompany ? `company_chats/${pId}/${chatId}` : `user_chats/${pId}/${chatId}`; return db.ref(refPath).set(messageTimestamp); });
        await Promise.all(updateLinksPromises);
        log.info(`[POST /chats/:chatId/messages] Updated chat link timestamps for ${allParticipantIds.length} participants.`);

        const senderInfo = { senderName: currentUser.fullName || senderId };
        const baseMessageForEmit = { id: savedMessage.id, chatId: savedMessage.chatId, senderId: savedMessage.senderId, senderRole: savedMessage.senderRole, text: savedMessage.text, timestamp: messageTimestamp, ...senderInfo, timestampFormatted: new Date(messageTimestamp).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' }) };

        const allUsernamesToNotify = new Set();
        for (const participantId of allParticipantIds) { if (!participants[participantId]) continue; const isCompany = !(participantId.includes('@') || participantId.length < 10); if (isCompany) { try { const company = await firebaseService.getCompanyById(participantId); if (company) { if (company.ownerUsername) allUsernamesToNotify.add(company.ownerUsername); if (company.staff) Object.keys(company.staff).forEach(uname => allUsernamesToNotify.add(uname)); } } catch (e) { log.error(`Error fetching company ${participantId} for socket emit:`, e); } } else { allUsernamesToNotify.add(participantId); } }
        log.debug(`[POST /chats/:chatId/messages] All usernames to notify:`, Array.from(allUsernamesToNotify));

        for (const targetUsername of allUsernamesToNotify) {
             if (!targetUsername) continue;
             const userRoom = `user:${targetUsername}`;
             const messageToSend = {
                 ...baseMessageForEmit,
                 isOwnMessage: targetUsername === senderId, // Определяем для каждого получателя
                 isReadByRecipient: false
             };
             io.to(userRoom).emit('new_message', { chatId: chatId, message: messageToSend });
             log.info(`[Socket.IO] Emitted 'new_message' to room ${userRoom} for chat ${chatId} (isOwn: ${messageToSend.isOwnMessage})`);

             // Пересчет и отправка счетчика СООБЩЕНИЙ
             try {
                  const targetUser = await firebaseService.getUserByUsername(targetUsername);
                  if (targetUser) {
                       const targetReaderId = (targetUser.Role === 'Owner' || targetUser.Role === 'Staff') ? targetUser.companyId : targetUsername;
                       const targetTotalUnread = await firebaseService.calculateTotalUnreadChats(targetUsername, targetUser.companyId, targetReaderId);
                       io.to(userRoom).emit('total_unread_update', { totalUnreadCount: targetTotalUnread, timestamp: Date.now() });
                       log.info(`[Socket.IO] Emitted 'total_unread_update' (${targetTotalUnread}) to room ${userRoom} after new message`);
                  } else { log.warn(`[Socket.IO] Target user ${targetUsername} not found for total unread update.`); }
             } catch(e) { log.error(`Failed to send total unread update to ${targetUsername}:`, e); }
         }
        res.status(201).json({ success: true, message: 'Сообщение отправлено.', sentMessage: { ...baseMessageForEmit, isOwnMessage: true } });
    } catch (error) { log.error(`[POST /chats/:chatId/messages] Error:`, error); next(error); }
});

// POST /chats - Создать новый чат (Tenant пишет компании)
router.post('/chats', isLoggedIn, async (req, res, next) => {
    const currentUser = req.session.user;
    if (!currentUser || currentUser.role !== 'Tenant') { return res.status(403).json({ success: false, error: 'Только арендаторы могут начать чат.' }); }
    const { recipientCompanyId, propertyId, bookingId, initialMessage } = req.body;
    const io = req.app.get('socketio');
    log.info(`[POST /chats] Tenant ${currentUser.username} initiating chat with company ${recipientCompanyId}. Property: ${propertyId}, Booking: ${bookingId}`);
    if (!recipientCompanyId) return res.status(400).json({ success: false, error: 'Не указан ID компании-получателя.' });
    if (!initialMessage?.trim()) return res.status(400).json({ success: false, error: 'Необходимо ввести текст сообщения.' });
    if (initialMessage.trim().length > 2000) return res.status(400).json({ success: false, error: 'Сообщение слишком длинное (макс. 2000 символов).' });

    try {
        const tenantId = currentUser.username; const companyId = recipientCompanyId;
        const company = await firebaseService.getCompanyById(companyId);
        if (!company) return res.status(404).json({ success: false, error: 'Компания не найдена.' });
        let chatId = await firebaseService.findExistingChat(tenantId, companyId, propertyId);
        const messageTimestamp = Date.now();
        if (!chatId) { log.info(`[POST /chats] Creating new chat...`); const participants = { [tenantId]: true, [companyId]: true }; let subject = `Чат с ${company.companyName || companyId}`; if (propertyId) { const property = await firebaseService.getPropertyById(propertyId).catch(e=>null); subject = property?.Title ? `Объект: ${property.Title}` : `Объект #${propertyId.substring(0,5)}...`; } const newChatData = { participants, propertyId: propertyId || null, bookingId: bookingId || null, createdAt: messageTimestamp, lastMessageText: initialMessage.trim(), lastMessageTimestamp: messageTimestamp, lastMessageSenderId: tenantId, unreadCounts: { [tenantId]: 0, [companyId]: 1 }, lastReadTimestamp: { [tenantId]: messageTimestamp, [companyId]: 0 }, subject }; chatId = await firebaseService.createChat(newChatData); await db.ref(`user_chats/${tenantId}/${chatId}`).set(messageTimestamp); await db.ref(`company_chats/${companyId}/${chatId}`).set(messageTimestamp); log.info(`[POST /chats] New chat ${chatId} created.`); }
        else { log.info(`[POST /chats] Found existing chat ${chatId}.`); }
        const newMessageData = { chatId, senderId: tenantId, senderRole: currentUser.role, text: initialMessage.trim(), timestamp: messageTimestamp };
        const savedMessage = await firebaseService.createMessage(newMessageData);
        if (chatId) { await firebaseService.updateChatMetadata(chatId, { lastMessageText: savedMessage.text, lastMessageTimestamp: messageTimestamp, lastMessageSenderId: tenantId, recipientsToIncrementUnread: [companyId] }); await db.ref(`user_chats/${tenantId}/${chatId}`).set(messageTimestamp); await db.ref(`company_chats/${companyId}/${chatId}`).set(messageTimestamp); }
        else { throw new Error("Failed to obtain chatId."); }

        // --- Отправка Socket.IO ---
        const senderInfo = { senderName: currentUser.fullName || tenantId }; const baseMessageForEmit = { id: savedMessage.id, chatId: savedMessage.chatId, senderId: savedMessage.senderId, senderRole: savedMessage.senderRole, text: savedMessage.text, timestamp: messageTimestamp, ...senderInfo, timestampFormatted: new Date(messageTimestamp).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' }) };
        const allUsernamesToNotify = new Set(); allUsernamesToNotify.add(tenantId); if (company.ownerUsername) allUsernamesToNotify.add(company.ownerUsername); if (company.staff) Object.keys(company.staff).forEach(uname => allUsernamesToNotify.add(uname)); log.debug(`[POST /chats] Usernames to notify for new chat ${chatId}:`, Array.from(allUsernamesToNotify));
        for (const targetUsername of allUsernamesToNotify) {
             if (!targetUsername) continue; const userRoom = `user:${targetUsername}`;
             const messageToSend = { ...baseMessageForEmit, isOwnMessage: targetUsername === tenantId }; // Определяем isOwnMessage
             io.to(userRoom).emit('new_message', { chatId, message: messageToSend });
             log.info(`[Socket.IO] Emitted 'new_message' to room ${userRoom} for chat ${chatId} (isOwn: ${messageToSend.isOwnMessage})`);
             // Пересчет и отправка счетчика СООБЩЕНИЙ
             try { const targetUser = await firebaseService.getUserByUsername(targetUsername); if (targetUser) { const targetReaderId = (targetUser.Role === 'Owner' || targetUser.Role === 'Staff') ? targetUser.companyId : targetUsername; const targetTotalUnread = await firebaseService.calculateTotalUnreadChats(targetUsername, targetUser.companyId, targetReaderId); io.to(userRoom).emit('total_unread_update', { totalUnreadCount: targetTotalUnread, timestamp: Date.now() }); log.info(`[Socket.IO] Emitted 'total_unread_update' (${targetTotalUnread}) to room ${userRoom} after new chat`); } } catch(e) { log.error(`Failed to send total unread update to ${targetUsername}:`, e); }
         }
        // --- Конец Socket.IO ---
        res.status(201).json({ success: true, message: 'Сообщение отправлено.', chatId: chatId });
    } catch (error) { log.error('[POST /chats] Error:', error); next(error); }
});

// GET /chats/:chatId/messages/history - Получить историю сообщений (AJAX)
router.get('/chats/:chatId/messages/history', isLoggedIn, isChatParticipant, async (req, res) => {
    const chatId = req.params.chatId;
    const currentUser = req.session.user;
    const limit = parseInt(req.query.limit) || 30;
    const beforeTimestamp = req.query.beforeTimestamp ? parseInt(req.query.beforeTimestamp) : null;
    log.info(`[GET /chats/:chatId/messages/history] User ${currentUser.username} loading older for chat ${chatId}, limit: ${limit}, before: ${beforeTimestamp}`);
    try {
        const messages = await firebaseService.getChatMessages(chatId, currentUser, limit, beforeTimestamp);
        const enrichedMessages = await Promise.all(messages.map(async (msg) => {
             if (!msg || !msg.senderId) return null; const sender = await firebaseService.getUserByUsername(msg.senderId).catch(e => null); let timeFormatted = '??:??'; if (msg.timestamp) { const d=new Date(msg.timestamp); if(!isNaN(d.getTime())) timeFormatted = d.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'}); } return { id: msg.id, chatId: msg.chatId, senderId: msg.senderId, text: msg.text, timestamp: msg.timestamp, isOwnMessage: msg.isOwnMessage, isReadByRecipient: msg.isReadByRecipient, senderName: sender?.FullName || sender?.Username || msg.senderId, timestampFormatted: timeFormatted };
        }));
        const validMessages = enrichedMessages.filter(Boolean);
        log.info(`[GET /chats/:chatId/messages/history] Returning ${validMessages.length} messages.`);
        const hasMore = validMessages.length === limit;
        res.json({ success: true, messages: validMessages, hasMore: hasMore });
    } catch (error) { log.error(`[GET /chats/:chatId/messages/history] Error fetching history for chat ${chatId}:`, error); res.status(500).json({ success: false, error: 'Ошибка загрузки истории сообщений.' }); }
});

// УДАЛЯЕМ локальный хелпер calculateTotalUnreadChats, т.к. он теперь в firebaseService

module.exports = router;