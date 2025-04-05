// server.js
// server.js
const express = require('express');
const path = require('path');
const fs = require('fs'); // Убедимся что fs импортирован
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
    if (!admin.apps.length) { // Проверяем, не инициализировано ли уже
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://diplomarenda-default-rtdb.firebaseio.com" // ВАШ URL
        });
        log.info("Firebase Admin SDK успешно инициализирован.");
    } else {
        log.info("Firebase Admin SDK уже был инициализирован.");
    }
} catch (error) {
     log.error("Критическая ошибка инициализации Firebase Admin SDK:", error);
     // В Electron лучше не завершать процесс сразу, а показать ошибку
     // process.exit(1);
}

// --- ИМПОРТ СЕРВИСОВ, МАРШРУТОВ И MIDDLEWARE ---
const firebaseService = require('./services/firebaseService');
const authRoutes = require('./routes/authRoutes');
const propertyRoutes = require('./routes/propertyRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const userRoutes = require('./routes/userRoutes');
const rentalRoutes = require('./routes/rentalRoutes');
const companyRoutes = require('./routes/companyRoutes');
const { checkCompanyProfile } = require('./middleware/ownerMiddleware'); // Убедитесь, что этот файл существует и экспортирует функцию
const { ensureCompanyExists } = require('./middleware/companyMiddleware');

// --- Express & HTTP Server ---
const app = express();
const port = process.env.PORT || 3000;
const httpServer = http.createServer(app);

// --- Socket.IO Server ---
const io = new Server(httpServer, {
    // Опции Socket.IO, если нужны (например, transports)
});
// Делаем io доступным для маршрутов через req.app.get('socketio')
app.set('socketio', io);

// --- Redis Подключение и Настройка Адаптера ---
const redisEndpoint = "redis-19018.c328.europe-west3-1.gce.redns.redis-cloud.com";
const redisPort = 19018;
const redisPassword = "d8jyr2hbUtLUBPF5CE25xUcXoy7pgwcT"; // Ваш пароль Redis
const redisUrl = `redis://default:${redisPassword}@${redisEndpoint}:${redisPort}`; // Добавил 'default:' username, если требуется
log.info(`[Redis] Attempting to connect to endpoint: ${redisEndpoint}:${redisPort}`);

const pubClient = createClient({ url: redisUrl });
const subClient = pubClient.duplicate();

// Флаг для отслеживания статуса Redis
let isRedisConnected = false;

// Обработчики событий Redis
pubClient.on('connect', () => log.info('[Redis PubClient] Connecting...'));
pubClient.on('ready', () => {
    log.info('[Redis PubClient] Ready.');
    // Проверяем, готов ли и второй клиент
    if (subClient.isReady) {
        if (!isRedisConnected) { // Настраиваем адаптер только один раз
             io.adapter(createAdapter(pubClient, subClient));
             log.info('[Socket.IO] Redis adapter configured.');
             isRedisConnected = true;
        }
    }
});
pubClient.on('error', (err) => log.error('[Redis PubClient Error]', err));
pubClient.on('reconnecting', () => log.warn('[Redis PubClient] Reconnecting...'));
pubClient.on('end', () => { log.warn('[Redis PubClient] Connection closed.'); isRedisConnected = false; });


subClient.on('connect', () => log.info('[Redis SubClient] Connecting...'));
subClient.on('ready', () => {
    log.info('[Redis SubClient] Ready.');
    if (pubClient.isReady) {
         if (!isRedisConnected) { // Настраиваем адаптер только один раз
             io.adapter(createAdapter(pubClient, subClient));
             log.info('[Socket.IO] Redis adapter configured.');
             isRedisConnected = true;
         }
    }
});
subClient.on('error', (err) => log.error('[Redis SubClient Error]', err));
subClient.on('reconnecting', () => log.warn('[Redis SubClient] Reconnecting...'));
subClient.on('end', () => { log.warn('[Redis SubClient] Connection closed.'); isRedisConnected = false; });

// Подключаемся к Redis
Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => {
        // Логи уже есть в 'ready'
    })
    .catch((err) => {
        log.error(`[Redis] CRITICAL: Failed to connect clients to ${redisEndpoint}:${redisPort}:`, err);
        log.error('!!! ВНИМАНИЕ: Синхронизация уведомлений между экземплярами приложения НЕ БУДЕТ РАБОТАТЬ без Redis.');
        // Не останавливаем сервер, он может работать и без Redis, но без синхронизации
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
    secret: 'your_very_secret_key_for_sessions_change_me_plz', // !!! ЗАМЕНИТЕ КЛЮЧ !!!
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 } // secure: false для localhost
});
app.use(sessionMiddleware);

// --- Интеграция сессий Express с Socket.IO ---
// Преобразуем middleware Express в формат, понятный Socket.IO
const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));

// Дополнительный middleware для Socket.IO для доступа к пользователю сессии
io.use((socket, next) => {
    const session = socket.request.session;
    if (session && session.user) {
        socket.user = session.user; // Прикрепляем пользователя к сокету
        log.info(`[Socket.IO Middleware] User ${socket.user.username} found in session for socket ${socket.id}`);
    } else {
        log.warn(`[Socket.IO Middleware] No user session found for socket ${socket.id}`);
    }
    next();
});


// --- Передача данных в шаблоны EJS ---
app.use((req, res, next) => {
    res.locals.currentUser = req.session?.user || null;
    res.locals.companyId = req.session?.user?.companyId || null; // Добавлено на всякий случай
    // Убираем обработку message здесь, т.к. она теперь в authRoutes/profile GET
    // res.locals.message = req.session?.message || null;
    // if (req.session?.message) {
    //     delete req.session.message;
    //     req.session.save(err => {
    //         if (err) log.warn("[Middleware] Error saving session after deleting flash message:", err);
    //     });
    // }
    next();
});

// --- Middleware для отладки сессии (опционально) ---
app.use((req, res, next) => {
  const userId = req.session?.user?.username || req.session?.tempUser?.username || 'Guest';
  const companyIdLog = req.session?.user?.companyId ? ` (Comp: ${req.session.user.companyId})` : '';
  const sessionIdPart = req.session?.id ? ` (Sess: ...${req.session.id.slice(-6)})` : '';
  log.info(`[Request Log] Path: ${req.method} ${req.path}, User: ${userId}${companyIdLog}${sessionIdPart}`);
  next();
});

// --- Глобальные Middleware для Owner ---
// Убедитесь, что ownerMiddleware.js существует и экспортирует checkCompanyProfile
if (fs.existsSync(path.join(__dirname, 'middleware', 'ownerMiddleware.js'))) {
    const { checkCompanyProfile } = require('./middleware/ownerMiddleware');
    app.use(checkCompanyProfile);
} else {
    log.warn("middleware/ownerMiddleware.js not found, skipping checkCompanyProfile middleware.");
}
app.use(ensureCompanyExists);

// --- Маршруты ---
app.use(authRoutes);
app.use('/properties', propertyRoutes); // Маршруты для объектов
app.use('/bookings', bookingRoutes);     // Маршруты для бронирований (создание, просмотр своих)
app.use('/users', userRoutes);          // Маршруты для управления пользователями (Admin)
app.use('/rentals', rentalRoutes);      // Маршруты для управления арендами (Owner/Staff/Admin)
app.use('/company', companyRoutes);     // Маршруты для управления компанией (Owner/Staff/Admin)

// --- Базовый маршрут ---
app.get('/', async (req, res, next) => {
    if (!req.session.user) {
        try { return res.render('index', { title: 'Добро пожаловать' }); }
        catch (renderError) { log.error("Error rendering index.ejs:", renderError); return next(renderError); }
    }
    const currentUser = req.session.user;
    const dashboardData = { role: currentUser.role };
    try {
        log.info(`[Dashboard GET v5 - Rooms] Loading dashboard data for ${currentUser.username} (Role: ${currentUser.role})`);
        // --- Логика Дашборда (версия 5) ---
        if (currentUser.role === 'Tenant') {
             // Получаем актуальные данные пользователя, включая баланс
             const tenantData = await firebaseService.getUserByUsername(currentUser.username);
             if (!tenantData) { throw new Error('Tenant user data not found in DB'); }
             dashboardData.balance = tenantData.Balance ?? 0; // Берем актуальный баланс из БД
             // Обновляем баланс в сессии на всякий случай
             req.session.user.balance = dashboardData.balance;

             const tenantBookings = await firebaseService.getBookingsByUserId(currentUser.username);
             const validBookings = Array.isArray(tenantBookings) ? tenantBookings : [];
             dashboardData.activeBookingsCount = validBookings.filter(b => b?.Status === 'Активна').length;

             const recentActive = validBookings
                 .filter(b => b?.Status === 'Активна')
                 .sort((a, b) => new Date(b.CreatedAt || 0) - new Date(a.CreatedAt || 0))
                 .slice(0, 3); // Берем 3 последних активных

             if (recentActive.length > 0) {
                 const propIds = [...new Set(recentActive.map(b => b.PropertyId).filter(Boolean))];
                 if (propIds.length > 0) {
                     // Используем Promise.all для параллельной загрузки свойств
                     const props = await Promise.all(propIds.map(id => firebaseService.getPropertyById(id).catch(e => { log.warn(`Error fetching property ${id} for dashboard: ${e.message}`); return null; })));
                     const propsMap = new Map(props.filter(Boolean).map(p => [p.Id, p.Title]));
                     recentActive.forEach(b => {
                         b.PropertyTitle = b.PropertyId ? (propsMap.get(b.PropertyId) || 'Объект?') : '?';
                         b.StartDateFormatted = b.StartDate ? new Date(b.StartDate).toLocaleDateString('ru-RU') : '?';
                         b.EndDateFormatted = b.EndDate ? new Date(b.EndDate).toLocaleDateString('ru-RU') : '?';
                     });
                 }
             }
             dashboardData.recentActiveBookings = recentActive;

        } else if ((currentUser.role === 'Owner' || currentUser.role === 'Staff') && currentUser.companyId) {
            const companyId = currentUser.companyId;
            // Параллельная загрузка данных компании, ее объектов, всех броней и всех пользователей
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
            // Обновляем имя компании в сессии, если оно отличается
            if (company && currentUser.companyName !== company.companyName) {
                 req.session.user.companyName = company.companyName;
            }

            const validProperties = Array.isArray(properties) ? properties : [];
            dashboardData.totalProperties = validProperties.length;
            dashboardData.availableProperties = validProperties.filter(p => p?.IsAvailable).length;

            const companyPropertyIds = validProperties.map(p => p.Id);
            const validBookings = Array.isArray(allBookings) ? allBookings : [];
            const companyBookings = validBookings.filter(b => b?.PropertyId && companyPropertyIds.includes(b.PropertyId));

            dashboardData.activeRentalsCount = companyBookings.filter(b => b?.Status === 'Активна').length;
            dashboardData.totalRentalsCount = companyBookings.length; // Общее число аренд для компании

            const recentBookings = companyBookings
                 .sort((a, b) => new Date(b.CreatedAt || 0) - new Date(a.CreatedAt || 0))
                 .slice(0, 5); // Покажем 5 последних аренд для компании

            if (recentBookings.length > 0 && Array.isArray(allUsers)) {
                const propsMap = new Map(validProperties.map(p => [p.Id, p.Title]));
                // Создаем карту пользователей для быстрого поиска имен
                const usersMap = new Map(allUsers.filter(u => u?.Username).map(u => [u.Username, u.FullName || u.Username]));
                recentBookings.forEach(b => {
                    b.PropertyTitle = b.PropertyId ? (propsMap.get(b.PropertyId) || '?') : '?';
                    b.TenantName = b.UserId ? (usersMap.get(b.UserId) || b.UserId) : '?'; // Получаем имя из карты
                    b.StartDateFormatted = b.StartDate ? new Date(b.StartDate).toLocaleDateString('ru-RU') : '?';
                    // Добавляем EndDateFormatted, если нужно в дашборде
                    // b.EndDateFormatted = b.EndDate ? new Date(b.EndDate).toLocaleDateString('ru-RU') : '?';
                });
            }
            dashboardData.recentBookings = recentBookings;

        } else if (currentUser.role === 'Admin') {
             // Загружаем данные для админа
             const [usersResult, propertiesResult, bookingsResult] = await Promise.allSettled([
                 firebaseService.getAllUsers(),
                 firebaseService.getAllProperties(),
                 firebaseService.getAllBookings()
             ]);

             dashboardData.totalUsers = usersResult.status === 'fulfilled' && Array.isArray(usersResult.value) ? usersResult.value.length : 0;
             dashboardData.totalProperties = propertiesResult.status === 'fulfilled' && Array.isArray(propertiesResult.value) ? propertiesResult.value.length : 0;
             const validBookings = bookingsResult.status === 'fulfilled' && Array.isArray(bookingsResult.value) ? bookingsResult.value : [];
             dashboardData.totalBookings = validBookings.length;
             dashboardData.activeBookings = validBookings.filter(b => b?.Status === 'Активна').length;
        }

        // Сохраняем сессию перед рендерингом (если были изменения)
        req.session.save(err => {
            if (err) log.error("[Dashboard GET v5] Session save error before render:", err);
            res.render('dashboard', { title: 'Панель управления', dashboardData });
        });

    } catch (error) {
        log.error("[Dashboard GET v5] Error loading dashboard data:", error);
        res.status(500).render('dashboard', { title: 'Ошибка', dashboardData: { role: currentUser?.role || 'Unknown', error: 'Не удалось загрузить данные.' } });
    }
});


// --- Логика Socket.IO (с комнатами и локальной картой) ---
const userSockets = {}; // Локальная карта { userId: socket.id } - только для отладки, т.к. Redis отвечает за доставку
app.set('userSockets', userSockets); // Делаем доступным для тестов, если нужно

io.on('connection', (socket) => {
    // Используем пользователя, прикрепленного middleware
    const userId = socket.user?.username;
    log.info(`[Socket.IO] Client connected: ${socket.id}${userId ? ` (User: ${userId})` : ' (No user in session)'}`);

    if (userId) {
        const roomName = `user:${userId}`;
        socket.join(roomName);
        log.info(`[Socket.IO] Socket ${socket.id} joined room '${roomName}'`);
        userSockets[userId] = socket.id; // Обновляем ID сокета для пользователя
    }

    // Этот обработчик нужен, если клиент явно отправляет событие регистрации
    // (например, если сессия не успела загрузиться при первом подключении)
    socket.on('register_user', (clientUserId) => {
        if (clientUserId && !socket.user) { // Если сессии не было, но клиент прислал ID
            const roomName = `user:${clientUserId}`;
            socket.join(roomName);
            socket.user = { username: clientUserId }; // Условно добавляем пользователя
            userSockets[clientUserId] = socket.id; // Добавляем в локальную карту
            log.info(`[Socket.IO] Socket ${socket.id} registered and joined room '${roomName}' via 'register_user' event.`);
        } else if (clientUserId && socket.user && clientUserId !== socket.user.username) {
             log.warn(`[Socket.IO] Mismatch on 'register_user': Socket User (${socket.user.username}) != Event User (${clientUserId}) for socket ${socket.id}`);
        }
    });

    socket.on('disconnect', (reason) => {
        const disconnectedUserId = socket.user?.username;
        log.info(`[Socket.IO] Client disconnected: ${socket.id}${disconnectedUserId ? ` (User: ${disconnectedUserId})` : ''}. Reason: ${reason}`);
        // Удаляем сокет из локальной карты, если он там был для этого пользователя
        if (disconnectedUserId && userSockets[disconnectedUserId] === socket.id) {
            log.info(`[Socket.IO] Removing user ${disconnectedUserId} (socket ${socket.id}) from local registry.`);
            delete userSockets[disconnectedUserId];
        }
        // Комнаты Redis Adapter обрабатывает автоматически
    });

     // Добавляем обработчик ошибок сокета
     socket.on('error', (err) => {
         const errorUserId = socket.user?.username;
         log.error(`[Socket.IO] Socket error for socket ${socket.id}${errorUserId ? ` (User: ${errorUserId})` : ''}:`, err);
     });
});

// --- Обработка 404 и 500 ---
app.use((req, res, next) => {
    log.warn(`[404 Not Found] Path: ${req.path}, Method: ${req.method}`);
    res.status(404).render('error', { title: 'Страница не найдена (404)', message: 'Запрашиваемая страница не существует.' });
});

app.use((err, req, res, next) => {
    log.error("[Global Error Handler] An error occurred:", err);
    const statusCode = err.status || 500;
    const isDevelopment = process.env.NODE_ENV === 'development';
    res.status(statusCode).render('error', {
        title: `Ошибка ${statusCode}`,
        message: (err.expose || isDevelopment) ? err.message : 'На сервере произошла внутренняя ошибка.',
        // Передаем стек только в разработке
        errorStack: isDevelopment ? err.stack : null
    });
});

// --- Запуск HTTP сервера ---
// Убедимся, что порт слушается только один раз
function startServer(port) {
    return new Promise((resolve, reject) => {
        httpServer.listen(port)
            .on('listening', () => {
                log.info(`Сервер Express с Socket.IO и Redis Adapter запущен внутри Electron по адресу http://localhost:${port}`);
                resolve(httpServer); // Разрешаем промис, когда сервер начал слушать
            })
            .on('error', (err) => {
                log.error(`[Server Listen Error] Failed to bind to port ${port}: ${err.message}`);
                if (err.code === 'EADDRINUSE') {
                    log.error(`!!! Порт ${port} уже используется. Возможно, другое приложение или предыдущий экземпляр сервера запущен.`);
                }
                reject(err); // Отклоняем промис при ошибке
            });
    });
}

// Экспортируем объект с функцией запуска и другими нужными частями
module.exports = {
    startServer, // Экспортируем функцию запуска
    app,         // Экспортируем Express app (может пригодиться)
    io           // Экспортируем Socket.IO instance (может пригодиться)
};