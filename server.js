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
const log = require('electron-log'); // Используем electron-log

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE ADMIN SDK ---
const serviceAccount = require('./serviceAccountKey.json'); // Убедитесь, что файл существует
try {
    // Проверяем, не инициализировано ли уже приложение Firebase
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
     // В Electron лучше показать диалог и закрыть приложение
     // dialog.showErrorBox('Ошибка Firebase', 'Не удалось инициализировать Firebase. Приложение будет закрыто.');
     process.exit(1); // Выход из процесса Node.js
}

// --- ИМПОРТ СЕРВИСОВ, МАРШРУТОВ И MIDDLEWARE ---
const firebaseService = require('./services/firebaseService'); // Загружаем наш модуль для работы с Firebase
const authRoutes = require('./routes/authRoutes');
const propertyRoutes = require('./routes/propertyRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const userRoutes = require('./routes/userRoutes');
const rentalRoutes = require('./routes/rentalRoutes');
const companyRoutes = require('./routes/companyRoutes');
const chatRoutes = require('./routes/chatRoutes'); // <<-- Добавлен роутер чата
const { checkCompanyProfile } = require('./middleware/ownerMiddleware');
const { ensureCompanyExists } = require('./middleware/companyMiddleware');

// --- Express & HTTP Server ---
const app = express();
const port = process.env.PORT || 3000; // Порт для сервера
const httpServer = http.createServer(app); // Создаем HTTP сервер на базе Express

// --- Socket.IO Server ---
const io = new Server(httpServer, {
    // Опции Socket.IO, если нужны (например, CORS для внешних клиентов)
    // cors: { origin: "*", methods: ["GET", "POST"] }
});
app.set('socketio', io); // Делаем io доступным в запросах Express

// --- Redis Подключение и Настройка Адаптера ---
const redisEndpoint = "redis-19018.c328.europe-west3-1.gce.redns.redis-cloud.com";
const redisPort = 19018;
const redisPassword = "d8jyr2hbUtLUBPF5CE25xUcXoy7pgwcT"; // ВАЖНО: Храните пароль безопасно!
const redisUrl = `redis://:${redisPassword}@${redisEndpoint}:${redisPort}`;
log.info(`[Redis] Попытка подключения к Redis: ${redisEndpoint}:${redisPort}`);

const pubClient = createClient({ url: redisUrl });
const subClient = pubClient.duplicate();

// Обработчики ошибок Redis
pubClient.on('error', (err) => log.error('[Redis PubClient Error]', err));
subClient.on('error', (err) => log.error('[Redis SubClient Error]', err));

// Асинхронное подключение клиентов и настройка адаптера
Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => {
        log.info(`[Redis] Клиенты Pub/Sub успешно подключены к ${redisEndpoint}:${redisPort}.`);
        io.adapter(createAdapter(pubClient, subClient)); // Устанавливаем адаптер Redis
        log.info('[Socket.IO] Redis адаптер успешно сконфигурирован.');
    })
    .catch((err) => {
        log.error(`[Redis] КРИТИЧЕСКАЯ ОШИБКА: Не удалось подключить Redis клиенты к ${redisEndpoint}:${redisPort}:`, err);
        log.error('!!! ВНИМАНИЕ: Синхронизация уведомлений и сокетов между экземплярами приложения НЕ БУДЕТ РАБОТАТЬ без Redis.');
        // Приложение может продолжить работу, но без масштабирования через Redis
    });
// --- Конец настройки Redis ---

// --- Общие Middleware Express ---
app.set('view engine', 'ejs'); // Устанавливаем EJS как шаблонизатор
app.set('views', path.join(__dirname, 'views')); // Указываем папку для шаблонов
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' })); // Увеличиваем лимит для Base64 изображений
app.use(bodyParser.json({ limit: '10mb' })); // Увеличиваем лимит для JSON (на всякий случай)
app.use(express.static(path.join(__dirname, 'public'))); // Папка для статических файлов (CSS, JS, изображения)

// --- Сессии Express ---
// Секретный ключ лучше вынести в переменные окружения
const sessionSecret = process.env.SESSION_SECRET || 'thisshouldbeareallylongandrandomsecretkeyformyrealestateapp!';
const sessionMiddleware = session({
    secret: sessionSecret,
    resave: false, // Не пересохранять сессию, если не было изменений
    saveUninitialized: false, // Не сохранять пустые сессии
    cookie: {
        secure: false, // В Electron можно оставить false, т.к. localhost. Для HTTPS true.
        httpOnly: true, // Доступ к куки только по HTTP, не через JS
        maxAge: 24 * 60 * 60 * 1000 // Срок жизни куки - 1 день
    }
    // TODO: Рассмотреть использование connect-redis для хранения сессий в Redis
    // store: new RedisStore({ client: redisClientForSession }) // Пример
});
app.use(sessionMiddleware);

// --- Интеграция сессий Express с Socket.IO ---
// Позволяет получить доступ к данным сессии Express внутри обработчиков Socket.IO
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// --- Middleware: Передача данных в шаблоны EJS и Обновление Сессии ---
app.use(async (req, res, next) => {
    res.locals.currentUser = null; // Инициализация
    res.locals.message = null; // Инициализация Flash-сообщения

    // 1. Обработка Flash-сообщений
    if (req.session.message) {
        res.locals.message = req.session.message;
        delete req.session.message;
        // Сохраняем сессию асинхронно после удаления сообщения
        req.session.save(err => {
            if (err) log.warn("[Session MW:FlashClear] Error saving session after deleting flash message:", err);
        });
    }

    // 2. Проверка и обновление данных пользователя в сессии
    if (req.session.user && req.session.user.username) {
        const username = req.session.user.username;
        log.debug(`[Session MW] Checking session for user: ${username}`);

        try {
            // 3. Загружаем актуальные данные из Firebase
            const freshUser = await firebaseService.getUserByUsername(username);

            if (freshUser) {
                log.debug(`[Session MW] Fresh data found for ${username}. Updating session...`);

                // 4. Формируем обновленный объект сессии
                const updatedSessionUser = {
                    username: freshUser.Username, // Гарантированно есть
                    fullName: freshUser.FullName || null,
                    role: freshUser.Role || 'Tenant', // Роль по умолчанию
                    email: freshUser.Email || null,
                    phone: freshUser.Phone || null,
                    imageData: freshUser.ImageData || null,
                    companyId: freshUser.companyId || null,
                    companyProfileCompleted: freshUser.companyProfileCompleted === true,
                    // Сохраняем имя компании из старой сессии, если новое не загружено
                    companyName: req.session.user.companyName || null
                };

                // 5. Добавляем баланс только для Tenant
                if (freshUser.Role === 'Tenant') {
                    updatedSessionUser.balance = freshUser.Balance ?? 0;
                }

                // 6. Обновляем имя компании, если нужно
                if (updatedSessionUser.companyId && !updatedSessionUser.companyName) {
                    try {
                        const company = await firebaseService.getCompanyById(updatedSessionUser.companyId);
                        updatedSessionUser.companyName = company?.companyName || null;
                        log.debug(`[Session MW] Company name updated for ${username}: ${updatedSessionUser.companyName}`);
                    } catch (companyError) {
                        log.warn(`[Session MW] Failed to fetch company name for ${username}:`, companyError);
                        updatedSessionUser.companyName = null;
                    }
                }

                // 7. Обновляем сессию и res.locals
                req.session.user = updatedSessionUser;
                res.locals.currentUser = updatedSessionUser;
                // Также передаем companyId отдельно для удобства в некоторых шаблонах
                res.locals.companyId = updatedSessionUser.companyId;

                // Логируем обновленные данные сессии (кроме imageData)
                const { imageData, ...loggableSession } = updatedSessionUser;
                log.debug(`[Session MW] Session object updated for ${username}:`, loggableSession);


                // 8. Асинхронно сохраняем обновленную сессию
                req.session.save(err => {
                    if (err) log.error(`[Session MW] Error persisting updated session for ${username}:`, err);
                });

            } else {
                // 9. Пользователь не найден в БД - уничтожаем сессию
                log.warn(`[Session MW] User ${username} not found in DB. Destroying session.`);
                return req.session.destroy((err) => { // Используем return для прерывания middleware
                    if (err) log.error("[Session MW] Error destroying session:", err);
                    res.clearCookie('connect.sid'); // Очищаем куку сессии
                    res.redirect('/login'); // Перенаправляем на вход
                });
            }
        } catch (error) {
            // 10. Ошибка при получении данных из Firebase
            log.error(`[Session MW] Error fetching/processing session data for ${username}:`, error);
            // Используем старые данные сессии для рендеринга, чтобы избежать полной ошибки
            res.locals.currentUser = req.session.user;
            res.locals.companyId = req.session.user?.companyId || null;
            // Ошибка будет обработана глобальным обработчиком, если не вызвать next(error)
        }
    } else {
        // Если пользователя нет в сессии изначально
        res.locals.currentUser = null;
        res.locals.companyId = null;
    }

    // 11. Переходим дальше
    next();
});

// --- Middleware для отладки сессии (опционально) ---
// app.use((req, res, next) => {
//   const userId = req.session?.user?.username || req.session?.tempUser?.username || 'Guest';
//   const companyIdLog = req.session?.user?.companyId ? ` (Comp: ${req.session.user.companyId})` : '';
//   const sessionIdPart = req.session?.id ? ` (Sess: ...${req.session.id.slice(-6)})` : '';
//   log.debug(`[Session Check] Path: ${req.path}, User: ${userId}${companyIdLog}${sessionIdPart}`);
//   next();
// });

// --- Глобальные Middleware для Owner ---
// Выполняются ПОСЛЕ обновления сессии
app.use(checkCompanyProfile); // Проверяет, заполнил ли Owner профиль компании
app.use(ensureCompanyExists); // Убеждается, что для Owner'а есть запись компании в БД

// --- Маршруты ---
app.use(authRoutes); // Маршруты аутентификации (/login, /register, /profile, ...)
app.use('/properties', propertyRoutes); // Маршруты объектов (/properties, /properties/add, ...)
app.use('/bookings', bookingRoutes); // Маршруты бронирований (/bookings, /bookings/new, ...)
app.use('/users', userRoutes); // Маршруты управления пользователями (/users, /users/add, ...)
app.use('/rentals', rentalRoutes); // Маршруты управления арендами (/rentals, /rentals/:id/confirm, ...)
app.use('/company', companyRoutes); // Маршруты управления компанией (/company/setup, /company/manage, ...)
app.use(chatRoutes); // Маршруты чата (/chats, /chats/:id, ...) - Убедитесь, что он ПОСЛЕДНИЙ из основных

// --- Базовый маршрут (Dashboard или Приветствие) ---
app.get('/', async (req, res, next) => {
    // Используем данные из res.locals, обновленные middleware
    if (!res.locals.currentUser) {
        // Если пользователь не аутентифицирован, показываем главную страницу
        try {
            return res.render('index', { title: 'Добро пожаловать' });
        } catch (renderError) {
            log.error("Error rendering index.ejs for unauthenticated user:", renderError);
            return next(renderError); // Передаем ошибку рендеринга дальше
        }
    }

    // Если пользователь аутентифицирован, показываем дашборд
    const currentUser = res.locals.currentUser;
    const dashboardData = { role: currentUser.role }; // Начинаем с роли

    try {
        log.info(`[Dashboard GET] Loading dashboard data for ${currentUser.username} (Role: ${currentUser.role})`);

        // --- Загрузка данных для дашборда в зависимости от роли ---
        if (currentUser.role === 'Tenant') {
             // Загрузка данных для Арендатора
             const [bookingsResult] = await Promise.allSettled([
                 firebaseService.getBookingsByUserId(currentUser.username)
             ]);
             const tenantBookings = bookingsResult.status === 'fulfilled' ? (Array.isArray(bookingsResult.value) ? bookingsResult.value : []) : [];

             dashboardData.activeBookingsCount = tenantBookings.filter(b => b?.Status === 'Активна').length;
             dashboardData.balance = currentUser.balance ?? 0; // Берем из обновленной сессии

             // Получаем последние 3 активных бронирования для отображения
             const recentActive = tenantBookings
                .filter(b => b?.Status === 'Активна')
                .sort((a, b) => (b.CreatedAt || 0) - (a.CreatedAt || 0)) // Сортировка по времени создания (новые сверху)
                .slice(0, 3);

             // Обогащаем информацией об объектах
             if (recentActive.length > 0) {
                 const propIds = [...new Set(recentActive.map(b => b.PropertyId).filter(Boolean))];
                 if (propIds.length > 0) {
                     const props = await Promise.all(propIds.map(id => firebaseService.getPropertyById(id).catch(e => null)));
                     const propsMap = new Map(props.filter(Boolean).map(p => [p.Id, p.Title]));
                     recentActive.forEach(b => {
                         b.PropertyTitle = b.PropertyId ? (propsMap.get(b.PropertyId) || 'Объект удален?') : '?';
                         b.StartDateFormatted = b.StartDate ? new Date(b.StartDate).toLocaleDateString('ru-RU') : '?';
                         b.EndDateFormatted = b.EndDate ? new Date(b.EndDate).toLocaleDateString('ru-RU') : '?';
                     });
                 }
             }
             dashboardData.recentActiveBookings = recentActive;

        } else if ((currentUser.role === 'Owner' || currentUser.role === 'Staff') && currentUser.companyId) {
            // Загрузка данных для Владельца/Персонала
            const companyId = currentUser.companyId;
            const [companyResult, propertiesResult, allBookingsResult, allUsersResult] = await Promise.allSettled([
                 firebaseService.getCompanyById(companyId),
                 firebaseService.getPropertiesByCompanyId(companyId),
                 firebaseService.getAllBookings(), // Загружаем все, фильтруем ниже
                 firebaseService.getAllUsers()     // Нужны для имен арендаторов
             ]);

             const company = companyResult.status === 'fulfilled' ? companyResult.value : null;
             const properties = propertiesResult.status === 'fulfilled' ? (Array.isArray(propertiesResult.value) ? propertiesResult.value : []) : [];
             const allBookings = allBookingsResult.status === 'fulfilled' ? (Array.isArray(allBookingsResult.value) ? allBookingsResult.value : []) : [];
             const allUsers = allUsersResult.status === 'fulfilled' ? (Array.isArray(allUsersResult.value) ? allUsersResult.value : []) : [];

             dashboardData.companyName = company?.companyName || 'Название не указано';
             dashboardData.companyBalance = company?.Balance ?? 0;
             dashboardData.totalProperties = properties.length;
             dashboardData.availableProperties = properties.filter(p => p?.IsAvailable).length;

             const companyPropertyIds = properties.map(p => p.Id);
             const companyBookings = allBookings.filter(b => b?.PropertyId && companyPropertyIds.includes(b.PropertyId));
             dashboardData.activeRentalsCount = companyBookings.filter(b => b?.Status === 'Активна').length;
             dashboardData.totalRentalsCount = companyBookings.length;

             // Получаем последние 3 бронирования для этой компании
             const recentBookings = companyBookings
                 .sort((a, b) => (b.CreatedAt || 0) - (a.CreatedAt || 0))
                 .slice(0, 3);

             // Обогащаем информацией об объектах и арендаторах
             if (recentBookings.length > 0) {
                 const propsMap = new Map(properties.map(p => [p.Id, p.Title]));
                 const usersMap = new Map(allUsers.map(u => [u.Username, u.FullName || u.Username]));
                 recentBookings.forEach(b => {
                     b.PropertyTitle = b.PropertyId ? (propsMap.get(b.PropertyId) || 'Объект удален?') : '?';
                     b.TenantName = b.UserId ? (usersMap.get(b.UserId) || b.UserId) : 'Неизвестный'; // Используем ID, если имя не найдено
                     b.StartDateFormatted = b.StartDate ? new Date(b.StartDate).toLocaleDateString('ru-RU') : '?';
                     b.EndDateFormatted = b.EndDate ? new Date(b.EndDate).toLocaleDateString('ru-RU') : '?';
                 });
             }
             dashboardData.recentBookings = recentBookings;

        } else if (currentUser.role === 'Admin') {
            // Загрузка данных для Администратора
             const [usersResult, propertiesResult, bookingsResult] = await Promise.allSettled([
                 firebaseService.getAllUsers(),
                 firebaseService.getAllProperties(),
                 firebaseService.getAllBookings()
             ]);
             const users = usersResult.status === 'fulfilled' ? (Array.isArray(usersResult.value) ? usersResult.value : []) : [];
             const properties = propertiesResult.status === 'fulfilled' ? (Array.isArray(propertiesResult.value) ? propertiesResult.value : []) : [];
             const bookings = bookingsResult.status === 'fulfilled' ? (Array.isArray(bookingsResult.value) ? bookingsResult.value : []) : [];

             dashboardData.totalUsers = users.length;
             dashboardData.totalProperties = properties.length;
             dashboardData.totalBookings = bookings.length;
             dashboardData.activeBookings = bookings.filter(b => b?.Status === 'Активна').length;
        }

        // Рендерим дашборд с полученными данными
        res.render('dashboard', { title: 'Панель управления', dashboardData });

    } catch (error) {
        log.error("[Dashboard GET] Error loading dashboard data:", error);
        // Отображаем страницу дашборда с сообщением об ошибке
        res.status(500).render('dashboard', {
            title: 'Ошибка',
            dashboardData: {
                role: currentUser?.role || 'Unknown',
                error: 'Не удалось загрузить данные панели управления. Попробуйте позже.'
            }
        });
    }
});

// --- Логика Socket.IO ---
const userSockets = {}; // Хранилище для связи userId -> socketId
app.set('userSockets', userSockets); // Делаем доступным в запросах

io.on('connection', (socket) => {
    const socketId = socket.id;
    log.info(`[Socket.IO] Клиент подключился: ${socketId}`);
    let associatedUserId = null; // ID пользователя, связанный с этим сокетом

    // Функция отправки начальных уведомлений пользователю
    const sendInitialNotifications = async (userId) => {
         if (!userId) return;
         try {
             const notificationLimit = 20; // Лимит последних уведомлений
             const lastNotifications = await firebaseService.getLastNotifications(userId, notificationLimit);
             if (!socket.connected) return; // Проверка, что сокет все еще подключен
             if (lastNotifications.length > 0) {
                  log.info(`[Socket.IO] Отправка ${lastNotifications.length} начальных уведомлений пользователю ${userId} (сокет ${socketId})`);
                  socket.emit('initial_notifications', lastNotifications);
             } else {
                  log.info(`[Socket.IO] Нет уведомлений для пользователя ${userId}`);
                  socket.emit('initial_notifications', []); // Отправляем пустой массив
             }
         } catch (error) {
             log.error(`[Socket.IO] Ошибка при получении начальных уведомлений для ${userId}:`, error);
         }
    };

    // Получение пользователя из сессии при подключении
    const session = socket.request.session;
    if (session) {
        session.reload((err) => { // Перезагружаем сессию для актуальности
            if (err) { log.error(`[Socket.IO] Ошибка перезагрузки сессии для ${socketId}:`, err); return; }
            const socketUser = session.user;
            if (socketUser && socketUser.username) {
                associatedUserId = socketUser.username;
                userSockets[associatedUserId] = socketId; // Сохраняем связь
                socket.userId = associatedUserId; // Сохраняем userId в объекте сокета
                socket.join(`user:${associatedUserId}`); // Присоединяем к персональной комнате
                log.info(`[Socket.IO] Пользователь ${associatedUserId} ассоциирован (сессия). Сокет ${socketId} добавлен в комнату user:${associatedUserId}.`);
                sendInitialNotifications(associatedUserId); // Отправляем уведомления
            } else { log.warn(`[Socket.IO] Пользователь не найден в сессии для сокета ${socketId}.`); }
        });
    } else { log.warn(`[Socket.IO] Сессия не найдена для сокета ${socketId}.`); }

    // Обработчик регистрации пользователя по событию от клиента
    socket.on('register_user', (userIdFromClient) => {
         if (userIdFromClient) {
             log.info(`[Socket.IO] Получено событие 'register_user' от клиента: ${userIdFromClient} (сокет ${socketId})`);
             // Если пользователь еще не ассоциирован или ID изменился
             if (!associatedUserId || associatedUserId !== userIdFromClient) {
                 // Удаляем старую запись, если была
                 if(associatedUserId && userSockets[associatedUserId] === socketId) { delete userSockets[associatedUserId]; }
                 // Покидаем все комнаты, кроме своей
                 socket.rooms.forEach(room => { if(room !== socketId) socket.leave(room); });
                 // Устанавливаем новые данные
                 associatedUserId = userIdFromClient;
                 userSockets[associatedUserId] = socketId;
                 socket.userId = associatedUserId;
                 socket.join(`user:${associatedUserId}`); // Присоединяем к новой комнате
                 log.info(`[Socket.IO] Пользователь ${associatedUserId} зарегистрирован/перерегистрирован (событие). Сокет ${socketId} добавлен в комнату user:${associatedUserId}.`);
                 sendInitialNotifications(associatedUserId); // Отправляем уведомления
             } else {
                 // Если ID совпадает, просто повторно отправляем уведомления
                 log.debug(`[Socket.IO] Пользователь ${associatedUserId} уже зарегистрирован. Повторная отправка уведомлений.`);
                 sendInitialNotifications(associatedUserId);
             }
         } else {
             log.warn(`[Socket.IO] Получено событие 'register_user' с пустым userId от сокета ${socketId}.`);
         }
    });

    // Обработчик пометки уведомлений прочитанными
    socket.on('mark_notifications_read', async (notificationIds) => {
        const userId = socket.userId; // Берем ID из объекта сокета
        if (userId && Array.isArray(notificationIds) && notificationIds.length > 0) {
            log.info(`[Socket.IO] Пользователь ${userId} запросил пометку уведомлений как прочитанных: [${notificationIds.join(', ')}]`);
            await firebaseService.markNotificationsAsRead(userId, notificationIds);
        } else { log.warn(`[Socket.IO] Получено 'mark_notifications_read' с невалидными данными от сокета ${socketId}.`); }
    });

     // Обработчик пометки сообщений чата прочитанными
     socket.on('mark_messages_read', async (chatId) => {
        const userId = socket.userId;
        const sessionUser = socket.request.session?.user;

        if (!userId || !chatId || !sessionUser) {
            log.warn(`[Socket.IO] Invalid 'mark_messages_read' event. UserID: ${userId}, ChatID: ${chatId}`);
            return;
        }

        const readerId = (sessionUser.role === 'Owner' || sessionUser.role === 'Staff')
            ? sessionUser.companyId
            : sessionUser.username;

        if (readerId) {
            log.info(`[Socket.IO] User ${userId} marked chat ${chatId} as read (Reader ID: ${readerId})`);
            // Сбрасываем счетчик в Firebase
            const success = await firebaseService.resetUnreadCount(chatId, readerId);
            if (success) {
                 // Отправляем обновление счетчика обратно этому же клиенту, чтобы обновить UI списка чатов
                 socket.emit('unread_count_update', { chatId: chatId, unreadCount: 0 });
                 log.info(`[Socket.IO] Emitted 'unread_count_update' (0) back to user ${userId} for chat ${chatId}`);
                 // TODO: Обновить общий счетчик в хедере (потребует доп. логики расчета)
            }
        } else {
             log.warn(`[Socket.IO] Could not determine readerId for 'mark_messages_read' from user ${userId}`);
        }
    });

    // Обработчик удаления уведомления
    socket.on('delete_notification', async (notificationId) => {
        const userId = socket.userId;
        if (userId && notificationId) {
             log.info(`[Socket.IO] Пользователь ${userId} запросил удаление уведомления: ${notificationId}`);
             await firebaseService.deleteNotification(userId, notificationId);
        } else { log.warn(`[Socket.IO] Получено 'delete_notification' с невалидными данными от сокета ${socketId}.`); }
    });

    // Обработчик очистки всех уведомлений
    socket.on('clear_all_notifications', async () => {
        const userId = socket.userId;
        if (userId) {
             log.info(`[Socket.IO] Пользователь ${userId} запросил очистку всех уведомлений.`);
             await firebaseService.clearAllNotificationsForUser(userId);
              socket.emit('initial_notifications', []); // Отправляем пустой массив после очистки
        } else { log.warn(`[Socket.IO] Получено 'clear_all_notifications' от неассоциированного сокета ${socketId}.`); }
     });

    // Обработчик отключения клиента
    socket.on('disconnect', (reason) => {
        log.info(`[Socket.IO] Клиент отключился: ${socketId}. Причина: ${reason}`);
        const userId = socket.userId; // Используем ID, сохраненный при подключении/регистрации
        if (userId && userSockets[userId] === socketId) {
             log.info(`[Socket.IO] Удаление пользователя ${userId} (сокет ${socketId}) из реестра активных сокетов.`);
             delete userSockets[userId];
        } else if (userId) {
             log.warn(`[Socket.IO] Отключенный сокет ${socketId} не совпал с сохраненным ${userSockets[userId]} для пользователя ${userId}. Реестр не изменен.`);
        } else {
            // Попытка найти пользователя по ID сокета, если userId не установился
            let foundUserId = Object.keys(userSockets).find(uid => userSockets[uid] === socketId);
            if (foundUserId) {
                log.info(`[Socket.IO] Удаление пользователя ${foundUserId} (сокет ${socketId}) через поиск по ID сокета.`);
                delete userSockets[foundUserId];
            } else {
                log.warn(`[Socket.IO] Не удалось найти пользователя для отключенного сокета ${socketId}.`);
            }
        }
        // Комната user:<userId> удаляется автоматически при выходе сокета
    });
});

// --- Обработка 404 и 500 ---
// Обработчик 404 (должен быть ПОСЛЕ всех роутеров)
app.use((req, res, next) => {
    log.warn(`[404 Not Found] Path: ${req.originalUrl}, Method: ${req.method}`);
    res.status(404).render('error', { // Рендерим шаблон ошибки
        title: 'Страница не найдена (404)',
        message: 'Запрашиваемая страница не существует или была перемещена.',
        currentUser: res.locals.currentUser // Передаем пользователя для хедера
    });
});

// Глобальный обработчик ошибок (должен быть САМЫМ ПОСЛЕДНИМ)
app.use((err, req, res, next) => {
    log.error("[Global Error Handler] Произошла ошибка:", err); // Логируем полную ошибку
    const statusCode = err.status || 500; // Статус ошибки или 500 по умолчанию
    // В режиме разработки показываем больше деталей
    const isDevelopment = process.env.NODE_ENV === 'development';
    const errorMessage = isDevelopment
                         ? (err.message || 'Неизвестная ошибка сервера.')
                         : 'На сервере произошла внутренняя ошибка. Попробуйте позже.';

    // Отправляем статус и рендерим страницу ошибки
    res.status(statusCode).render('error', {
        title: `Ошибка ${statusCode}`,
        message: errorMessage,
        // Если в разработке, можно передать и стек ошибки (но осторожно)
        // errorStack: isDevelopment ? err.stack : null,
        currentUser: res.locals.currentUser // Передаем пользователя для хедера
    });
});

// --- Запуск HTTP сервера ---
httpServer.listen(port, () => {
    log.info(`Сервер Express с Socket.IO запущен внутри Electron по адресу http://localhost:${port}`);
});

// Экспортируем сервер (может быть полезно для тестов или других модулей)
module.exports = httpServer;