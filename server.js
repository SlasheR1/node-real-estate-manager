// server.js
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const admin = require('firebase-admin');
const http = require('http');
const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");
const log = require('electron-log');

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE ADMIN SDK ---
const serviceAccount = require('./serviceAccountKey.json');
try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://diplomarenda-default-rtdb.firebaseio.com" // ВАШ URL
    });
    console.log("Firebase Admin SDK успешно инициализирован.");
} catch (error) {
     console.error("Ошибка инициализации Firebase Admin SDK:", error);
     process.exit(1);
}

// --- ИМПОРТ СЕРВИСОВ, МАРШРУТОВ И MIDDLEWARE ---
// УБЕДИТЕСЬ, ЧТО ЭТА СТРОКА ТОЛЬКО ОДНА В ФАЙЛЕ!
const firebaseService = require('./services/firebaseService');
// ----------------------------------------------
const authRoutes = require('./routes/authRoutes');
const propertyRoutes = require('./routes/propertyRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const userRoutes = require('./routes/userRoutes');
const rentalRoutes = require('./routes/rentalRoutes');
const companyRoutes = require('./routes/companyRoutes');
const { checkCompanyProfile } = require('./middleware/ownerMiddleware');
const { ensureCompanyExists } = require('./middleware/companyMiddleware');

// --- Express & HTTP Server ---
const app = express();
const port = process.env.PORT || 3000;
const httpServer = http.createServer(app);

// --- Socket.IO Server ---
const io = new Server(httpServer, {});
app.set('socketio', io);

// --- Redis Подключение и Настройка Адаптера ---
const redisEndpoint = "redis-19018.c328.europe-west3-1.gce.redns.redis-cloud.com";
const redisPort = 19018;
const redisPassword = "d8jyr2hbUtLUBPF5CE25xUcXoy7pgwcT"; // Ваш пароль Redis
const redisUrl = `redis://:${redisPassword}@${redisEndpoint}:${redisPort}`;
console.log(`[Redis] Attempting to connect to endpoint: ${redisEndpoint}:${redisPort}`);

const pubClient = createClient({ url: redisUrl });
const subClient = pubClient.duplicate();

pubClient.on('error', (err) => console.error('[Redis PubClient Error]', err));
subClient.on('error', (err) => console.error('[Redis SubClient Error]', err));

Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => {
        console.log(`[Redis] Pub/Sub clients connected successfully to ${redisEndpoint}:${redisPort}.`);
        io.adapter(createAdapter(pubClient, subClient));
        console.log('[Socket.IO] Redis adapter configured.');
    })
    .catch((err) => {
        console.error(`[Redis] CRITICAL: Failed to connect clients to ${redisEndpoint}:${redisPort}:`, err);
        console.error('!!! ВНИМАНИЕ: Синхронизация уведомлений между экземплярами приложения НЕ БУДЕТ РАБОТАТЬ без Redis.');
    });
// --- Конец настройки Redis ---

// --- Общие Middleware Express ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Сессии Express ---
const sessionMiddleware = session({
    secret: 'thisshouldbeareallylongandrandomsecretkey!',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);

// --- Интеграция сессий Express с Socket.IO ---
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// --- Передача данных в шаблоны EJS (С ОБНОВЛЕНИЕМ СЕССИИ) ---
// server.js - ИЗМЕНЕННЫЙ Middleware обновления сессии

app.use(async (req, res, next) => {
    // ---> 1. Инициализация res.locals и обработка flash-сообщений (без изменений)
    res.locals.currentUser = null; // Начинаем с null
    let messageFromSession = req.session.message || null;
    if (messageFromSession) {
        delete req.session.message;
        // Не будем ждать сохранения flash, т.к. это не критично для основного потока
        req.session.save(err => {
            if (err) log.warn("[Middleware:FlashClear] Error saving session after deleting flash message:", err);
        });
    }
    res.locals.message = messageFromSession; // Передаем flash в шаблон

    // ---> 2. Проверяем, есть ли пользователь в сессии
    if (req.session.user && req.session.user.username) {
        const username = req.session.user.username;
        let freshUser = null; // Объявим заранее

        try {
            // ---> 3. Загружаем АКТУАЛЬНЫЕ данные из Firebase
            log.debug(`[Session MW] Fetching fresh data for user: ${username}`); // Используем debug для менее важных логов
            freshUser = await firebaseService.getUserByUsername(username);

            if (freshUser) {
                log.debug(`[Session MW] Fresh data FOUND for ${username}. Updating session...`);

                // ---> 4. Формируем ОБНОВЛЕННЫЙ объект для сессии (С ЯВНЫМИ ПРОВЕРКАМИ)
                const updatedSessionUser = {
                    username: freshUser.Username, // Убедитесь, что Username есть всегда
                    fullName: freshUser.FullName || null, // Предусмотреть null, если поля нет
                    role: freshUser.Role || 'Tenant', // Роль по умолчанию, если вдруг нет
                    // Явно проверяем и копируем email и phone
                    email: freshUser.Email || null, // <-- Явная проверка и null по умолчанию
                    phone: freshUser.Phone || null, // <-- Явная проверка и null по умолчанию
                    imageData: freshUser.ImageData || null,
                    companyId: freshUser.companyId || null,
                    companyProfileCompleted: freshUser.companyProfileCompleted === true,
                    // Имя компании: берем из старой сессии как базу, обновим ниже если нужно/возможно
                    companyName: req.session.user.companyName || null
                };

                // ---> 5. Добавляем баланс ТОЛЬКО для Tenant
                if (freshUser.Role === 'Tenant') {
                    // Используем ?? (nullish coalescing) для дефолтного 0, если Balance null или undefined
                    updatedSessionUser.balance = freshUser.Balance ?? 0;
                    log.debug(`[Session MW] Tenant role confirmed for ${username}. Balance set to: ${updatedSessionUser.balance}`);
                } else {
                     // Убедимся, что у других ролей нет поля balance в сессии
                     // (хотя spread operator (...) и так бы его не добавил, если его нет в freshUser)
                     // delete updatedSessionUser.balance; // Эта строка необязательна, если balance не копируется для других ролей
                     log.debug(`[Session MW] Role is ${freshUser.Role} for ${username}. Balance field not applicable.`);
                }


                // ---> 6. Загружаем имя компании, если ID есть И (имени еще нет в сессии ИЛИ оно изменилось в БД - опционально)
                // Для простоты, будем перезагружать имя компании только если его нет в сессии
                if (updatedSessionUser.companyId && !updatedSessionUser.companyName) {
                    try {
                        log.debug(`[Session MW] Fetching company name for companyId: ${updatedSessionUser.companyId}`);
                        const company = await firebaseService.getCompanyById(updatedSessionUser.companyId);
                        updatedSessionUser.companyName = company?.companyName || null; // Используем ?. и ??
                        log.debug(`[Session MW] Company name set to: ${updatedSessionUser.companyName}`);
                    } catch (companyError) {
                        log.warn(`[Session MW] Failed fetch company name for ${username}:`, companyError);
                        // Оставляем companyName как null в случае ошибки
                        updatedSessionUser.companyName = null;
                    }
                }

                // ---> 7. Обновляем сессию и res.locals СРАЗУ
                // Теперь в req.session.user будут актуальные данные (включая email, phone, balance)
                req.session.user = updatedSessionUser;
                // И эти же актуальные данные передаем в шаблон через res.locals
                res.locals.currentUser = updatedSessionUser;
                res.locals.companyId = updatedSessionUser.companyId; // Обновляем companyId в locals

                // Логируем объект, который будет в сессии и в шаблоне
                log.debug(`[Session MW] Session object for ${username} updated:`, {
                    username: updatedSessionUser.username,
                    fullName: updatedSessionUser.fullName,
                    role: updatedSessionUser.role,
                    email: updatedSessionUser.email, // Логируем для проверки
                    phone: updatedSessionUser.phone, // Логируем для проверки
                    balance: updatedSessionUser.balance, // Логируем для проверки (будет undefined если не Tenant)
                    companyId: updatedSessionUser.companyId,
                    companyName: updatedSessionUser.companyName,
                    companyProfileCompleted: updatedSessionUser.companyProfileCompleted
                    // imageData не логируем, т.к. слишком длинное
                });

                // ---> 8. Асинхронно сохраняем сессию в хранилище (НЕ БЛОКИРУЕМ ЗАПРОС)
                // Это важно для производительности, т.к. нам не нужно ждать завершения записи в хранилище
                // для продолжения обработки запроса. Данные в req.session и res.locals уже обновлены.
                req.session.save(err => {
                    if (err) log.error(`[Session MW] Error persisting updated session for ${username}:`, err);
                    // else log.debug(`[Session MW] Session persisted successfully for ${username}.`); // Можно включить для отладки
                });

            } else {
                // ---> 9. Пользователь не найден в БД - уничтожаем сессию
                log.warn(`[Session MW] User ${username} not found in DB. Destroying session.`);
                // Важно: используем return, чтобы остановить выполнение этого middleware и сразу сделать редирект
                return req.session.destroy((err) => {
                    if (err) log.error("[Session MW] Error destroying session:", err);
                    res.clearCookie('connect.sid');
                    res.redirect('/login');
                });
            }
        } catch (error) {
            // ---> 10. Ошибка при получении данных из Firebase
            log.error(`[Session MW] Error fetching/processing data for ${username}:`, error);
            // В случае ошибки, передаем старые данные из сессии в locals, чтобы не сломать рендеринг полностью.
            // Это компромисс: пользователь увидит страницу со старыми данными, но без критической ошибки.
            res.locals.currentUser = req.session.user; // Передаем то, что было в сессии до ошибки
            res.locals.companyId = req.session.user?.companyId || null;
            // Оставляем next() чтобы запрос пошел дальше, но с потенциально старыми данными в locals
            // Можно раскомментировать `return next(error);` если хотите видеть страницу ошибки 500
            // return next(error);
        }
    } else {
        // Если пользователя нет в сессии изначально, просто устанавливаем null в locals
         res.locals.currentUser = null;
         res.locals.companyId = null;
    }

    // ---> 11. Переходим к следующему middleware или маршруту
    next();
});

// --- Middleware для отладки сессии (опционально) ---
app.use((req, res, next) => {
  const userId = req.session?.user?.username || req.session?.tempUser?.username || 'Guest';
  const companyIdLog = req.session?.user?.companyId ? ` (Comp: ${req.session.user.companyId})` : '';
  const sessionIdPart = req.session?.id ? ` (Sess: ...${req.session.id.slice(-6)})` : '';
  // console.log(`[Session Check] Path: ${req.path}, User: ${userId}${companyIdLog}${sessionIdPart}`);
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

// --- Базовый маршрут (Dashboard) ---
app.get('/', async (req, res, next) => {
    if (!res.locals.currentUser) {
        try { return res.render('index', { title: 'Добро пожаловать' }); }
        catch (renderError) { console.error("Error rendering index.ejs:", renderError); return next(renderError); }
    }

    const currentUser = res.locals.currentUser;
    const dashboardData = { role: currentUser.role };

    try {
        console.log(`[Dashboard GET v5] Loading dashboard data for ${currentUser.username} (Role: ${currentUser.role})`);
        // --- Логика Дашборда ---
        if (currentUser.role === 'Tenant') {
             const tenantBookings = await firebaseService.getBookingsByUserId(currentUser.username);
             const validBookings = Array.isArray(tenantBookings) ? tenantBookings : [];
             dashboardData.activeBookingsCount = validBookings.filter(b => b?.Status === 'Активна').length;
             dashboardData.balance = currentUser.balance ?? 0;
             const recentActive = validBookings.filter(b => b?.Status === 'Активна').sort((a, b) => new Date(b.CreatedAt || 0) - new Date(a.CreatedAt || 0)).slice(0, 3);
             if(recentActive.length > 0) {
                 const propIds = [...new Set(recentActive.map(b => b.PropertyId).filter(Boolean))];
                 if (propIds.length > 0) {
                    const props = await Promise.all(propIds.map(id => firebaseService.getPropertyById(id).catch(e => null)));
                    const propsMap = new Map(props.filter(Boolean).map(p => [p.Id, p.Title]));
                    recentActive.forEach(b => { b.PropertyTitle = b.PropertyId ? (propsMap.get(b.PropertyId) || 'Объект?') : '?'; b.StartDateFormatted = b.StartDate ? new Date(b.StartDate).toLocaleDateString('ru-RU') : '?'; b.EndDateFormatted = b.EndDate ? new Date(b.EndDate).toLocaleDateString('ru-RU') : '?'; });
                 }
             }
             dashboardData.recentActiveBookings = recentActive;
        } else if ((currentUser.role === 'Owner' || currentUser.role === 'Staff') && currentUser.companyId) {
            const companyId = currentUser.companyId;
            const [companyResult, propertiesResult, allBookingsResult, allUsersResult] = await Promise.allSettled([
                 firebaseService.getCompanyById(companyId),
                 firebaseService.getPropertiesByCompanyId(companyId),
                 firebaseService.getAllBookings(),
                 firebaseService.getAllUsers()
             ]);
             const company = companyResult.status === 'fulfilled' ? companyResult.value : null;
             const properties = propertiesResult.status === 'fulfilled' ? propertiesResult.value : [];
             const allBookings = allBookingsResult.status === 'fulfilled' ? allBookingsResult.value : [];
             const allUsers = allUsersResult.status === 'fulfilled' ? allUsersResult.value : [];
             dashboardData.companyName = company?.companyName || '?';
             dashboardData.companyBalance = company?.Balance ?? 0;
             const validProperties = Array.isArray(properties) ? properties : [];
             dashboardData.totalProperties = validProperties.length;
             dashboardData.availableProperties = validProperties.filter(p => p?.IsAvailable).length;
             const companyPropertyIds = validProperties.map(p => p.Id);
             const validBookings = Array.isArray(allBookings) ? allBookings : [];
             const companyBookings = validBookings.filter(b => b?.PropertyId && companyPropertyIds.includes(b.PropertyId));
             dashboardData.activeRentalsCount = companyBookings.filter(b => b?.Status === 'Активна').length;
             dashboardData.totalRentalsCount = companyBookings.length;
             const recentBookings = companyBookings.sort((a, b) => new Date(b.CreatedAt || 0) - new Date(a.CreatedAt || 0)).slice(0, 3);
             if (recentBookings.length > 0 && Array.isArray(allUsers)) {
                 const propsMap = new Map(validProperties.map(p => [p.Id, p.Title]));
                 const usersMap = new Map(allUsers.filter(u=>u?.Username).map(u => [u.Username, u.FullName || u.Username]));
                 recentBookings.forEach(b => { b.PropertyTitle = b.PropertyId ? (propsMap.get(b.PropertyId) || '?') : '?'; b.TenantName = b.UserId ? (usersMap.get(b.UserId) || b.UserId) : '?'; b.StartDateFormatted = b.StartDate?new Date(b.StartDate).toLocaleDateString('ru-RU'):'?'; });
             }
             dashboardData.recentBookings = recentBookings;
        } else if (currentUser.role === 'Admin') {
             const [users, properties, bookings] = await Promise.allSettled([
                 firebaseService.getAllUsers(),
                 firebaseService.getAllProperties(),
                 firebaseService.getAllBookings()
             ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));
             dashboardData.totalUsers = Array.isArray(users) ? users.length : 0;
             dashboardData.totalProperties = Array.isArray(properties) ? properties.length : 0;
             dashboardData.totalBookings = Array.isArray(bookings) ? bookings.length : 0;
             dashboardData.activeBookings = Array.isArray(bookings) ? bookings.filter(b => b?.Status === 'Активна').length : 0;
        }
        res.render('dashboard', { title: 'Панель управления', dashboardData });
    } catch (error) {
        console.error("[Dashboard GET v5] Error loading dashboard data:", error);
        res.status(500).render('dashboard', { title: 'Ошибка', dashboardData: { role: currentUser?.role || 'Unknown', error: 'Не удалось загрузить данные панели управления.' } });
    }
});

// --- Логика Socket.IO (с комнатами и локальной картой) ---
const userSockets = {};
app.set('userSockets', userSockets);

io.on('connection', (socket) => {
    const socketId = socket.id;
    log.info(`[Socket.IO] Client connected: ${socketId}`);
    let associatedUserId = null;

    // --- ИЗМЕНЕНО: Функция отправки начальных уведомлений ---
    // Отправляет последние N, НЕ помечает как прочитанные
    const sendInitialNotifications = async (userId) => {
         if (!userId) return;
         try {
             const notificationLimit = 20; // Сколько последних уведомлений загружать
             const lastNotifications = await firebaseService.getLastNotifications(userId, notificationLimit);

             if (lastNotifications.length > 0) {
                  log.info(`[Socket.IO] Found ${lastNotifications.length} last notifications for user ${userId}. Sending 'initial_notifications'...`);
                  socket.emit('initial_notifications', lastNotifications); // Отправляем клиенту с их статусом read
                  // !!! НЕ ПОМЕЧАЕМ ПРОЧИТАННЫМИ ЗДЕСЬ !!!
             } else {
                  log.info(`[Socket.IO] No notifications found for user ${userId}.`);
                  socket.emit('initial_notifications', []); // Отправляем пустой массив
             }
         } catch (error) {
             log.error(`[Socket.IO] Error fetching initial notifications for user ${userId}:`, error);
         }
    };
    // 
    // --- КОНЕЦ ИЗМЕНЕНИЯ sendPendingNotifications ---

    // Пытаемся получить пользователя из сессии
    const session = socket.request.session;
    if (session) {
        session.reload((err) => {
            if (err) { log.error(`[Socket.IO] Error reloading session for ${socketId}:`, err); return; }
            const socketUser = session.user;
            if (socketUser && socketUser.username) {
                associatedUserId = socketUser.username;
                userSockets[associatedUserId] = socketId;
                socket.userId = associatedUserId;
                socket.join(`user:${associatedUserId}`);
                log.info(`[Socket.IO] User ${associatedUserId} associated (session). Socket ${socketId} joined room.`);
                sendInitialNotifications(associatedUserId); // Отправляем начальные
            } else { log.warn(`[Socket.IO] No user in session for socket ${socketId}.`); }
        });
    } else { log.warn(`[Socket.IO] No session found for socket ${socketId}.`); }

    // Регистрация по событию
    socket.on('register_user', (userIdFromClient) => {
         if (userIdFromClient && (!associatedUserId || associatedUserId !== userIdFromClient)) {
             log.info(`[Socket.IO] Registering/Re-registering user ${userIdFromClient} (event) with socket ${socketId}`);
             if(associatedUserId && userSockets[associatedUserId] === socketId) { delete userSockets[associatedUserId]; }
             associatedUserId = userIdFromClient; userSockets[associatedUserId] = socketId; socket.userId = associatedUserId;
             socket.rooms.forEach(room => { if(room !== socketId) socket.leave(room); }); socket.join(`user:${associatedUserId}`);
             sendInitialNotifications(associatedUserId); // Отправляем начальные
         } else if (userIdFromClient && associatedUserId && userIdFromClient === associatedUserId) {
             sendInitialNotifications(associatedUserId); // Повторно на всякий случай
         }
    });

    // Обработка пометки прочитанными от клиента
    socket.on('mark_notifications_read', async (notificationIds) => {
        const userId = socket.userId || associatedUserId;
        if (userId && Array.isArray(notificationIds) && notificationIds.length > 0) {
            log.info(`[Socket.IO] User ${userId} requested marking notifications as read:`, notificationIds);
            await firebaseService.markNotificationsAsRead(userId, notificationIds); // Помечаем в БД
        } else { log.warn(`[Socket.IO] Received 'mark_notifications_read' with invalid data.`); }
    });

    // Обработка delete_notification
    socket.on('delete_notification', async (notificationId) => {
        const userId = socket.userId || associatedUserId;
        if (userId && notificationId) { await firebaseService.deleteNotification(userId, notificationId); }
        else { log.warn(`[Socket.IO] Invalid 'delete_notification' received.`); }
    });

    // Обработка clear_all_notifications
    socket.on('clear_all_notifications', async () => {
        const userId = socket.userId || associatedUserId;
        if (userId) { await firebaseService.clearAllNotificationsForUser(userId); }
        else { log.warn(`[Socket.IO] Invalid 'clear_all_notifications' received.`); }
     });


    socket.on('disconnect', (reason) => {
        log.info(`[Socket.IO] Client disconnected: ${socketId}. Reason: ${reason}`);
        const userId = socket.userId || associatedUserId; // Используем сохраненный ID
        if (userId && userSockets[userId] === socketId) {
             log.info(`[Socket.IO] Removing user ${userId} (socket ${socketId}) from local registry.`);
             delete userSockets[userId];
        } else if (userId) { log.info(`[Socket.IO] Disconnected socket ${socketId} didn't match stored ${userSockets[userId]} for user ${userId}. Not removing.`); }
        else {
            // Попытка найти по ID сокета, если userId не был установлен
            let foundUserId = Object.keys(userSockets).find(uid => userSockets[uid] === socketId);
            if (foundUserId) { log.info(`[Socket.IO] Removing user ${foundUserId} (socket ${socketId}) by socket ID lookup.`); delete userSockets[foundUserId]; }
            else { log.warn(`[Socket.IO] Could not find user for disconnected socket ${socketId} to remove.`); }
        }
    });
});

// --- Обработка 404 и 500 ---
app.use((req, res, next) => {
    console.warn(`[404 Not Found] Path: ${req.path}, Method: ${req.method}`);
    res.status(404).render('error', { title: 'Страница не найдена (404)', message: 'Запрашиваемая страница не существует.' });
});
app.use((err, req, res, next) => {
    console.error("[Global Error Handler] An error occurred:", err);
    const statusCode = err.status || 500;
    const isDevelopment = process.env.NODE_ENV === 'development';
    res.status(statusCode).render('error', {
        title: `Ошибка ${statusCode}`,
        message: isDevelopment ? (err.message || 'Неизвестная ошибка сервера') : 'На сервере произошла внутренняя ошибка.',
    });
});

// --- Запуск HTTP сервера ---
httpServer.listen(port, () => {
    console.log(`Сервер Express с Socket.IO запущен внутри Electron по адресу http://localhost:${port}`);
});

module.exports = httpServer;