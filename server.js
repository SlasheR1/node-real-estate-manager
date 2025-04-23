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
    res.locals.totalUnreadChatCount = 0; // Инициализируем нулем

    if (req.session.message) {
        res.locals.message = req.session.message;
        delete req.session.message;
        // Не ждем сохранения сессии здесь, чтобы не блокировать запрос
        req.session.save(err => {
            if (err) log.warn("[Session MW:FlashClear] Error saving session after deleting flash message:", err);
        });
    }

    if (req.session.user && req.session.user.username) {
        const username = req.session.user.username;
        log.debug(`[Session MW] Checking session for user: ${username}`);
        try {
            // Получаем свежие данные пользователя (как и раньше)
            const freshUser = await firebaseService.getUserByUsername(username);
            if (freshUser) {
                log.debug(`[Session MW] Fresh data found for ${username}. Updating session...`);
                const updatedSessionUser = {
                    username: freshUser.Username, fullName: freshUser.FullName || null,
                    role: freshUser.Role || 'Tenant', email: freshUser.Email || null,
                    phone: freshUser.Phone || null, imageData: freshUser.ImageData || null,
                    companyId: freshUser.companyId || null,
                    companyProfileCompleted: freshUser.companyProfileCompleted === true,
                    companyName: req.session.user.companyName || null // Берем из старой сессии, если в БД нет
                };
                if (freshUser.Role === 'Tenant') { updatedSessionUser.balance = freshUser.Balance ?? 0; }
                // Загружаем имя компании, если нужно (как и раньше)
                if (updatedSessionUser.companyId && !updatedSessionUser.companyName) {
                    try {
                        const company = await firebaseService.getCompanyById(updatedSessionUser.companyId);
                        updatedSessionUser.companyName = company?.companyName || null;
                    } catch (companyError) { log.warn(`[Session MW] Failed fetch company name for ${username}:`, companyError); }
                }

                // *** НОВОЕ: Получаем и считаем непрочитанные чаты ДЛЯ ШАПКИ ***
                try {
                     const readerId = (updatedSessionUser.role === 'Owner' || updatedSessionUser.role === 'Staff') ? updatedSessionUser.companyId : updatedSessionUser.username;
                     if (readerId) {
                          const userChats = await firebaseService.getUserChats(updatedSessionUser.username, updatedSessionUser.companyId);
                          let initialUnreadCount = 0;
                          userChats.forEach(chat => {
                               if (chat && chat.unreadCounts && chat.unreadCounts[readerId] && chat.unreadCounts[readerId] > 0) {
                                    initialUnreadCount++;
                               }
                          });
                          res.locals.totalUnreadChatCount = initialUnreadCount; // Устанавливаем в locals
                          log.debug(`[Session MW] Initial unread chat count for ${username}: ${initialUnreadCount}`);
                     } else {
                          log.warn(`[Session MW] Could not determine readerId for initial unread count for ${username}`);
                     }
                } catch (chatCountError) {
                     log.error(`[Session MW] Error getting initial chat count for ${username}:`, chatCountError);
                     res.locals.totalUnreadChatCount = 0; // В случае ошибки ставим 0
                }
                // *** КОНЕЦ НОВОГО БЛОКА ***

                // Обновляем сессию и locals
                req.session.user = updatedSessionUser;
                res.locals.currentUser = updatedSessionUser;
                // Не сохраняем сессию здесь синхронно, чтобы не замедлять рендеринг
                req.session.save(err => { if (err) log.error(`[Session MW] Error persisting updated session for ${username}:`, err); });

            } else { // Пользователь из сессии не найден в БД
                log.warn(`[Session MW] User ${username} not found in DB. Destroying session.`);
                return req.session.destroy((err) => { if (err) log.error("[Session MW] Error destroying session:", err); res.clearCookie('connect.sid'); res.redirect('/login'); });
            }
        } catch (error) { // Ошибка при получении данных из БД
            log.error(`[Session MW] Error fetching/processing session data for ${username}:`, error);
            // Используем старые данные из сессии, если они есть
            res.locals.currentUser = req.session.user;
            // res.locals.totalUnreadChatCount останется 0
        }
    } else { // Пользователя нет в сессии
         res.locals.currentUser = null;
         res.locals.totalUnreadChatCount = 0;
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

// --- Глобальные объекты для отслеживания состояния ---
const unreadMessages = new Map();

// Функция для отправки начальных уведомлений и счетчиков
async function sendInitialNotificationsAndCounts(socket, userId) {
    if (!socket || !userId) {
        console.warn('[Socket.IO] Cannot send initial data: missing socket or userId');
        return;
    }

    try {
        const user = await firebaseService.getUserByUsername(userId);
        if (!user) {
            console.warn(`[Socket.IO] User ${userId} not found for initial data`);
            return;
        }

        // Получаем чаты пользователя
        const userChats = await firebaseService.getUserChats(userId, user.companyId);
        if (!userChats) return;

        // Обновляем бейдж в хедере
        await updateHeaderBadge(userId);

        // Обновляем бейджи для каждого чата
        for (const chat of userChats) {
            await updateChatListBadge(userId, chat.id);
        }

        console.log(`[Socket.IO] Initial notifications and counts sent for user ${userId}`);
    } catch (error) {
        console.error('[Socket.IO] Error sending initial data:', error);
    }
}

// --- Логика Socket.IO ---
const userSockets = {};
const lastUnreadUpdates = {};

// Функция для подсчета непрочитанных сообщений
async function getUnreadCount(chatId, userId) {
    try {
        const chat = await firebaseService.getChatById(chatId);
        if (!chat || !chat.messages) {
            console.log(`[UnreadCount] No messages found for chat ${chatId}`);
            return 0;
        }

        const user = await firebaseService.getUserByUsername(userId);
        if (!user) {
            console.warn(`[UnreadCount] User ${userId} not found`);
            return 0;
        }

        // Определяем readerId на основе роли пользователя
        const readerId = (user.Role === 'Owner' || user.Role === 'Staff') ? 
            user.companyId : userId;

        // Получаем время последнего прочтения
        const lastRead = chat.participants?.[readerId]?.lastRead || 0;
        console.log(`[UnreadCount] Last read time for ${readerId} in chat ${chatId}: ${lastRead}`);

        // Считаем непрочитанные сообщения
        const unreadCount = chat.messages.filter(msg => {
            const isAfterLastRead = msg.timestamp > lastRead;
            const isFromOther = msg.senderCompanyId !== user.companyId;
            return isAfterLastRead && isFromOther;
        }).length;

        console.log(`[UnreadCount] Found ${unreadCount} unread messages for ${readerId} in chat ${chatId}`);
        return unreadCount;
    } catch (error) {
        console.error('[UnreadCount] Error calculating unread count:', error);
        return 0;
    }
}

// Функция для обновления времени последнего прочтения
async function markChatAsRead(chatId, userId) {
    try {
        const user = await firebaseService.getUserByUsername(userId);
        if (!user) {
            console.warn(`[MarkRead] User ${userId} not found`);
            return;
        }

        const readerId = (user.Role === 'Owner' || user.Role === 'Staff') ? 
            user.companyId : userId;

        const now = new Date().toISOString();
        await firebaseService.updateChat(chatId, {
            [`participants.${readerId}.lastRead`]: now
        });

        console.log(`[MarkRead] Updated last read time for ${readerId} in chat ${chatId} to ${now}`);
    } catch (error) {
        console.error('[MarkRead] Error marking chat as read:', error);
    }
}

io.on('connection', (socket) => {
    const socketId = socket.id;
    log.info(`[Socket.IO] Клиент подключился: ${socketId}`);
    let associatedUserId = null;
    let initialDataSent = false;

    // Ассоциация пользователя с сокетом
    const session = socket.request.session;
    if (session) {
        session.reload((err) => {
            if (err) { log.error(`[Socket.IO] Ошибка перезагрузки сессии для ${socketId}:`, err); return; }
            const socketUser = session.user;
            if (socketUser && socketUser.username) {
                associatedUserId = socketUser.username;
                const oldSocketId = userSockets[associatedUserId];
                if (oldSocketId && oldSocketId !== socketId) { 
                    log.warn(`[Socket.IO] Пользователь ${associatedUserId} переподключился (${socketId}). Отключаем старый сокет ${oldSocketId}.`); 
                    io.sockets.sockets.get(oldSocketId)?.disconnect(true); 
                    delete userSockets[associatedUserId]; 
                }
                userSockets[associatedUserId] = socketId; 
                socket.userId = associatedUserId; 
                socket.join(`user:${associatedUserId}`);
                log.info(`[Socket.IO] Пользователь ${associatedUserId} ассоциирован (сессия). Сокет ${socketId} в комнате user:${associatedUserId}.`);
                
                if (!initialDataSent) {
                    sendInitialNotificationsAndCounts(socket, associatedUserId);
                    initialDataSent = true;
                }
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
                associatedUserId = userIdFromClient; 
                userSockets[associatedUserId] = socketId; 
                socket.userId = associatedUserId;
                 socket.join(`user:${associatedUserId}`);
                 log.info(`[Socket.IO] Пользователь ${associatedUserId} зарегистрирован/перерегистрирован (событие). Сокет ${socketId} в комнате user:${associatedUserId}.`);
                
                if (!initialDataSent) {
                    sendInitialNotificationsAndCounts(socket, associatedUserId);
                    initialDataSent = true;
                }
             }
         } else { log.warn(`[Socket.IO] 'register_user' с пустым userId от ${socketId}.`); }
    });

    // Обновляем обработчик mark_chat_read
    socket.on('mark_chat_read', async (chatId) => {
        try {
            console.log(`[DEBUG] === Start mark_chat_read ===`);
            console.log(`[DEBUG] Parameters: chatId=${chatId}, userId=${socket.userId}`);

            const user = await firebaseService.getUserByUsername(socket.userId);
            if (!user) {
                console.warn(`[Socket.IO] User ${socket.userId} not found for mark_chat_read`);
                return;
            }
            console.log(`[DEBUG] User found:`, {
                username: user.username,
                role: user.Role,
                companyId: user.companyId
            });

            // Определяем readerId на основе роли пользователя
            const readerId = (user.Role === 'Owner' || user.Role === 'Staff') ? 
                user.companyId : user.username;
            console.log(`[DEBUG] Determined readerId: ${readerId}`);

            const chat = await firebaseService.getChatById(chatId);
            if (!chat) {
                console.warn(`[Socket.IO] Chat ${chatId} not found for mark_chat_read`);
                return;
            }
            console.log(`[DEBUG] Chat before update:`, {
                id: chat.id,
                unreadCounts: chat.unreadCounts,
                participants: chat.participants
            });

            // Обнуляем счетчик непрочитанных для этого readerId
            if (!chat.unreadCounts) {
                chat.unreadCounts = {};
            }
            
            const oldCount = chat.unreadCounts[readerId] || 0;
            chat.unreadCounts[readerId] = 0;
            
            console.log(`[DEBUG] Updating unread count:`, {
                readerId,
                oldCount,
                newCount: 0
            });

            // Сохраняем обновленные счетчики в Firebase
            await firebaseService.updateChat(chatId, { 
                unreadCounts: chat.unreadCounts,
                [`participants.${readerId}.lastRead`]: new Date().toISOString()
            });
            
            console.log(`[DEBUG] Chat after update:`, {
                id: chat.id,
                unreadCounts: chat.unreadCounts,
                participants: chat.participants
            });

            // Получаем все чаты пользователя для подсчета общего количества непрочитанных
            const userChats = await firebaseService.getUserChats(user.username, user.companyId);
            console.log(`[DEBUG] All user chats:`, userChats.map(c => ({
                id: c.id,
                unreadCounts: c.unreadCounts
            })));

            let totalUnread = 0;
            for (const userChat of userChats) {
                if (userChat.unreadCounts && userChat.unreadCounts[readerId]) {
                    totalUnread += userChat.unreadCounts[readerId];
                    console.log(`[DEBUG] Adding to total from chat ${userChat.id}:`, {
                        chatUnread: userChat.unreadCounts[readerId],
                        newTotal: totalUnread
                    });
                }
            }

            // Отправляем обновления клиенту
            socket.emit('chat_list_unread_update', {
                chatId: chatId,
                unreadCount: 0,
                timestamp: Date.now()
            });

            socket.emit('header_unread_update', {
                totalUnreadCount: totalUnread,
                timestamp: Date.now()
            });

            console.log(`[DEBUG] Sent socket updates:`, {
                chatId,
                unreadCount: 0,
                totalUnread,
                userId: socket.userId
            });

            console.log(`[DEBUG] === End mark_chat_read ===`);

        } catch (error) {
            console.error('[Socket.IO] Error in mark_chat_read:', error);
        }
    });

    // Обновляем обработчик new_message
    socket.on('new_message', async (data) => {
        if (!data || !data.chatId || !data.message) return;

        try {
            const chat = await firebaseService.getChatById(data.chatId);
            if (!chat) return;

            // Обновляем lastMessage в чате
            await firebaseService.updateChat(data.chatId, {
                lastMessage: {
                    timestamp: new Date().toISOString(),
                    senderId: data.message.senderId
                }
            });

            // Получаем всех участников чата
            const participants = Array.isArray(chat.participants) ? 
                chat.participants : Object.keys(chat.participants);

            // Обновляем бейджи для всех участников
            for (const participantId of participants) {
                if (participantId === data.message.senderId) continue;

                const unreadCount = await getUnreadCount(data.chatId, participantId);
                io.to(`user:${participantId}`).emit('chat_list_unread_update', {
                    chatId: data.chatId,
                    unreadCount,
                    timestamp: Date.now()
                });

                // Обновляем общий счетчик
                const user = await firebaseService.getUserByUsername(participantId);
                const userChats = await firebaseService.getUserChats(participantId, user?.companyId);
                
                let totalUnread = 0;
                for (const chat of userChats) {
                    totalUnread += await getUnreadCount(chat.id, participantId);
                }

                io.to(`user:${participantId}`).emit('header_unread_update', {
                    totalUnreadCount: totalUnread,
                    timestamp: Date.now()
                });
            }
        } catch (error) {
            console.error('[Socket.IO] Error in new_message:', error);
        }
    });

    // Обработчик initial_unread_counts при подключении
    socket.on('get_initial_unread_counts', async () => {
        const userId = socket.userId;
        if (!userId) return;

        try {
            const user = await firebaseService.getUserByUsername(userId);
            if (!user) return;

            const userChats = await firebaseService.getUserChats(userId, user.companyId);
            if (!userChats) return;

            // Обновляем бейдж в хедере
            await updateHeaderBadge(userId);

            // Обновляем бейджи для каждого чата
            for (const chat of userChats) {
                await updateChatListBadge(userId, chat.id);
            }
        } catch (error) {
            console.error('[Socket.IO] Error getting initial unread counts:', error);
        }
    });

    // Обработчик отключения
    socket.on('disconnect', (reason) => {
        log.info(`[Socket.IO] Клиент отключился: ${socketId}. Причина: ${reason}`);
        const userId = socket.userId;
        if (userId && userSockets[userId] === socketId) {
             log.info(`[Socket.IO] Удаление пользователя ${userId} (сокет ${socketId}) из реестра.`);
             delete userSockets[userId];
        } else if (userId) { log.warn(`[Socket.IO] Отключенный сокет ${socketId} не совпал с ${userSockets[userId]} для ${userId}.`); }
        else { let foundUserId = Object.keys(userSockets).find(uid => userSockets[uid] === socketId); if (foundUserId) { log.info(`[Socket.IO] Удаление пользователя ${foundUserId} (сокет ${socketId}) через поиск.`); delete userSockets[foundUserId]; } else { log.warn(`[Socket.IO] Не найден пользователь для ${socketId}.`); } }
    });
});

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

// Функция для получения актуального количества непрочитанных сообщений
async function getActualUnreadCount(userId, chatId = null) {
    try {
        const user = await firebaseService.getUserByUsername(userId);
        if (!user) {
            console.error('[UnreadCount] User not found:', userId);
            return 0;
        }

        const readerId = userId;
        const userChats = await firebaseService.getUserChats(userId, user.companyId);
        
        if (!userChats) return 0;

        if (chatId) {
            // Возвращаем количество непрочитанных для конкретного чата
            const chat = userChats.find(c => c.id === chatId);
            return (chat?.unreadCounts?.[readerId] || 0);
        } else {
            // Возвращаем общее количество непрочитанных
            return userChats.reduce((total, chat) => {
                return total + (chat.unreadCounts?.[readerId] || 0);
            }, 0);
        }
    } catch (error) {
        console.error('[UnreadCount] Error getting unread count:', error);
        return 0;
    }
}

// Функция для обновления и отправки счетчиков
async function updateAndEmitUnreadCounts(userId, chatId = null) {
    try {
        const socket = io.sockets.sockets.get(userSockets[userId]);
        if (!socket) return;

        // Получаем актуальные данные
        const totalUnread = await getActualUnreadCount(userId);
        const chatUnread = chatId ? await getActualUnreadCount(userId, chatId) : null;

        // Отправляем обновление общего счетчика
        socket.emit('total_unread_update', {
            totalUnreadCount: totalUnread,
            timestamp: Date.now()
        });

        // Если указан конкретный чат, отправляем и его обновление
        if (chatId !== null) {
            socket.emit('unread_count_update', {
                chatId,
                unreadCount: chatUnread
            });
        }

        console.log(`[UnreadCount] Updated counts for user ${userId}:`, {
            totalUnread,
            chatUnread: chatId ? chatUnread : 'not requested'
        });
    } catch (error) {
        console.error('[UnreadCount] Error updating counts:', error);
    }
}

async function handleIncomingMessage(socket, message) {
    try {
        if (!socket.userId || !message || !message.chatId) {
            console.error('Invalid message data:', { socketUserId: socket.userId, message });
            return;
        }

        console.log(`[${new Date().toISOString()}] Processing new message from user ${socket.userId} in chat ${message.chatId}`);
        
        const timestamp = Date.now();
        console.log(`Message timestamp: ${new Date(timestamp).toISOString()}`);

        const messageData = {
            text: message.text,
            senderId: socket.userId,
            timestamp: timestamp,
            chatId: message.chatId
        };

        // Get chat and validate
        const chat = await firebaseService.getChat(message.chatId);
        if (!chat) {
            console.error(`Chat ${message.chatId} not found`);
            return;
        }

        // Update chat metadata with last message info
        await firebaseService.updateChat(message.chatId, {
            lastMessage: messageData.text,
            lastMessageTimestamp: timestamp,
            lastMessageSenderId: socket.userId
        });

        // Save message
        const savedMessage = await firebaseService.createMessage(messageData);
        console.log(`Message saved with timestamp ${new Date(timestamp).toISOString()}`);

        // Get participants
        const participants = chat.participants ? Object.values(chat.participants).filter(p => p) : [];
        console.log(`Found ${participants.length} participants in chat`);

        // Get sender's info
        const sender = await firebaseService.getUserByUsername(socket.userId);
        console.log(`Message sender: ${sender.username}, role: ${sender.role}`);

        // Update unread counts for each participant
        for (const participant of participants) {
            // Skip if participant is the sender
            if (participant === socket.userId) {
                console.log(`Skipping sender ${participant}`);
                continue;
            }

            // Update badges for the participant
            await updateChatListBadge(participant, message.chatId);
            await updateHeaderBadge(participant);
            console.log(`Updated badges for participant ${participant}`);
        }

        // Broadcast message to all participants
        io.to(message.chatId).emit('new_message', {
            ...messageData,
            timestampFormatted: new Date(timestamp).toLocaleString('ru-RU', {
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            })
        });

        console.log('Message broadcast complete');

    } catch (error) {
        console.error('Error in handleIncomingMessage:', error);
    }
}

async function updateHeaderBadge(userId) {
    try {
        const user = await firebaseService.getUserByUsername(userId);
        if (!user) {
            log.warn(`[HeaderBadge] Пользователь не найден: ${userId}`);
            return 0;
        }

        // Получаем все чаты пользователя
        const chats = await firebaseService.getUserChats(userId, user.companyId);
        let totalUnread = 0;

        // Подсчитываем непрочитанные сообщения во всех чатах
        for (const chat of chats) {
            const lastReadTime = chat.lastRead?.[userId] || 0;
            const messages = await firebaseService.getChatMessages(chat.id, user, 100);
            
            const unreadCount = messages.filter(msg => 
                msg.timestamp > lastReadTime && 
                msg.senderId !== userId
            ).length;

            totalUnread += unreadCount;
        }

        // Отправляем обновление через сокет
        if (io && userSockets[userId]) {
            io.to(`user:${userId}`).emit('header_unread_update', {
                totalUnreadCount: totalUnread,
                timestamp: Date.now()
            });
            log.info(`[HeaderBadge] Отправлено обновление для ${userId}: total=${totalUnread}`);
        } else {
            log.debug(`[HeaderBadge] Сокет не найден для пользователя ${userId}`);
        }

        return totalUnread;
    } catch (error) {
        log.error('[HeaderBadge] Ошибка:', error);
        return 0;
    }
}

async function updateChatListBadge(userId, chatId) {
    try {
        const user = await firebaseService.getUserByUsername(userId);
        if (!user) {
            log.warn(`[ChatListBadge] Пользователь не найден: ${userId}`);
            return;
        }

        const chat = await firebaseService.getChatById(chatId);
        if (!chat) {
            log.warn(`[ChatListBadge] Чат не найден: ${chatId}`);
            return;
        }

        // Получаем время последнего прочтения
        const lastReadTime = chat.lastRead?.[userId] || 0;

        // Получаем сообщения и считаем непрочитанные
        const messages = await firebaseService.getChatMessages(chatId, user, 100);
        const unreadCount = messages.filter(msg => 
            msg.timestamp > lastReadTime && 
            msg.senderId !== userId
        ).length;

        // Отправляем обновление через сокет
        if (io && userSockets[userId]) {
            io.to(`user:${userId}`).emit('chat_list_unread_update', {
                chatId,
                unreadCount,
                timestamp: Date.now()
            });
            log.info(`[ChatListBadge] Обновлен счетчик для чата ${chatId}, пользователь ${userId}: ${unreadCount}`);
        } else {
            log.debug(`[ChatListBadge] Сокет не найден для пользователя ${userId}`);
        }
    } catch (error) {
        log.error('[ChatListBadge] Ошибка:', error);
    }
}

async function markChatRead(chatId, userId) {
    try {
        const user = await firebaseService.getUserByUsername(userId);
        if (!user) {
            log.warn(`[MarkRead] Пользователь не найден: ${userId}`);
            return;
        }

        const chat = await firebaseService.getChatById(chatId);
        if (!chat) {
            log.warn(`[MarkRead] Чат не найден: ${chatId}`);
            return;
        }

        // Обновляем время последнего прочтения
        const updates = {
            [`lastRead.${userId}`]: Date.now()
        };

        await firebaseService.updateChatAtomic(chatId, updates);

        // Отправляем обновления счетчиков
        await updateChatListBadge(userId, chatId);
        await updateHeaderBadge(userId);

        log.info(`[MarkRead] Чат ${chatId} помечен как прочитанный для ${userId}`);
    } catch (error) {
        log.error('[MarkRead] Ошибка:', error);
    }
}