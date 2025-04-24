// server.js (Полная версия с восстановленными обработчиками уведомлений и чатов)
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
const db = admin.database(); // Добавим для удобства

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
const io = new Server(httpServer, {
    // Опции для лучшей обработки переподключений и ошибок
    pingInterval: 10000,
    pingTimeout: 5000,
    transports: ['websocket', 'polling'] // WebSocket предпочтительнее
});
app.set('socketio', io); // Делаем io доступным в запросах Express
log.info('[Socket.IO] Сервер Socket.IO создан.');

// --- Redis Подключение и Настройка Адаптера ---
const redisEndpoint = "redis-19018.c328.europe-west3-1.gce.redns.redis-cloud.com";
const redisPort = 19018;
const redisPassword = "d8jyr2hbUtLUBPF5CE25xUcXoy7pgwcT"; // ВАЖНО: Храните пароль безопасно!
const redisUrl = `redis://default:${redisPassword}@${redisEndpoint}:${redisPort}`; // Добавил 'default:' для Redis Cloud
log.info(`[Redis] Попытка подключения к Redis: ${redisEndpoint}:${redisPort}`);

const pubClient = createClient({ url: redisUrl });
const subClient = pubClient.duplicate();

pubClient.on('error', (err) => log.error('[Redis PubClient Error]', err));
subClient.on('error', (err) => log.error('[Redis SubClient Error]', err));
pubClient.on('connect', () => log.info('[Redis PubClient] Connected.'));
subClient.on('connect', () => log.info('[Redis SubClient] Connected.'));
pubClient.on('ready', () => log.info('[Redis PubClient] Ready.'));
subClient.on('ready', () => log.info('[Redis SubClient] Ready.'));
pubClient.on('reconnecting', () => log.warn('[Redis PubClient] Reconnecting...'));
subClient.on('reconnecting', () => log.warn('[Redis SubClient] Reconnecting...'));

Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => {
        log.info(`[Redis] Клиенты Pub/Sub успешно подключены к ${redisEndpoint}:${redisPort}.`);
        io.adapter(createAdapter(pubClient, subClient));
        log.info('[Socket.IO] Redis адаптер успешно сконфигурирован.');
    })
    .catch((err) => {
        log.error(`[Redis] КРИТИЧЕСКАЯ ОШИБКА: Не удалось подключить Redis клиенты к ${redisEndpoint}:${redisPort}:`, err);
        log.error('!!! ВНИМАНИЕ: Синхронизация уведомлений и сокетов между экземплярами приложения НЕ БУДЕТ РАБОТАТЬ без Redis.');
        // Можно добавить выход из приложения, если Redis критичен: process.exit(1);
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
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 } // secure: false для localhost
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

    // Обработка flash-сообщений (остается без изменений)
    if (req.session.message) {
        res.locals.message = req.session.message;
        delete req.session.message;
        req.session.save(err => {
            if (err) log.warn("[Session MW:FlashClear] Error saving session after deleting flash message:", err);
        });
    }

    // Обновление и передача данных пользователя (остается без изменений в части получения юзера)
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
                    try { const company = await firebaseService.getCompanyById(updatedSessionUser.companyId); updatedSessionUser.companyName = company?.companyName || null; }
                    catch (companyError) { log.warn(`[Session MW] Failed fetch company name for ${username}:`, companyError); }
                }

                // *** ИЗМЕНЕНО: Получаем общий счетчик непрочитанных ЧАТОВ, а не уведомлений ***
                try {
                    // Определяем ID читателя (username для Tenant, companyId для Owner/Staff)
                    const readerId = (updatedSessionUser.role === 'Owner' || updatedSessionUser.role === 'Staff')
                                     ? updatedSessionUser.companyId
                                     : updatedSessionUser.username;

                    if (readerId) {
                        // Вызываем ОБНОВЛЕННУЮ функцию ИЗ firebaseService
                        log.debug(`[Session MW] Calling calculateTotalUnreadChats for User: ${updatedSessionUser.username}, Company: ${updatedSessionUser.companyId}, Reader: ${readerId}`);
                        const totalUnreadMessagesCount = await firebaseService.calculateTotalUnreadChats(
                            updatedSessionUser.username,
                            updatedSessionUser.companyId,
                            readerId // Передаем ID того, для кого считаем
                        );
                        res.locals.totalUnreadChatCount = totalUnreadMessagesCount; // Устанавливаем в locals
                        log.info(`[Session MW] Initial total unread MESSAGE count for ${username} (reader: ${readerId}): ${totalUnreadMessagesCount}. Set in res.locals.`);
                    } else {
                        log.warn(`[Session MW] Could not determine readerId for initial unread message count for ${username}`);
                        res.locals.totalUnreadChatCount = 0;
                    }
                } catch (chatCountError) {
                    log.error(`[Session MW] Error getting initial chat message count for ${username}:`, chatCountError);
                    res.locals.totalUnreadChatCount = 0; // В случае ошибки ставим 0
                }
                // *** КОНЕЦ ИЗМЕНЕНИЯ ***

                // Обновляем сессию и locals
                req.session.user = updatedSessionUser;
                res.locals.currentUser = updatedSessionUser;
                req.session.save(err => { if (err) log.error(`[Session MW] Error persisting updated session for ${username}:`, err); });

            } else { // Пользователь из сессии не найден в БД
                log.warn(`[Session MW] User ${username} not found in DB. Destroying session.`);
                return req.session.destroy((err) => { if (err) log.error("[Session MW] Error destroying session:", err); res.clearCookie('connect.sid'); res.redirect('/login'); });
            }
        } catch (error) { // Ошибка при получении данных из БД
            log.error(`[Session MW] Error fetching/processing session data for ${username}:`, error);
            res.locals.currentUser = req.session.user; // Используем старые данные
            res.locals.totalUnreadChatCount = 0; // Считаем 0 при ошибке
            log.info(`[Session MW] Error occurred. Setting totalUnreadChatCount to 0 for ${username}`);
        }
    } else { // Пользователя нет в сессии
         res.locals.currentUser = null;
         res.locals.totalUnreadChatCount = 0;
         log.debug(`[Session MW] No user in session. Setting totalUnreadChatCount to 0.`);
    }
    next();
});

// --- Глобальные Middleware для Owner ---
app.use(checkCompanyProfile);
app.use(ensureCompanyExists);

// --- Маршруты ---
app.use(authRoutes);
app.use('/properties', propertyRoutes); // Используем префикс
app.use('/bookings', bookingRoutes); // Используем префикс
app.use('/users', userRoutes); // Используем префикс
app.use('/rentals', rentalRoutes); // Используем префикс
app.use('/company', companyRoutes); // Используем префикс
app.use(chatRoutes); // Без префикса '/chats', т.к. они уже там

// === НОВЫЙ МАРШРУТ: Страница всех задач ===
app.get('/tasks', async (req, res, next) => {
    if (!res.locals.currentUser) {
        req.session.message = { type: 'error', text: 'Требуется авторизация.' };
        return req.session.save(() => res.redirect('/login'));
    }
    const currentUser = res.locals.currentUser;
    let allTasks = [];
    let pageTitle = 'Мои задачи';

    try {
        log.info(`[GET /tasks] Loading all tasks for ${currentUser.username} (${currentUser.role})`);

        if (currentUser.role === 'Tenant') {
             pageTitle = 'Задачи по бронированиям';
             // Для Tenant задачи - это предстоящие заезды/выезды
             const bookings = await firebaseService.getBookingsByUserId(currentUser.username);
             const activeBookings = bookings.filter(b => b.Status === 'Активна');
             const today = new Date(); today.setHours(0,0,0,0);
             const futureLimit = new Date(today); futureLimit.setDate(today.getDate() + 30); // Смотрим на 30 дней вперед

             const taskPromises = activeBookings.map(async b => {
                 const property = await firebaseService.getPropertyById(b.PropertyId).catch(() => null);
                 const checkInTask = {
                     id: `checkin-${b.Id}`,
                     type: 'check-in',
                     details: `Заезд в "${property?.Title || 'Неизв. объект'}"`,
                     link: `/bookings#booking-${b.Id}`,
                     date: b.StartDate
                 };
                 const checkOutTask = {
                    id: `checkout-${b.Id}`,
                    type: 'check-out',
                    details: `Выезд из "${property?.Title || 'Неизв. объект'}"`,
                    link: `/bookings#booking-${b.Id}`,
                    date: b.EndDate
                 };
                 return [checkInTask, checkOutTask];
             });
             const taskPairs = await Promise.all(taskPromises);
             allTasks = taskPairs.flat().filter(task => {
                 const taskDate = task.date ? new Date(task.date) : null;
                 return taskDate && taskDate >= today && taskDate <= futureLimit;
             });
             allTasks.sort((a, b) => new Date(a.date) - new Date(b.date)); // Сортируем по дате

        } else if ((currentUser.role === 'Owner' || currentUser.role === 'Staff') && currentUser.companyId) {
             pageTitle = 'Задачи компании';
             const companyId = currentUser.companyId;
             const ownerUserId = currentUser.username;

             // 1. Непрочитанные сообщения (без лимита)
             try {
                 const userChats = await firebaseService.getUserChats(ownerUserId, companyId);
                 const unreadTasks = await Promise.all(userChats
                    .filter(chat => chat?.unreadCounts?.[companyId] > 0)
                    .map(async chat => {
                        let senderName = 'пользователя';
                        if (chat?.lastMessageSenderId) {
                            const sender = await firebaseService.getUserByUsername(chat.lastMessageSenderId).catch(()=>null);
                            senderName = sender?.FullName || chat.lastMessageSenderId;
                        }
                         let detailsText = `Сообщение от ${senderName}`;
                         if (chat.propertyId) { /* ... добавить детали объекта ... */ }
                         return { id: `msg-${chat.id}`, type: 'new-message', details: detailsText, link: `/chats/${chat.id}`, date: chat.lastMessageTimestamp ? new Date(chat.lastMessageTimestamp) : new Date(0) };
                    })
                 );
                 allTasks.push(...unreadTasks.filter(Boolean));
             } catch(e){ log.error('[GET /tasks] Error fetching messages', e); }

             // 2. Ожидающие брони (все)
             try {
                 const pendingBookings = await firebaseService.getBookingsByStatus('Ожидает подтверждения', companyId);
                 const pendingTasks = await Promise.all(pendingBookings.map(async b => {
                     const property = await firebaseService.getPropertyById(b.PropertyId).catch(()=>null);
                     const tenant = await firebaseService.getUserByUsername(b.UserId).catch(()=>null);
                     return { id: `book-${b.Id}`, type: 'pending-booking', details: `Заявка: "${property?.Title || '?'}" от ${tenant?.FullName || b.UserId}`, link: `/rentals#booking-${b.Id}`, date: b.CreatedAt ? new Date(b.CreatedAt) : new Date(0) };
                 }));
                 allTasks.push(...pendingTasks.filter(Boolean));
             } catch(e){ log.error('[GET /tasks] Error fetching pending bookings', e); }

             // 3. Заезды/выезды (на 30 дней вперед)
              try {
                 const upcomingData = await firebaseService.getUpcomingCheckInsOuts(companyId, 30);
                 const checkInOutTasks = await Promise.all([
                     ...upcomingData.checkIns.map(async b => {
                         const property = await firebaseService.getPropertyById(b.PropertyId).catch(()=>null);
                         const tenant = await firebaseService.getUserByUsername(b.UserId).catch(()=>null);
                         return { id: `checkin-${b.Id}`, type: 'check-in', details: `Заезд: ${tenant?.FullName || b.UserId} в "${property?.Title || '?'}"`, link: `/rentals#booking-${b.Id}`, date: b.StartDate ? new Date(b.StartDate) : null };
                     }),
                     ...upcomingData.checkOuts.map(async b => {
                         const property = await firebaseService.getPropertyById(b.PropertyId).catch(()=>null);
                         const tenant = await firebaseService.getUserByUsername(b.UserId).catch(()=>null);
                         return { id: `checkout-${b.Id}`, type: 'check-out', details: `Выезд: ${tenant?.FullName || b.UserId} из "${property?.Title || '?'}"`, link: `/rentals#booking-${b.Id}`, date: b.EndDate ? new Date(b.EndDate) : null };
                     })
                 ]);
                 allTasks.push(...checkInOutTasks.filter(task => task && task.date)); // Добавляем только валидные
             } catch(e){ log.error('[GET /tasks] Error fetching checkins/outs', e); }

             // Сортируем все задачи по дате (самые новые/ближайшие сверху)
             allTasks.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));

        } else {
            // Для админа или других ролей пока задач нет
             pageTitle = 'Задачи';
        }

        res.render('tasks', { title: pageTitle, tasks: allTasks });

    } catch (error) {
        log.error(`[GET /tasks] Error loading tasks page for ${currentUser.username}:`, error);
        next(error);
    }
});
// === КОНЕЦ НОВОГО МАРШРУТА ===

// --- Базовый маршрут (Dashboard) ---
app.get('/', async (req, res, next) => {
    if (!res.locals.currentUser) {
        try { return res.render('index', { title: 'Добро пожаловать' }); }
        catch (renderError) { log.error("Error rendering index.ejs:", renderError); return next(renderError); }
    }
    const currentUser = res.locals.currentUser;
    let dashboardData = { role: currentUser.role, actionableItems: [], tasks: [] }; // <--- Добавляем tasks: []

    try {
        log.info(`[Dashboard GET] Loading data for ${currentUser.username} (${currentUser.role})`);
        // --- Переменные для актуальных задач ---
        dashboardData.actionableItems = []; // Инициализируем пустой массив
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

        // --- Логика Дашборда (загрузка данных в зависимости от роли) ---
        if (currentUser.role === 'Tenant') {
            const [balance, bookings] = await Promise.all([
                firebaseService.getUserByUsername(currentUser.username).then(u => u?.Balance ?? 0),
                firebaseService.getBookingsByUserId(currentUser.username)
            ]);
            dashboardData.balance = balance;
            dashboardData.totalBookingsCount = bookings.length;
            const activeBookings = bookings.filter(b => b.Status === 'Активна');
            dashboardData.activeBookingsCount = activeBookings.length;

            // Находим ближайшее событие (заезд или выезд)
            let nextEventDate = null;
            const today = new Date(); today.setHours(0,0,0,0);
            activeBookings.forEach(b => {
                const startDate = b.StartDate ? new Date(b.StartDate) : null;
                const endDate = b.EndDate ? new Date(b.EndDate) : null;
                if (startDate && startDate >= today) {
                    if (!nextEventDate || startDate < nextEventDate) {
                        nextEventDate = startDate;
                    }
                }
                 if (endDate && endDate >= today) {
                    // Выезд учитываем только если он ПОСЛЕ ближайшего заезда (или если заездов нет)
                    if (!nextEventDate || endDate < nextEventDate) {
                         nextEventDate = endDate;
                    }
                }
            });
            dashboardData.nextEventDateFormatted = nextEventDate
                 ? nextEventDate.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })
                 : null;

             // Оставляем недавние активные брони для таблицы
             const activeBookingsWithDetails = await Promise.all(activeBookings
                .sort((a, b) => new Date(b.StartDate || 0) - new Date(a.StartDate || 0)) // Сортируем по дате заезда (новые сверху)
                .slice(0, 3) // Берем 3 последних активных
                .map(async b => {
                    const prop = await firebaseService.getPropertyById(b.PropertyId).catch(()=>null);
                    return { ...b, PropertyTitle: prop?.Title || 'Объект удален', StartDateFormatted: b.StartDate ? new Date(b.StartDate).toLocaleDateString('ru-RU') : '-', EndDateFormatted: b.EndDate ? new Date(b.EndDate).toLocaleDateString('ru-RU') : '-'};
             }));
             dashboardData.recentActiveBookings = activeBookingsWithDetails;

        } else if ((currentUser.role === 'Owner' || currentUser.role === 'Staff') && currentUser.companyId) {
            const companyId = currentUser.companyId;
             const [company, properties, allBookings, users] = await Promise.all([
                 firebaseService.getCompanyById(companyId),
                 firebaseService.getPropertiesByCompanyId(companyId),
                 firebaseService.getAllBookings(),
                 firebaseService.getAllUsers() // Для имен арендаторов
             ]);
             dashboardData.companyName = company?.companyName || 'Моя компания';
             dashboardData.companyBalance = company?.Balance ?? 0;
             dashboardData.totalProperties = properties.length;
             dashboardData.availableProperties = properties.filter(p => p.IsAvailable).length;
             const companyPropertyIds = properties.map(p => p.Id);
             const companyBookings = allBookings.filter(b => companyPropertyIds.includes(b.PropertyId));
             dashboardData.totalRentalsCount = companyBookings.length;
             dashboardData.activeRentalsCount = companyBookings.filter(b => b.Status === 'Активна').length;
              // Добавим детали последних броней (любых статусов)
             const usersMap = new Map(users.map(u => [u.Username, u.FullName || u.Username]));
             const propertiesMap = new Map(properties.map(p => [p.Id, p.Title]));
             const recentBookings = companyBookings
                 .sort((a, b) => new Date(b.CreatedAt || 0) - new Date(a.CreatedAt || 0)) // Сортируем по дате создания
                 .slice(0, 5) // Берем 5 последних
                 .map(b => ({
                     ...b,
                     PropertyTitle: propertiesMap.get(b.PropertyId) || 'Объект удален',
                     TenantName: usersMap.get(b.UserId) || 'Неизвестный',
                     StartDateFormatted: b.StartDate ? new Date(b.StartDate).toLocaleDateString('ru-RU') : '-',
                     EndDateFormatted: b.EndDate ? new Date(b.EndDate).toLocaleDateString('ru-RU') : '-',
                 }));
             dashboardData.recentBookings = recentBookings;

             // ---> ДОБАВЛЕНО: Поиск актуальных задач для Owner/Staff <--- 
             const pendingBookings = companyBookings.filter(b => b.Status === 'Ожидает подтверждения');
             pendingBookings.forEach(b => {
                 const propertyTitle = propertiesMap.get(b.PropertyId) || 'Неизвестный объект';
                 const tenantName = usersMap.get(b.UserId) || 'Неизвестный';
                 dashboardData.actionableItems.push({ type: 'pending-booking', text: `Новый запрос на бронирование объекта "${propertyTitle}" от ${tenantName}`, link: `/rentals#booking-${b.Id}` }); // Ссылка на Упр. Арендами
             });

             const activeCompanyBookings = companyBookings.filter(b => b.Status === 'Активна');
             activeCompanyBookings.forEach(b => {
                 const startDate = b.StartDate ? new Date(b.StartDate) : null;
                 const endDate = b.EndDate ? new Date(b.EndDate) : null;
                 const propertyTitle = propertiesMap.get(b.PropertyId) || 'Неизвестный объект';
                 const tenantName = usersMap.get(b.UserId) || 'Неизвестный';
                 if (startDate && startDate >= todayStart && startDate <= todayEnd) {
                     dashboardData.actionableItems.push({ type: 'check-in', text: `Заезд сегодня: ${tenantName} в объект "${propertyTitle}"`, link: `/rentals#booking-${b.Id}` });
                 }
                 if (endDate && endDate >= todayStart && endDate <= todayEnd) {
                      dashboardData.actionableItems.push({ type: 'check-out', text: `Выезд сегодня: ${tenantName} из объекта "${propertyTitle}"`, link: `/rentals#booking-${b.Id}` });
                 }
             });
             // ---> КОНЕЦ ДОБАВЛЕНИЯ <--- 

             // === СБОР ЗАДАЧ для Owner/Staff ===
             dashboardData.tasks = []; // Инициализируем массив задач
             const ownerUserId = currentUser.username;

             // 1. Непрочитанные сообщения
             try {
                 const userChats = await firebaseService.getUserChats(ownerUserId, companyId);
                 const unreadMessagesTasks = await Promise.all(userChats
                    .filter(chat => chat?.unreadCounts?.[companyId] > 0)
                    .map(async (chat) => {
                        let senderName = 'пользователя'; // Дефолтное значение
                        if (chat?.lastMessageSenderId) {
                            const sender = await firebaseService.getUserByUsername(chat.lastMessageSenderId).catch(() => null);
                            senderName = sender?.FullName || chat.lastMessageSenderId;
                        }
                        // ИСПРАВЛЕНО: Текст задачи для сообщения
                        let detailsText = `Новое сообщение от ${senderName}`;
                        if (chat.propertyId) {
                            const prop = await firebaseService.getPropertyById(chat.propertyId).catch(()=>null);
                            if(prop?.Title) detailsText += ` (Объект: ${prop.Title.substring(0,15)}...)`;
                        } else if (chat.bookingId) {
                             detailsText += ` (Бронь #${chat.bookingId.substring(0,4)}...)`;
                        }

                        return {
                            id: `msg-${chat.id}`,
                            type: 'new-message',
                            details: detailsText.length > 50 ? detailsText.substring(0, 47) + '...' : detailsText, // Обрезаем длинный текст
                            link: `/chats/${chat.id}`, // Прямая ссылка на чат
                            time: chat.lastMessageTimestamp ? new Date(chat.lastMessageTimestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute:'2-digit' }) : ''
                        };
                    })
                 );
                 // Фильтруем null значения (если возникли ошибки при получении sender/prop)
                 const validUnreadTasks = unreadMessagesTasks.filter(Boolean);
                 // Сортируем по времени
                 validUnreadTasks.sort((a, b) => (b.time && a.time) ? new Date(`1970-01-01T${b.time}:00Z`).getTime() - new Date(`1970-01-01T${a.time}:00Z`).getTime() : 0);
                 dashboardData.tasks.push(...validUnreadTasks);
             } catch(err) {
                log.error('[Dashboard Tasks] Error fetching unread messages:', err);
             }

            // 2. Ожидающие подтверждения бронирования
            try {
                const pendingBookings = await firebaseService.getBookingsByStatus('Ожидает подтверждения', companyId);
                const populatedPendingBookings = await Promise.all(pendingBookings.map(async (booking) => {
                    const property = await firebaseService.getPropertyById(booking.PropertyId).catch(() => null);
                    const tenant = await firebaseService.getUserByUsername(booking.UserId).catch(() => null);
                    return {
                        ...booking,
                        PropertyTitle: property?.Title || 'Неизв. объект',
                        TenantName: tenant?.FullName || booking.UserId
                    };
                }));

                const pendingBookingTasks = populatedPendingBookings.map(booking => {
                    // ИСПРАВЛЕНО: Текст задачи для бронирования
                    let detailsText = `Заявка: "${booking.PropertyTitle}" от ${booking.TenantName}`;
                     return {
                         id: `book-${booking.Id}`,
                         type: 'pending-booking',
                         details: detailsText.length > 50 ? detailsText.substring(0, 47) + '...' : detailsText, // Обрезаем
                         link: `/rentals#booking-${booking.Id}`,
                         time: booking.CreatedAt ? new Date(booking.CreatedAt).toLocaleDateString('ru-RU') : ''
                     };
                 }).sort((a, b) => {
                    // Сортировка по дате (YYYY-MM-DD -> Date)
                    const dateA = a.time ? new Date(a.time.split('.').reverse().join('-')) : 0;
                    const dateB = b.time ? new Date(b.time.split('.').reverse().join('-')) : 0;
                    return (dateB || 0) - (dateA || 0);
                 });
                 dashboardData.tasks.push(...pendingBookingTasks);
            } catch(err) {
                log.error('[Dashboard Tasks] Error fetching pending bookings:', err);
            }

            // 3. Предстоящие/Сегодняшние Заезды и Выезды
             try {
                const upcomingData = await firebaseService.getUpcomingCheckInsOuts(companyId, 2);
                const { checkIns = [], checkOuts = [] } = upcomingData || {};

                const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
                const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
                const tomorrowStart = new Date(todayStart); tomorrowStart.setDate(todayStart.getDate() + 1);
                const tomorrowEnd = new Date(todayEnd); tomorrowEnd.setDate(todayEnd.getDate() + 1);

                // Обработка заездов
                const checkInTasks = await Promise.all(checkIns.map(async b => {
                    const startDate = b.StartDate ? new Date(b.StartDate) : null;
                    if (!startDate) return null;

                    let timeText = '';
                    if (startDate >= todayStart && startDate <= todayEnd) timeText = 'Сегодня';
                    else if (startDate >= tomorrowStart && startDate <= tomorrowEnd) timeText = 'Завтра';
                    if (!timeText) return null;

                    // Дополняем информацией
                    const property = await firebaseService.getPropertyById(b.PropertyId).catch(() => null);
                    const tenant = await firebaseService.getUserByUsername(b.UserId).catch(() => null);
                    const tenantName = tenant?.FullName || b.UserId;
                    const propertyTitle = property?.Title || 'Неизв. объект';

                    // ИСПРАВЛЕНО: Текст задачи для заезда
                    let detailsText = `Заезд: ${tenantName} в "${propertyTitle}"`;
                    return {
                        id: `checkin-${b.Id}`,
                        type: 'check-in',
                        details: detailsText.length > 50 ? detailsText.substring(0, 47) + '...' : detailsText, // Обрезаем
                        link: `/rentals#booking-${b.Id}`,
                        time: timeText
                    };
                }));
                dashboardData.tasks.push(...checkInTasks.filter(Boolean));

                // Обработка выездов
                const checkOutTasks = await Promise.all(checkOuts.map(async b => {
                    const endDate = b.EndDate ? new Date(b.EndDate) : null;
                    if (!endDate) return null;

                    let timeText = '';
                    if (endDate >= todayStart && endDate <= todayEnd) timeText = 'Сегодня';
                    else if (endDate >= tomorrowStart && endDate <= tomorrowEnd) timeText = 'Завтра';
                    if (!timeText) return null;

                     // Дополняем информацией
                    const property = await firebaseService.getPropertyById(b.PropertyId).catch(() => null);
                    const tenant = await firebaseService.getUserByUsername(b.UserId).catch(() => null);
                    const tenantName = tenant?.FullName || b.UserId;
                    const propertyTitle = property?.Title || 'Неизв. объект';

                    // ИСПРАВЛЕНО: Текст задачи для выезда
                    let detailsText = `Выезд: ${tenantName} из "${propertyTitle}"`;
                    return {
                        id: `checkout-${b.Id}`,
                        type: 'check-out',
                        details: detailsText.length > 50 ? detailsText.substring(0, 47) + '...' : detailsText, // Обрезаем
                        link: `/rentals#booking-${b.Id}`,
                        time: timeText
                    };
                }));
                dashboardData.tasks.push(...checkOutTasks.filter(Boolean));

                 // ОБЩАЯ СОРТИРОВКА ЗАДАЧ (Сначала Заезды/Выезды Сегодня/Завтра, потом Сообщения, потом Заявки)
                 dashboardData.tasks.sort((a, b) => {
                     const typeOrder = { 'check-in': 1, 'check-out': 1, 'new-message': 2, 'pending-booking': 3 };
                     const timeOrder = { 'Сегодня': 1, 'Завтра': 2 };

                     const orderA = typeOrder[a.type] || 4;
                     const orderB = typeOrder[b.type] || 4;

                     if (orderA !== orderB) return orderA - orderB; // Сортируем по типу

                     // Если тип check-in/out, сортируем по Сегодня/Завтра
                     if (orderA === 1) {
                         const timeA = timeOrder[a.time] || 3;
                         const timeB = timeOrder[b.time] || 3;
                         if (timeA !== timeB) return timeA - timeB;
                     }

                     // Если тип Сообщение, сортируем по времени (Date object)
                     if (orderA === 2) {
                         return (b.date?.getTime() || 0) - (a.date?.getTime() || 0);
                     }

                     // Если тип Заявка, сортируем по времени (Date object)
                     if (orderA === 3) {
                         return (b.date?.getTime() || 0) - (a.date?.getTime() || 0);
                     }

                     return 0; // Для одинаковых типов без доп. сортировки
                 });

            } catch (err) {
                 log.error('[Dashboard Tasks] Error fetching check-ins/outs:', err);
            }

            // ИСПРАВЛЕНО: Ограничиваем количество задач до 3
            dashboardData.tasks = dashboardData.tasks.slice(0, 3);

        } else if (currentUser.role === 'Admin') {
            const [users, properties, bookings] = await Promise.all([
                 firebaseService.getAllUsers(),
                 firebaseService.getAllProperties(),
                 firebaseService.getAllBookings()
             ]);
             dashboardData.totalUsers = users.length;
             dashboardData.totalProperties = properties.length;
             dashboardData.totalBookings = bookings.length;
             dashboardData.activeBookings = bookings.filter(b => b.Status === 'Активна').length;
        }
        res.render('dashboard', { title: 'Панель управления', dashboardData });
    } catch (error) {
        log.error("[Dashboard GET] Error loading dashboard data:", error);
        res.status(500).render('dashboard', { title: 'Ошибка', dashboardData: { role: currentUser?.role || 'Unknown', error: 'Не удалось загрузить данные.' } });
    }
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
    // Рендерим с передачей currentUser для шапки
    res.status(statusCode).render('error', { title: `Ошибка ${statusCode}`, message: errorMessage, currentUser: res.locals.currentUser });
});

// --- Логика Socket.IO ---
const userSockets = {}; // { username: socketId }
app.set('userSockets', userSockets); // Делаем доступным в роутах

/**
 * Вычисляет общий счетчик непрочитанных чатов для пользователя.
 * @param {string} userId Логин пользователя.
 * @param {string|null} companyId ID компании (если применимо).
 * @returns {Promise<number>} Общее количество непрочитанных чатов.
 */
async function calculateTotalUnreadChats(userId, companyId) {
    let totalUnread = 0;
    try {
        const readerId = (await firebaseService.getUserByUsername(userId))?.Role === 'Tenant' ? userId : companyId;
        if (!readerId) return 0;
        const userChats = await firebaseService.getUserChats(userId, companyId);
        userChats.forEach(chat => {
            if (chat && chat.unreadCounts && chat.unreadCounts[readerId] && chat.unreadCounts[readerId] > 0) {
                totalUnread += chat.unreadCounts[readerId]; // Суммируем реальные числа непрочитанных
            }
        });
        log.debug(`[calculateTotalUnreadChats] User: ${userId}, Reader: ${readerId}, Total unread chats: ${totalUnread}`);
    } catch (error) {
        log.error(`[calculateTotalUnreadChats] Error for user ${userId}:`, error);
    }
    return totalUnread;
}

io.on('connection', (socket) => {
    const socketId = socket.id;
    log.info(`[Socket.IO] Клиент подключился: ${socketId}`);
    let associatedUserId = null;
    let initialDataSent = false;

    // --- Функция для отправки начальных данных (счетчики + уведомления) ---
    const sendInitialData = async (userId) => {
         if (!userId || initialDataSent) return;
         log.info(`[Socket.IO] Отправка начальных данных для ${userId} (сокет ${socketId})`);
         initialDataSent = true; // Ставим флаг, чтобы не отправлять повторно
         try {
              // Отправляем общий счетчик непрочитанных ЧАТОВ
              const totalUnreadChatCount = await calculateTotalUnreadChats(userId, socket.request.session?.user?.companyId);
              socket.emit('total_unread_update', { totalUnreadCount: totalUnreadChatCount, timestamp: Date.now() });
              log.debug(`[Socket.IO]   -> total_unread_update: ${totalUnreadChatCount}`);

             // --- ИЗМЕНЕНИЕ: Отправка уведомлений (колокольчик) ---
             const notifications = await firebaseService.getLastNotifications(userId, 15); // Загружаем последние 15
             socket.emit('initial_notifications', notifications);
             log.debug(`[Socket.IO]   -> initial_notifications sent: ${notifications.length} items.`);
             // --- КОНЕЦ ИЗМЕНЕНИЯ ---

         } catch (error) { log.error(`[Socket.IO] Ошибка при отправке начальных данных для ${userId}:`, error); }
    };

    // --- Ассоциация пользователя с сокетом при подключении (из сессии) ---
    const session = socket.request.session;
    if (session && session.user && session.user.username) {
         session.reload((err) => { // Перезагружаем сессию для актуальности
             if (err) { log.error(`[Socket.IO] Ошибка перезагрузки сессии для ${socketId}:`, err); return; }
             const socketUser = session.user; // Используем актуальные данные
             if (socketUser && socketUser.username) {
                 associatedUserId = socketUser.username;
                 const oldSocketId = userSockets[associatedUserId];
                 if (oldSocketId && oldSocketId !== socketId) { io.sockets.sockets.get(oldSocketId)?.disconnect(true); }
                 userSockets[associatedUserId] = socketId;
                 socket.userId = associatedUserId;
                 socket.join(`user:${associatedUserId}`); // Присоединяем к комнате
                 log.info(`[Socket.IO] Пользователь ${associatedUserId} ассоциирован (сессия). Сокет ${socketId} в комнате user:${associatedUserId}.`);
                 sendInitialData(associatedUserId); // Отправляем начальные данные
             } else { log.warn(`[Socket.IO] Пользователь не найден в сессии после reload для ${socketId}.`); }
         });
    } else { log.warn(`[Socket.IO] Сессия или пользователь не найдены при подключении ${socketId}.`); }

    // --- Обработчик регистрации/перерегистрации ---
    socket.on('register_user', (userIdFromClient) => {
         if (userIdFromClient) {
             log.info(`[Socket.IO] Получено событие 'register_user': ${userIdFromClient} (сокет ${socketId})`);
             if (!associatedUserId || associatedUserId !== userIdFromClient) {
                 if (associatedUserId && userSockets[associatedUserId] === socketId) { delete userSockets[associatedUserId]; }
                 socket.rooms.forEach(room => { if (room !== socketId) socket.leave(room); });
                 associatedUserId = userIdFromClient;
                 userSockets[associatedUserId] = socketId;
                 socket.userId = associatedUserId;
                 socket.join(`user:${associatedUserId}`);
                 log.info(`[Socket.IO] Пользователь ${associatedUserId} зарегистрирован/перерегистрирован (событие). Сокет ${socketId} в комнате user:${associatedUserId}.`);
                 sendInitialData(associatedUserId); // Отправляем начальные данные при явной регистрации
             } else { log.debug(`[Socket.IO] Пользователь ${userIdFromClient} уже ассоциирован с этим сокетом.`); }
         } else { log.warn(`[Socket.IO] 'register_user' с пустым userId от ${socketId}.`); }
    });

    // --- Обработчик прочтения ЧАТА ---
    socket.on('mark_chat_read', async (chatId) => {
        const userId = socket.userId;
        log.info(`[Socket.IO] 'mark_chat_read' от ${userId} для чата ${chatId}`);
        if (!userId || !chatId) return;
        try {
            const user = await firebaseService.getUserByUsername(userId);
            if (!user) return;
            const readerId = (user.Role === 'Owner' || user.Role === 'Staff') ? user.companyId : userId;
            if (!readerId) { log.warn(`[mark_chat_read] Could not determine readerId for user ${userId}`); return; }

            const readTimestamp = Date.now();
            const success = await firebaseService.resetUnreadCountAndTimestamp(chatId, readerId, readTimestamp); // ИСПОЛЬЗУЕМ НОВУЮ ФУНКЦИЮ

            if (success) {
                 // Обновляем общий счетчик прочитавшего
                 const totalUnread = await calculateTotalUnreadChats(userId, user.companyId);
                 socket.emit('total_unread_update', { totalUnreadCount: totalUnread, timestamp: Date.now() });
                 log.debug(`[mark_chat_read] Sent total_unread_update to reader ${userId}: ${totalUnread}`);

                 // Отправляем событие 'messages_read_up_to' другим участникам
                 const chat = await firebaseService.getChatById(chatId);
                 if (chat && chat.participants) {
                     const participants = chat.participants || {};
                     const otherParticipantIds = Object.keys(participants).filter(pId => pId !== readerId); // ID ДРУГИХ участников

                     // Определяем username'ы ДРУГИХ участников для отправки сокет-события
                     const otherUsernamesToNotify = [];
                     for (const pId of otherParticipantIds) {
                         if (participants[pId]) { // Убедимся, что участник активен
                             const isCompany = !(pId.includes('@') || pId.length < 10); // Простой способ определить компанию
                             if (isCompany) {
                                  const company = await firebaseService.getCompanyById(pId).catch(e=>null);
                                  if (company) {
                                       if (company.ownerUsername) otherUsernamesToNotify.push(company.ownerUsername);
                                       if (company.staff) otherUsernamesToNotify.push(...Object.keys(company.staff));
                                  }
                             } else { otherUsernamesToNotify.push(pId); }
                         }
                     }
                     const finalUsernames = [...new Set(otherUsernamesToNotify)].filter(Boolean); // Уникальные имена

                     // Отправляем событие каждому ДРУГОМУ участнику
                     finalUsernames.forEach(username => {
                          if (username !== userId) { // Не отправляем себе
                              const userRoom = `user:${username}`;
                              io.to(userRoom).emit('messages_read_up_to', { chatId: chatId, readerId: readerId, readUpToTimestamp: readTimestamp });
                              log.info(`[Socket.IO] Emitted 'messages_read_up_to' to room ${userRoom} for chat ${chatId}`);
                          }
                     });
                 }
            } else { log.warn(`[mark_chat_read] Failed to reset unread count/timestamp for ${readerId} in chat ${chatId}`); }
        } catch (error) { log.error(`[Socket.IO] Ошибка в mark_chat_read для чата ${chatId}:`, error); }
    });

     // --- ИЗМЕНЕНИЕ: Обработчики для уведомлений (колокольчик) ---
     socket.on('mark_notifications_read', async (notificationIds) => {
         const userId = socket.userId;
         log.info(`[Socket.IO] 'mark_notifications_read' от ${userId} для IDs: ${notificationIds?.join(', ')}`);
         if (!userId || !Array.isArray(notificationIds) || notificationIds.length === 0) return;
         const success = await firebaseService.markNotificationsAsRead(userId, notificationIds);
         if (success) {
              // Можно отправить подтверждение или обновить счетчик, если нужно
              log.debug(`[Socket.IO] Уведомления помечены как прочитанные для ${userId}`);
              // Обновляем счетчик непрочитанных в шапке (колокольчик)
              const notifications = await firebaseService.getLastNotifications(userId);
              const unreadCountHeader = notifications.filter(n => !n.read).length;
              socket.emit('update_header_notification_badge', { count: unreadCountHeader }); // Новое событие
         }
     });

     socket.on('delete_notification', async (notificationId) => {
         const userId = socket.userId;
         log.info(`[Socket.IO] 'delete_notification' от ${userId} для ID: ${notificationId}`);
         if (!userId || !notificationId) return;
         const success = await firebaseService.deleteNotification(userId, notificationId);
         if (success) {
              log.debug(`[Socket.IO] Уведомление ${notificationId} удалено для ${userId}`);
              // Обновляем счетчик непрочитанных в шапке (колокольчик)
              const notifications = await firebaseService.getLastNotifications(userId);
              const unreadCountHeader = notifications.filter(n => !n.read).length;
              socket.emit('update_header_notification_badge', { count: unreadCountHeader }); // Новое событие
         }
     });

     socket.on('clear_all_notifications', async () => {
         const userId = socket.userId;
         log.info(`[Socket.IO] 'clear_all_notifications' от ${userId}`);
         if (!userId) return;
         const success = await firebaseService.clearAllNotificationsForUser(userId);
         if (success) {
              log.debug(`[Socket.IO] Все уведомления удалены для ${userId}`);
              // Обновляем счетчик непрочитанных в шапке (колокольчик)
              socket.emit('update_header_notification_badge', { count: 0 }); // Новое событие
         }
     });
     // --- КОНЕЦ ИЗМЕНЕНИЯ ---


    // --- Обработчик отключения ---
    socket.on('disconnect', (reason) => {
        log.info(`[Socket.IO] Клиент отключился: ${socketId}. Причина: ${reason}`);
        const userId = socket.userId;
        if (userId && userSockets[userId] === socketId) {
            log.info(`[Socket.IO] Удаление пользователя ${userId} (сокет ${socketId}) из реестра.`);
            delete userSockets[userId];
        } else if (userId) { log.warn(`[Socket.IO] Отключенный сокет ${socketId} не совпал с ${userSockets[userId]} для ${userId}.`); }
        else { let foundUserId = Object.keys(userSockets).find(uid => userSockets[uid] === socketId); if (foundUserId) { log.info(`[Socket.IO] Удаление пользователя ${foundUserId} (сокет ${socketId}) через поиск.`); delete userSockets[foundUserId]; } else { log.warn(`[Socket.IO] Не найден пользователь для отключенного сокета ${socketId}.`); } }
    });
});

// --- Запуск HTTP сервера ---
httpServer.listen(port, () => {
    log.info(`Сервер Express с Socket.IO запущен внутри Electron по адресу http://localhost:${port}`);
});

module.exports = httpServer; // Экспортируем сервер для возможного использования в main.js