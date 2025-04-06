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
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);

// --- Интеграция сессий Express с Socket.IO ---
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// --- Передача данных в шаблоны EJS ---
app.use((req, res, next) => {
    res.locals.currentUser = req.session?.user || null;
    res.locals.companyId = req.session?.user?.companyId || null;
    res.locals.message = req.session?.message || null;
    if (req.session?.message) {
        delete req.session.message;
        req.session.save(err => {
            if (err) console.warn("[Middleware] Error saving session after deleting flash message:", err); // Используем console.warn
        });
    }
    next();
});

// --- Middleware для отладки сессии (опционально) ---
app.use((req, res, next) => {
  const userId = req.session?.user?.username || req.session?.tempUser?.username || 'Guest';
  const companyIdLog = req.session?.user?.companyId ? ` (Comp: ${req.session.user.companyId})` : '';
  const sessionIdPart = req.session?.id ? ` (Sess: ...${req.session.id.slice(-6)})` : '';
  // console.log(`[Session Check] Path: ${req.path}, User: ${userId}${companyIdLog}${sessionIdPart}`); // Стандартный console.log
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

// --- Базовый маршрут ---
app.get('/', async (req, res, next) => {
    if (!req.session.user) {
        try { return res.render('index', { title: 'Добро пожаловать' }); }
        catch (renderError) { console.error("Error rendering index.ejs:", renderError); return next(renderError); }
    }
    const currentUser = req.session.user;
    const dashboardData = { role: currentUser.role };
    try {
        console.log(`[Dashboard GET v4] Loading dashboard data for ${currentUser.username} (Role: ${currentUser.role})`);
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
            const [company, properties, allBookings, allUsers] = await Promise.allSettled([ firebaseService.getCompanyById(companyId), firebaseService.getPropertiesByCompanyId(companyId), firebaseService.getAllBookings(), firebaseService.getAllUsers() ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));
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
             const [users, properties, bookings] = await Promise.allSettled([ firebaseService.getAllUsers(), firebaseService.getAllProperties(), firebaseService.getAllBookings() ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : []));
             dashboardData.totalUsers = Array.isArray(users) ? users.length : 0;
             dashboardData.totalProperties = Array.isArray(properties) ? properties.length : 0;
             dashboardData.totalBookings = Array.isArray(bookings) ? bookings.length : 0;
             dashboardData.activeBookings = Array.isArray(bookings) ? bookings.filter(b => b?.Status === 'Активна').length : 0;
        }
        res.render('dashboard', { title: 'Панель управления', dashboardData });
    } catch (error) {
        console.error("[Dashboard GET v4] Error loading dashboard data:", error); // Стандартный console
        res.status(500).render('dashboard', { title: 'Ошибка', dashboardData: { role: currentUser?.role || 'Unknown', error: 'Не удалось загрузить данные.' } });
    }
});


// --- Логика Socket.IO (с комнатами и локальной картой) ---
const userSockets = {}; // Локальная карта { userId: socket.id }
app.set('userSockets', userSockets); // Для возможного использования

io.on('connection', (socket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`); // Стандартный console
    let associatedUserId = null;

    const session = socket.request.session;
    if (session) {
        session.reload((err) => {
            if (err) { console.error(`[Socket.IO] Error reloading session for ${socket.id}:`, err); return; }
            const socketUser = session.user;
            if (socketUser && socketUser.username) {
                associatedUserId = socketUser.username;
                console.log(`[Socket.IO] Associating user ${associatedUserId} (from session) with socket ${socket.id}`);
                userSockets[associatedUserId] = socket.id;
                socket.userId = associatedUserId;
                socket.join(`user:${associatedUserId}`);
                console.log(`[Socket.IO] Socket ${socket.id} joined room 'user:${associatedUserId}'`);
            } else { console.warn(`[Socket.IO] No user in session for ${socket.id}.`); } // Стандартный console.warn
        });
    } else { console.warn(`[Socket.IO] No session for ${socket.id}.`); } // Стандартный console.warn

    socket.on('register_user', (userIdFromClient) => {
        if (userIdFromClient && !associatedUserId) {
             associatedUserId = userIdFromClient;
             console.log(`[Socket.IO] Registering user ${associatedUserId} (from event) with socket ${socket.id}`);
             userSockets[associatedUserId] = socket.id;
             socket.userId = associatedUserId;
             socket.join(`user:${associatedUserId}`);
             console.log(`[Socket.IO] Socket ${socket.id} joined room 'user:${associatedUserId}' (via event)`);
        } else if (userIdFromClient && associatedUserId && userIdFromClient !== associatedUserId) {
            console.warn(`[Socket.IO] Mismatch: Session User (${associatedUserId}) != Event User (${userIdFromClient}) for socket ${socket.id}`); // Стандартный console.warn
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`[Socket.IO] Client disconnected: ${socket.id}. Reason: ${reason}`);
        const userId = socket.userId || associatedUserId;
        if (userId && userSockets[userId] === socket.id) {
             console.log(`[Socket.IO] Removing user ${userId} (socket ${socket.id}) from local registry.`);
             delete userSockets[userId];
        } else if (userId) {
             console.log(`[Socket.IO] Disconnected socket ${socket.id} did not match stored socket ${userSockets[userId]} for user ${userId}.`);
        } else {
            let foundUserId = Object.keys(userSockets).find(uid => userSockets[uid] === socket.id);
            if (foundUserId) {
                 console.log(`[Socket.IO] Removing user ${foundUserId} (socket ${socket.id}) by socket ID lookup.`);
                 delete userSockets[foundUserId];
            } else { console.warn(`[Socket.IO] Could not find user for disconnected socket ${socket.id}.`); } // Стандартный console.warn
        }
    });
});

// --- Обработка 404 и 500 ---
app.use((req, res, next) => {
    console.warn(`[404 Not Found] Path: ${req.path}, Method: ${req.method}`); // Стандартный console.warn
    res.status(404).render('error', { title: 'Страница не найдена (404)', message: 'Запрашиваемая страница не существует.' });
});
app.use((err, req, res, next) => {
    console.error("[Global Error Handler] An error occurred:", err); // Стандартный console.error
    const statusCode = err.status || 500;
    res.status(statusCode).render('error', {
        title: `Ошибка ${statusCode}`,
        message: process.env.NODE_ENV === 'development' ? (err.message || 'Неизвестная ошибка сервера') : 'На сервере произошла внутренняя ошибка.',
        // errorStack: process.env.NODE_ENV === 'development' ? err.stack : null
    });
});

// --- Запуск HTTP сервера ---
httpServer.listen(port, () => {
    console.log(`Сервер Express с Socket.IO и Redis Adapter запущен внутри Electron по адресу http://localhost:${port}`); // Стандартный console.log
});

module.exports = httpServer; // Экспорт