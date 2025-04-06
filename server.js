// server.js
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const admin = require('firebase-admin');
const http = require('http');
const { Server } = require("socket.io");
const { createClient } = require("redis"); // Клиент Redis
const { createAdapter } = require("@socket.io/redis-adapter"); // Адаптер

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE ADMIN SDK ---
const serviceAccount = require('./serviceAccountKey.json');
try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://diplomarenda-default-rtdb.firebaseio.com" // ВАШ URL
    });
    // Используем стандартный console.log, electron-log его перехватит из main.js
    console.log("Firebase Admin SDK успешно инициализирован.");
} catch (error) {
     console.error("Ошибка инициализации Firebase Admin SDK:", error);
     process.exit(1);
}

// --- ИМПОРТ СЕРВИСОВ, МАРШРУТОВ И MIDDLEWARE ---
const firebaseService = require('./services/firebaseService');
const authRoutes = require('./routes/authRoutes');
const propertyRoutes = require('./routes/propertyRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const userRoutes = require('./routes/userRoutes');
const rentalRoutes = require('./routes/rentalRoutes');
const companyRoutes = require('./routes/companyRoutes');
const { checkCompanyProfile } = require('./middleware/ownerMiddleware'); // Middleware для проверки профиля Owner'а
const { ensureCompanyExists } = require('./middleware/companyMiddleware'); // Middleware для создания узла компании для Owner'а

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

// Обработчики ошибок Redis
pubClient.on('error', (err) => console.error('[Redis PubClient Error]', err));
subClient.on('error', (err) => console.error('[Redis SubClient Error]', err));

// Подключаемся к Redis и настраиваем адаптер
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
    secret: 'thisshouldbeareallylongandrandomsecretkey!', // !!! ЗАМЕНИТЕ КЛЮЧ !!!
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 } // 1 day
});
app.use(sessionMiddleware);

// --- Интеграция сессий Express с Socket.IO ---
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// --- Передача данных в шаблоны EJS ---
// Этот middleware будет выполняться ПЕРЕД каждым маршрутом
app.use(async (req, res, next) => {
    // --- НАЧАЛО ИЗМЕНЕНИЙ: Обновление сессии перед установкой res.locals ---
    if (req.session && req.session.user && req.session.user.username) {
        // Проверяем, нужно ли обновить данные в сессии
        // Например, обновляем всегда, когда пользователь заходит на / или /profile
        // или если в сессии нет каких-то критически важных актуальных данных (например, баланса для Tenant)
        const needsUpdate = req.path === '/' || req.path === '/profile' || (req.session.user.role === 'Tenant' && req.session.user.balance === undefined);

        // Можно добавить проверку времени последнего обновления, чтобы не делать это слишком часто
        // const lastUpdateThreshold = 5 * 60 * 1000; // 5 минут
        // const needsUpdate = !req.session.lastUpdate || (Date.now() - req.session.lastUpdate > lastUpdateThreshold);

        if (needsUpdate) {
            try {
                const freshUser = await firebaseService.getUserByUsername(req.session.user.username);
                if (freshUser) {
                    // Формируем обновленный объект сессии
                    const updatedSessionUser = {
                        username: freshUser.Username,
                        fullName: freshUser.FullName,
                        role: freshUser.Role,
                        email: freshUser.Email,
                        phone: freshUser.Phone,
                        imageData: freshUser.ImageData || null,
                        companyId: freshUser.companyId || null,
                        companyProfileCompleted: freshUser.companyProfileCompleted === true,
                        companyName: null // Загрузим ниже, если нужно
                    };
                    if (freshUser.Role === 'Tenant') {
                        updatedSessionUser.balance = freshUser.Balance ?? 0;
                    }
                    if (updatedSessionUser.companyId) {
                        try {
                            const company = await firebaseService.getCompanyById(updatedSessionUser.companyId);
                            updatedSessionUser.companyName = company?.companyName || null;
                        } catch (companyError) {
                             console.warn(`[Session Update Middleware] Failed to fetch company name for ${updatedSessionUser.companyId}:`, companyError);
                        }
                    }
                    // Обновляем объект сессии
                    req.session.user = updatedSessionUser;
                    // req.session.lastUpdate = Date.now(); // Сохраняем время обновления
                    console.log(`[Session Update Middleware] Session updated for ${req.session.user.username} on path ${req.path}`);
                } else {
                    // Пользователь удален из БД, уничтожаем сессию
                    console.warn(`[Session Update Middleware] User ${req.session.user.username} not found in DB. Destroying session.`);
                    return req.session.destroy((err) => {
                        res.clearCookie('connect.sid');
                        res.redirect('/login');
                    });
                }
            } catch (error) {
                console.error(`[Session Update Middleware] Error fetching user data for session update:`, error);
                // Не прерываем запрос из-за ошибки обновления сессии, но логируем
            }
        }
    }
     // --- КОНЕЦ ИЗМЕНЕНИЙ ---

    // Устанавливаем res.locals ПОСЛЕ возможного обновления сессии
    res.locals.currentUser = req.session?.user || null;
    res.locals.companyId = req.session?.user?.companyId || null; // Передаем companyId в шаблоны, если он есть
    res.locals.message = req.session?.message || null;

    // Очистка флеш-сообщений
    if (req.session?.message) {
        delete req.session.message;
         // Сохраняем сессию после удаления сообщения (лучше делать это здесь, а не ждать ответа)
         // Используем save с колбэком, чтобы next() вызвался после сохранения
         req.session.save(err => {
             if (err) {
                 console.warn("[Middleware] Error saving session after deleting flash message:", err);
             }
             next(); // Переходим к следующему middleware/маршруту ТОЛЬКО после сохранения сессии
         });
    } else {
         next(); // Если сообщений не было, просто идем дальше
    }
});

// --- Middleware для отладки сессии (опционально) ---
app.use((req, res, next) => {
  const userId = req.session?.user?.username || req.session?.tempUser?.username || 'Guest';
  const companyIdLog = req.session?.user?.companyId ? ` (Comp: ${req.session.user.companyId})` : '';
  const sessionIdPart = req.session?.id ? ` (Sess: ...${req.session.id.slice(-6)})` : '';
  // Закомментировано, чтобы не спамить логи, но полезно для отладки
  // console.log(`[Session Check] Path: ${req.path}, User: ${userId}${companyIdLog}${sessionIdPart}`);
  next();
});

// --- Глобальные Middleware для Owner ---
app.use(checkCompanyProfile); // Проверяет, заполнен ли профиль компании Owner'а
app.use(ensureCompanyExists); // Убеждается, что у Owner'а есть узел компании в БД

// --- Маршруты ---
app.use(authRoutes); // Маршруты аутентификации (/login, /register, /profile, etc.)
app.use('/properties', propertyRoutes); // Маршруты для объектов (/properties, /properties/add, etc.)
app.use('/bookings', bookingRoutes); // Маршруты для бронирований (/bookings, /bookings/new, etc.)
app.use('/users', userRoutes); // Маршруты для управления пользователями (/users, /users/add, etc.) - ТОЛЬКО ДЛЯ АДМИНА
app.use('/rentals', rentalRoutes); // Маршруты для управления арендами (/rentals) - ДЛЯ АДМИНА/ВЛАДЕЛЬЦА/СТАФФА
app.use('/company', companyRoutes); // Маршруты для управления компанией (/company/manage, etc.)

// --- Базовый маршрут (Dashboard) ---
// Он теперь получает currentUser из res.locals, который был обновлен middleware выше
app.get('/', async (req, res, next) => {
    if (!res.locals.currentUser) { // Проверяем через res.locals
        try { return res.render('index', { title: 'Добро пожаловать' }); }
        catch (renderError) { console.error("Error rendering index.ejs:", renderError); return next(renderError); }
    }

    // Используем currentUser из res.locals, который уже должен быть актуальным
    const currentUser = res.locals.currentUser;
    const dashboardData = { role: currentUser.role };

    try {
        console.log(`[Dashboard GET v5] Loading dashboard data for ${currentUser.username} (Role: ${currentUser.role})`);

        // --- Логика Дашборда (остается без изменений, т.к. currentUser уже актуален) ---
        if (currentUser.role === 'Tenant') {
            // Загрузка данных для Арендатора
             const tenantBookings = await firebaseService.getBookingsByUserId(currentUser.username);
             const validBookings = Array.isArray(tenantBookings) ? tenantBookings : [];
             dashboardData.activeBookingsCount = validBookings.filter(b => b?.Status === 'Активна').length;
             dashboardData.balance = currentUser.balance ?? 0; // Берем из обновленной сессии
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
            // Загрузка данных для Владельца/Сотрудника
            const companyId = currentUser.companyId;
            // Используем Promise.allSettled для надежности
            const [companyResult, propertiesResult, allBookingsResult, allUsersResult] = await Promise.allSettled([
                 firebaseService.getCompanyById(companyId),
                 firebaseService.getPropertiesByCompanyId(companyId),
                 firebaseService.getAllBookings(), // Получаем все брони, отфильтруем ниже
                 firebaseService.getAllUsers()    // Получаем всех пользователей для имен
             ]);

             // Обрабатываем результаты
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
            // Загрузка данных для Администратора
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
        // Отправляем dashboardData в шаблон
        res.render('dashboard', { title: 'Панель управления', dashboardData });
    } catch (error) {
        console.error("[Dashboard GET v5] Error loading dashboard data:", error);
        res.status(500).render('dashboard', { title: 'Ошибка', dashboardData: { role: currentUser?.role || 'Unknown', error: 'Не удалось загрузить данные панели управления.' } });
    }
});


// --- Логика Socket.IO (с комнатами и локальной картой) ---
const userSockets = {}; // Локальная карта { userId: socket.id }
app.set('userSockets', userSockets); // Для возможного использования в маршрутах

io.on('connection', (socket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);
    let associatedUserId = null;

    // Получаем сессию для сокета
    const session = socket.request.session;
    if (session) {
        // Перезагружаем сессию, чтобы убедиться, что она актуальна
        session.reload((err) => {
            if (err) {
                console.error(`[Socket.IO] Error reloading session for ${socket.id}:`, err);
                // Можно отключить сокет или предпринять другие действия
                return;
            }

            const socketUser = session.user;
            if (socketUser && socketUser.username) {
                associatedUserId = socketUser.username;
                console.log(`[Socket.IO] Associating user ${associatedUserId} (from session) with socket ${socket.id}`);
                userSockets[associatedUserId] = socket.id;
                socket.userId = associatedUserId; // Сохраняем userId на сокете для легкого доступа при disconnect
                socket.join(`user:${associatedUserId}`); // Присоединяем сокет к комнате пользователя
                console.log(`[Socket.IO] Socket ${socket.id} joined room 'user:${associatedUserId}'`);
            } else {
                console.warn(`[Socket.IO] No user found in session for socket ${socket.id}. Waiting for 'register_user' event.`);
            }
        });
    } else {
        console.warn(`[Socket.IO] Session middleware did not attach session to socket request for ${socket.id}.`);
    }

    // Слушаем событие 'register_user', если клиент отправляет свой ID
    socket.on('register_user', (userIdFromClient) => {
        // Регистрируем, только если пользователь еще не был ассоциирован через сессию
        if (userIdFromClient && !associatedUserId) {
            associatedUserId = userIdFromClient;
            console.log(`[Socket.IO] Registering user ${associatedUserId} (from event) with socket ${socket.id}`);
            userSockets[associatedUserId] = socket.id;
            socket.userId = associatedUserId;
            socket.join(`user:${associatedUserId}`);
            console.log(`[Socket.IO] Socket ${socket.id} joined room 'user:${associatedUserId}' (via event)`);
        } else if (userIdFromClient && associatedUserId && userIdFromClient !== associatedUserId) {
            // Если ID из сессии и ID из события не совпадают - это странно, логируем
            console.warn(`[Socket.IO] Mismatch: Session User (${associatedUserId}) != Event User (${userIdFromClient}) for socket ${socket.id}`);
        }
    });

    // Обработка отключения
    socket.on('disconnect', (reason) => {
        console.log(`[Socket.IO] Client disconnected: ${socket.id}. Reason: ${reason}`);
        // Используем ID, сохраненный на сокете, или изначальный associatedUserId
        const userId = socket.userId || associatedUserId;
        if (userId && userSockets[userId] === socket.id) {
            // Удаляем только если ID сокета совпадает (на случай, если пользователь переподключился с новым сокетом)
            console.log(`[Socket.IO] Removing user ${userId} (socket ${socket.id}) from local registry.`);
            delete userSockets[userId];
        } else if (userId) {
            // Если userId известен, но сокет не совпадает
            console.log(`[Socket.IO] Disconnected socket ${socket.id} did not match stored socket ${userSockets[userId]} for user ${userId}. Not removing from registry.`);
        } else {
            // Пытаемся найти пользователя по ID сокета, если userId неизвестен
            let foundUserId = Object.keys(userSockets).find(uid => userSockets[uid] === socket.id);
            if (foundUserId) {
                console.log(`[Socket.IO] Removing user ${foundUserId} (socket ${socket.id}) by socket ID lookup.`);
                delete userSockets[foundUserId];
            } else {
                console.warn(`[Socket.IO] Could not find user for disconnected socket ${socket.id} to remove from registry.`);
            }
        }
    });

    // Другие обработчики событий от клиента (если нужны)
    // socket.on('some_event', (data) => { ... });
});

// --- Обработка 404 и 500 ---
// Обработчик 404 (должен идти после всех маршрутов)
app.use((req, res, next) => {
    console.warn(`[404 Not Found] Path: ${req.path}, Method: ${req.method}`);
    res.status(404).render('error', {
        title: 'Страница не найдена (404)',
        message: 'Запрашиваемая страница не существует.'
        // currentUser можно не передавать, т.к. он уже в res.locals
    });
});

// Глобальный обработчик ошибок (должен идти последним)
app.use((err, req, res, next) => {
    console.error("[Global Error Handler] An error occurred:", err); // Логируем ошибку
    const statusCode = err.status || 500;
    const isDevelopment = process.env.NODE_ENV === 'development'; // Проверяем режим разработки

    res.status(statusCode).render('error', {
        title: `Ошибка ${statusCode}`,
        message: isDevelopment ? (err.message || 'Неизвестная ошибка сервера') : 'На сервере произошла внутренняя ошибка.',
        // Можно передать стек ошибки в режиме разработки для отладки
        // errorStack: isDevelopment ? err.stack : null
        // currentUser уже будет доступен из res.locals
    });
});

// --- Запуск HTTP сервера ---
// Слушаем на порту, указанном в начале файла
httpServer.listen(port, () => {
    console.log(`Сервер Express с Socket.IO запущен внутри Electron по адресу http://localhost:${port}`);
});

module.exports = httpServer; // Экспортируем httpServer для использования в main.js