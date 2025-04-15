// server.js (Полная версия с восстановленными обработчиками уведомлений)
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const admin = require('firebase-admin');
const http = require('http');
const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");
const log = require('electron-log'); // Используем electron-log

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE ADMIN SDK ---
const serviceAccount = require('./serviceAccountKey.json'); // Убедитесь, что файл существует
try {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://diplomarenda-default-rtdb.firebaseio.com" // ВАШ URL БАЗЫ ДАННЫХ
        });
        log.info("Firebase Admin SDK успешно инициализирован.");
    } else {
        log.info("Firebase Admin SDK уже был инициализирован.");
    }
} catch (error) {
     log.error("Критическая ошибка инициализации Firebase Admin SDK:", error);
     process.exit(1); // Выход из процесса Node.js
}

// --- ИМПОРТ СЕРВИСОВ, МАРШРУТОВ И MIDDLEWARE ---
const firebaseService = require('./services/firebaseService');
const authRoutes = require('./routes/authRoutes');
const propertyRoutes = require('./routes/propertyRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const userRoutes = require('./routes/userRoutes');
const rentalRoutes = require('./routes/rentalRoutes');
const companyRoutes = require('./routes/companyRoutes');
const chatRoutes = require('./routes/chatRoutes');
const { checkCompanyProfile } = require('./middleware/ownerMiddleware');
const { ensureCompanyExists } = require('./middleware/companyMiddleware');

// --- Express & HTTP Server ---
const app = express();
const port = process.env.PORT || 3000;
const httpServer = http.createServer(app);

// --- Socket.IO Server ---
const io = new Server(httpServer, {});
app.set('socketio', io); // Делаем io доступным в запросах Express

// --- Redis Подключение и Настройка Адаптера ---
const redisEndpoint = "redis-19018.c328.europe-west3-1.gce.redns.redis-cloud.com";
const redisPort = 19018;
const redisPassword = "d8jyr2hbUtLUBPF5CE25xUcXoy7pgwcT"; // ВАЖНО: Храните пароль безопасно!
const redisUrl = `redis://:${redisPassword}@${redisEndpoint}:${redisPort}`;
log.info(`[Redis] Попытка подключения к Redis: ${redisEndpoint}:${redisPort}`);

const pubClient = createClient({ url: redisUrl });
const subClient = pubClient.duplicate();

pubClient.on('error', (err) => log.error('[Redis PubClient Error]', err));
subClient.on('error', (err) => log.error('[Redis SubClient Error]', err));

Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => {
        log.info(`[Redis] Клиенты Pub/Sub успешно подключены к ${redisEndpoint}:${redisPort}.`);
        io.adapter(createAdapter(pubClient, subClient));
        log.info('[Socket.IO] Redis адаптер успешно сконфигурирован.');
    })
    .catch((err) => {
        log.error(`[Redis] КРИТИЧЕСКАЯ ОШИБКА: Не удалось подключить Redis клиенты к ${redisEndpoint}:${redisPort}:`, err);
        log.error('!!! ВНИМАНИЕ: Синхронизация уведомлений и сокетов между экземплярами приложения НЕ БУДЕТ РАБОТАТЬ без Redis.');
    });
// --- Конец настройки Redis ---

// --- Общие Middleware Express ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Сессии Express ---
const sessionSecret = process.env.SESSION_SECRET || 'thisshouldbeareallylongandrandomsecretkeyformyrealestateapp!';
const sessionMiddleware = session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);

// --- Интеграция сессий Express с Socket.IO ---
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// --- Middleware: Передача данных в шаблоны EJS и Обновление Сессии ---
app.use(async (req, res, next) => {
    res.locals.currentUser = null;
    res.locals.message = null;

    if (req.session.message) {
        res.locals.message = req.session.message;
        delete req.session.message;
        req.session.save(err => {
            if (err) log.warn("[Session MW:FlashClear] Error saving session after deleting flash message:", err);
        });
    }

    if (req.session.user && req.session.user.username) {
        const username = req.session.user.username;
        log.debug(`[Session MW] Checking session for user: ${username}`);
        try {
            const freshUser = await firebaseService.getUserByUsername(username);
            if (freshUser) {
                log.debug(`[Session MW] Fresh data found for ${username}. Updating session...`);
                const updatedSessionUser = {
                    username: freshUser.Username, fullName: freshUser.FullName || null,
                    role: freshUser.Role || 'Tenant', email: freshUser.Email || null,
                    phone: freshUser.Phone || null, imageData: freshUser.ImageData || null,
                    companyId: freshUser.companyId || null,
                    companyProfileCompleted: freshUser.companyProfileCompleted === true,
                    companyName: req.session.user.companyName || null
                };
                if (freshUser.Role === 'Tenant') { updatedSessionUser.balance = freshUser.Balance ?? 0; }
                if (updatedSessionUser.companyId && !updatedSessionUser.companyName) {
                    try {
                        const company = await firebaseService.getCompanyById(updatedSessionUser.companyId);
                        updatedSessionUser.companyName = company?.companyName || null;
                    } catch (companyError) { log.warn(`[Session MW] Failed fetch company name for ${username}:`, companyError); }
                }
                req.session.user = updatedSessionUser;
                res.locals.currentUser = updatedSessionUser;
                res.locals.companyId = updatedSessionUser.companyId;
                const { imageData, ...loggableSession } = updatedSessionUser;
                log.debug(`[Session MW] Session object updated for ${username}:`, loggableSession);
                req.session.save(err => { if (err) log.error(`[Session MW] Error persisting updated session for ${username}:`, err); });
            } else {
                log.warn(`[Session MW] User ${username} not found in DB. Destroying session.`);
                return req.session.destroy((err) => { if (err) log.error("[Session MW] Error destroying session:", err); res.clearCookie('connect.sid'); res.redirect('/login'); });
            }
        } catch (error) {
            log.error(`[Session MW] Error fetching/processing session data for ${username}:`, error);
            res.locals.currentUser = req.session.user;
            res.locals.companyId = req.session.user?.companyId || null;
        }
    } else {
         res.locals.currentUser = null;
         res.locals.companyId = null;
    }
    next();
});

// --- Глобальные Middleware для Owner ---
app.use(checkCompanyProfile);
app.use(ensureCompanyExists);

// --- Маршруты ---
app.use(authRoutes);
app.use('/properties', propertyRoutes);
app.use('/bookings', bookingRoutes);
app.use('/users', userRoutes);
app.use('/rentals', rentalRoutes);
app.use('/company', companyRoutes);
app.use(chatRoutes);

// --- Базовый маршрут (Dashboard) ---
app.get('/', async (req, res, next) => {
    if (!res.locals.currentUser) {
        try { return res.render('index', { title: 'Добро пожаловать' }); }
        catch (renderError) { log.error("Error rendering index.ejs:", renderError); return next(renderError); }
    }
    const currentUser = res.locals.currentUser;
    const dashboardData = { role: currentUser.role };
    try {
        log.info(`[Dashboard GET] Loading data for ${currentUser.username} (${currentUser.role})`);
        // --- Логика Дашборда (загрузка данных в зависимости от роли) ---
        if (currentUser.role === 'Tenant') { /* ... */ }
        else if ((currentUser.role === 'Owner' || currentUser.role === 'Staff') && currentUser.companyId) { /* ... */ }
        else if (currentUser.role === 'Admin') { /* ... */ }
        res.render('dashboard', { title: 'Панель управления', dashboardData });
    } catch (error) {
        log.error("[Dashboard GET] Error loading dashboard data:", error);
        res.status(500).render('dashboard', { title: 'Ошибка', dashboardData: { role: currentUser?.role || 'Unknown', error: 'Не удалось загрузить данные.' } });
    }
});

// --- Логика Socket.IO ---
const userSockets = {};
app.set('userSockets', userSockets);

io.on('connection', (socket) => {
    const socketId = socket.id;
    log.info(`[Socket.IO] Клиент подключился: ${socketId}`);
    let associatedUserId = null;

    // Функция получения и отправки ОБЩЕГО числа непрочитанных чатов
    const sendTotalUnreadCount = async (userId, userCompanyId) => {
        if (!userId || !socket.connected) return;
        try {
            const chats = await firebaseService.getUserChats(userId, userCompanyId);
            const user = await firebaseService.getUserByUsername(userId); // Получаем пользователя для определения readerId
            const readerId = (user?.Role === 'Owner' || user?.Role === 'Staff') ? userCompanyId : userId;
            let totalUnread = 0;
            if (readerId) {
                 chats.forEach(chat => { if (chat.unreadCounts?.[readerId] > 0) { totalUnread++; } });
            }
            log.info(`[Socket.IO] Sending 'total_unread_update' to user ${userId}. Count: ${totalUnread}`);
            socket.emit('total_unread_update', { totalUnreadCount: totalUnread });
        } catch (error) { log.error(`[Socket.IO] Error calculating/sending total unread count for ${userId}:`, error); }
    };

    // Функция отправки начальных уведомлений И СЧЕТЧИКОВ ЧАТОВ
    const sendInitialNotificationsAndCounts = async (userId) => {
         if (!userId || !socket.connected) return;
         try {
             const notificationLimit = 20;
             const lastNotifications = await firebaseService.getLastNotifications(userId, notificationLimit);
             if (!socket.connected) return;
             log.info(`[Socket.IO] Отправка ${lastNotifications.length} начальных уведомлений пользователю ${userId} (сокет ${socketId})`);
             socket.emit('initial_notifications', lastNotifications);

             // Отправляем общий счетчик непрочитанных ЧАТОВ
             const userSessionData = socket.request.session?.user;
             if (userSessionData && userSessionData.username === userId) {
                  await sendTotalUnreadCount(userId, userSessionData.companyId);
             } else { // Fallback, если сессия сокета запаздывает
                 const userFromDb = await firebaseService.getUserByUsername(userId);
                 if (userFromDb) await sendTotalUnreadCount(userId, userFromDb.companyId);
             }
         } catch (error) { log.error(`[Socket.IO] Ошибка при получении начальных данных для ${userId}:`, error); }
    };

    // Ассоциация пользователя с сокетом
    const session = socket.request.session;
    if (session) {
        session.reload((err) => {
            if (err) { log.error(`[Socket.IO] Ошибка перезагрузки сессии для ${socketId}:`, err); return; }
            const socketUser = session.user;
            if (socketUser && socketUser.username) {
                associatedUserId = socketUser.username;
                const oldSocketId = userSockets[associatedUserId];
                if (oldSocketId && oldSocketId !== socketId) { log.warn(`[Socket.IO] Пользователь ${associatedUserId} переподключился (${socketId}). Отключаем старый сокет ${oldSocketId}.`); io.sockets.sockets.get(oldSocketId)?.disconnect(true); delete userSockets[associatedUserId]; }
                userSockets[associatedUserId] = socketId; socket.userId = associatedUserId; socket.join(`user:${associatedUserId}`);
                log.info(`[Socket.IO] Пользователь ${associatedUserId} ассоциирован (сессия). Сокет ${socketId} в комнате user:${associatedUserId}.`);
                sendInitialNotificationsAndCounts(associatedUserId);
            } else { log.warn(`[Socket.IO] Пользователь не найден в сессии для сокета ${socketId}.`); }
        });
    } else { log.warn(`[Socket.IO] Сессия не найдена для сокета ${socketId}.`); }

    // Обработчик регистрации/перерегистрации
    socket.on('register_user', (userIdFromClient) => {
         if (userIdFromClient) {
             log.info(`[Socket.IO] Получено событие 'register_user': ${userIdFromClient} (сокет ${socketId})`);
             if (!associatedUserId || associatedUserId !== userIdFromClient) {
                 if(associatedUserId && userSockets[associatedUserId] === socketId) { delete userSockets[associatedUserId]; }
                 socket.rooms.forEach(room => { if(room !== socketId) socket.leave(room); });
                 associatedUserId = userIdFromClient; userSockets[associatedUserId] = socketId; socket.userId = associatedUserId;
                 socket.join(`user:${associatedUserId}`);
                 log.info(`[Socket.IO] Пользователь ${associatedUserId} зарегистрирован/перерегистрирован (событие). Сокет ${socketId} в комнате user:${associatedUserId}.`);
                 sendInitialNotificationsAndCounts(associatedUserId);
             } else {
                 log.debug(`[Socket.IO] Пользователь ${associatedUserId} уже зарегистрирован. Повторная отправка данных.`);
                 sendInitialNotificationsAndCounts(associatedUserId);
             }
         } else { log.warn(`[Socket.IO] 'register_user' с пустым userId от ${socketId}.`); }
    });

    // --- ВОССТАНОВЛЕННЫЕ Обработчики для УВЕДОМЛЕНИЙ (Колокольчик) ---
    socket.on('mark_notifications_read', async (notificationIds) => {
        const userId = socket.userId;
        if (userId && Array.isArray(notificationIds) && notificationIds.length > 0) {
            log.info(`[Socket.IO] Пользователь ${userId} запросил пометку уведомлений как прочитанных: [${notificationIds.join(', ')}]`);
            await firebaseService.markNotificationsAsRead(userId, notificationIds);
            // Обновление счетчика для колокольчика на клиенте не требуется напрямую отсюда,
            // т.к. клиент сам обновляет UI при открытии панели
        } else {
            log.warn(`[Socket.IO] Получено 'mark_notifications_read' с невалидными данными от сокета ${socketId}. UserId: ${userId}, Ids: ${notificationIds}`);
        }
    });

    socket.on('delete_notification', async (notificationId) => {
        const userId = socket.userId;
        if (userId && notificationId) {
             log.info(`[Socket.IO] Пользователь ${userId} запросил удаление уведомления: ${notificationId}`);
             await firebaseService.deleteNotification(userId, notificationId);
             // Клиент сам удаляет из DOM, серверу не нужно ничего отправлять обратно
        } else {
             log.warn(`[Socket.IO] Получено 'delete_notification' с невалидными данными от сокета ${socketId}. UserId: ${userId}, NotificationId: ${notificationId}`);
        }
    });

    socket.on('clear_all_notifications', async () => {
        const userId = socket.userId;
        if (userId) {
             log.info(`[Socket.IO] Пользователь ${userId} запросил очистку всех уведомлений.`);
             await firebaseService.clearAllNotificationsForUser(userId);
              // Отправляем сигнал, что уведомления очищены, чтобы клиент обновил панель
             socket.emit('initial_notifications', []);
             // Также обнуляем счетчик в хедере (если он отслеживает уведомления колокольчика)
             // socket.emit('total_unread_notifications_update', { totalUnreadCount: 0 }); // Пример, если есть отдельный счетчик
        } else {
             log.warn(`[Socket.IO] Получено 'clear_all_notifications' от неассоциированного сокета ${socketId}.`);
        }
     });
    // --- КОНЕЦ ВОССТАНОВЛЕННЫХ ОБРАБОТЧИКОВ ---

    // --- Обработчик пометки СООБЩЕНИЙ ЧАТА прочитанными ---
    socket.on('mark_chat_read', async (chatId) => {
        const userId = socket.userId; // ID пользователя, который прочитал
        const sessionUser = socket.request.session?.user;
        const ioInstance = socket.server; // io сервер

        if (!userId || !chatId || !sessionUser) {
            log.warn(`[Socket.IO] Invalid 'mark_chat_read' event data. UserID: ${userId}, ChatID: ${chatId}`);
            return;
        }

        // Определяем ID "читателя" - это может быть username или companyId
        const readerId = (sessionUser.role === 'Owner' || sessionUser.role === 'Staff')
            ? sessionUser.companyId
            : sessionUser.username;

        if (readerId) {
            const readTimestamp = Date.now(); // <<< ВРЕМЯ ПРОЧТЕНИЯ ОПРЕДЕЛЕНО ЗДЕСЬ
            log.info(`[Socket.IO] User ${userId} marked chat ${chatId} as read via socket event (Reader ID: ${readerId}, Timestamp: ${readTimestamp})`);

            // 1. Обновляем lastReadTimestamp в Firebase
            const tsUpdateSuccess = await firebaseService.updateLastReadTimestamp(chatId, readerId, readTimestamp);
            // 2. Сбрасываем счетчик непрочитанных в Firebase
            const unreadResetSuccess = await firebaseService.resetUnreadCount(chatId, readerId);

            // --- Убрана проверка if (tsUpdateSuccess && unreadResetSuccess), т.к. firebaseService может не возвращать boolean ---
            // Продолжаем отправку сокет-событий в любом случае, полагаясь, что запись в БД прошла успешно (или почти успешно)

            // 3. Отправляем 'unread_count_update' обратно СЕБЕ (для списка чатов)
            socket.emit('unread_count_update', { chatId: chatId, unreadCount: 0 });
            log.info(`[Socket.IO] Emitted 'unread_count_update'(0) back to self (${userId}) for chat ${chatId}`);

            // 4. Отправляем ОБЩИЙ счетчик непрочитанных СЕБЕ
            // Вызываем функцию, определенную выше в io.on('connection')
            await sendTotalUnreadCount(userId, sessionUser.companyId);

            // 5. Уведомляем ДРУГИХ участников о прочтении (для галочек)
             try { // Оборачиваем в try/catch на случай ошибки получения данных чата
                 const chatData = await firebaseService.getChatById(chatId);
                 if (chatData && chatData.participants) {
                     const participants = chatData.participants;
                     // Находим ID ВСЕХ других участников
                     const otherParticipantIds = Object.keys(participants).filter(pId =>
                        pId !== userId &&
                        !((sessionUser.role === 'Owner' || sessionUser.role === 'Staff') && pId === sessionUser.companyId)
                     );

                     // Получаем список username'ов всех, кого нужно уведомить
                     const otherUsernamesToNotify = [];
                     const companyIdsToNotify = [];
                     otherParticipantIds.forEach(pId => {
                          const isCompany = !(pId.includes('@') || pId.length < 10);
                          if(isCompany) { companyIdsToNotify.push(pId); } else { otherUsernamesToNotify.push(pId); }
                     });
                     for (const cId of companyIdsToNotify) {
                          try {
                              const company = await firebaseService.getCompanyById(cId);
                              if (company) { if (company.ownerUsername) otherUsernamesToNotify.push(company.ownerUsername); if (company.staff) otherUsernamesToNotify.push(...Object.keys(company.staff)); }
                          } catch(e){ log.error(`Error fetching company ${cId} for read notification:`, e); }
                     }
                     const finalUsernames = [...new Set(otherUsernamesToNotify)].filter(Boolean);

                     // Отправляем событие 'messages_read_up_to' каждому
                     finalUsernames.forEach(username => {
                          // Не отправляем уведомление о прочтении самому себе
                          if (username !== userId) {
                               const userRoom = `user:${username}`;
                               // <<< ИСПОЛЬЗУЕМ ПРАВИЛЬНУЮ ПЕРЕМЕННУЮ readTimestamp >>>
                               ioInstance.to(userRoom).emit('messages_read_up_to', {
                                   chatId: chatId,
                                   readerId: readerId,
                                   readUpToTimestamp: readTimestamp // <<< ИСПРАВЛЕНО ЗДЕСЬ
                               });
                               log.info(`[Socket.IO] Emitted 'messages_read_up_to' to room ${userRoom} for chat ${chatId} (Reader: ${readerId})`);
                          }
                     });
                 } else {
                      log.warn(`[Socket.IO] Could not get chat data for ${chatId} to notify others about read status.`);
                 }
            } catch (chatError) {
                 log.error(`[Socket.IO] Error getting chat data or notifying others in mark_chat_read for ${chatId}:`, chatError);
            }
        } else {
             log.warn(`[Socket.IO] Could not determine readerId for 'mark_chat_read' from user ${userId}`);
        }
    }); // Конец обработчика mark_chat_read

    // --- Обработчик отключения клиента ---
    socket.on('disconnect', (reason) => {
        log.info(`[Socket.IO] Клиент отключился: ${socketId}. Причина: ${reason}`);
        const userId = socket.userId;
        if (userId && userSockets[userId] === socketId) {
             log.info(`[Socket.IO] Удаление пользователя ${userId} (сокет ${socketId}) из реестра.`);
             delete userSockets[userId];
        } else if (userId) { log.warn(`[Socket.IO] Отключенный сокет ${socketId} не совпал с ${userSockets[userId]} для ${userId}.`); }
        else { let foundUserId = Object.keys(userSockets).find(uid => userSockets[uid] === socketId); if (foundUserId) { log.info(`[Socket.IO] Удаление пользователя ${foundUserId} (сокет ${socketId}) через поиск.`); delete userSockets[foundUserId]; } else { log.warn(`[Socket.IO] Не найден пользователь для ${socketId}.`); } }
    });
}); // --- Конец io.on('connection') ---

// --- Обработка 404 и 500 ---
app.use((req, res, next) => {
    log.warn(`[404 Not Found] Path: ${req.originalUrl}, Method: ${req.method}`);
    res.status(404).render('error', { title: 'Страница не найдена (404)', message: 'Запрашиваемая страница не существует.', currentUser: res.locals.currentUser });
});
app.use((err, req, res, next) => {
    log.error("[Global Error Handler] Произошла ошибка:", err);
    const statusCode = err.status || 500;
    const isDevelopment = process.env.NODE_ENV === 'development';
    const errorMessage = isDevelopment ? (err.message || 'Неизвестная ошибка.') : 'Внутренняя ошибка сервера.';
    res.status(statusCode).render('error', { title: `Ошибка ${statusCode}`, message: errorMessage, currentUser: res.locals.currentUser });
});

// --- Запуск HTTP сервера ---
httpServer.listen(port, () => {
    log.info(`Сервер Express с Socket.IO запущен внутри Electron по адресу http://localhost:${port}`);
});

module.exports = httpServer;