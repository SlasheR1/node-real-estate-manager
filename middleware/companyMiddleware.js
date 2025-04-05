// middleware/companyMiddleware.js
const firebaseService = require('../services/firebaseService');

// Middleware: Проверка принадлежности пользователя к целевой компании ИЛИ если он Admin
// Выполняется перед маршрутами, работающими с данными конкретной компании
async function isCompanyMemberOrAdmin(req, res, next) {
    const currentUser = req.session.user;
    console.log(`[isCompanyMemberOrAdmin] Checking access for ${req.originalUrl}`);
    console.log(`[isCompanyMemberOrAdmin] >>> req.params: ${JSON.stringify(req.params)}`);
    console.log(`[isCompanyMemberOrAdmin] >>> req.body: ${JSON.stringify(req.body)}`);
    console.log(`[isCompanyMemberOrAdmin] >>> req.query: ${JSON.stringify(req.query)}`);

    if (!currentUser) {
        console.log("[isCompanyMemberOrAdmin] No user in session. Redirecting to login.");
        return res.redirect('/login');
    }
    if (currentUser.role === 'Admin') {
        console.log("[isCompanyMemberOrAdmin] Admin access granted.");
        return next();
    }

    // Определяем ID целевой компании СНАЧАЛА из явных источников
    let targetCompanyId = req.params.companyId || req.body.companyId || req.query.id;
    console.log(`[isCompanyMemberOrAdmin] Initial targetCompanyId (params/body/query): ${targetCompanyId}`);

    // --- ИСПРАВЛЕННАЯ ЛОГИКА ОПРЕДЕЛЕНИЯ ПО ID ИЗ URL ---
    if (!targetCompanyId && req.params.id) {
        const resourceId = req.params.id;
        console.log(`[isCompanyMemberOrAdmin] Trying to determine companyId from req.params.id: ${resourceId}`);
        try {
            let propertyToCheck = null;

            // 1. Пытаемся получить как Property
            console.log(`[isCompanyMemberOrAdmin] Attempting to fetch as Property: ${resourceId}`);
            propertyToCheck = await firebaseService.getPropertyById(resourceId);

            // 2. Если не нашли как Property ИЛИ у найденного нет companyId, пытаемся как Booking
            if (!propertyToCheck?.companyId) {
                console.log(`[isCompanyMemberOrAdmin] Not a property or no companyId. Attempting to fetch as Booking: ${resourceId}`);
                const booking = await firebaseService.getBookingById(resourceId);
                if (booking?.PropertyId) {
                    console.log(`[isCompanyMemberOrAdmin] Booking found, getting associated Property: ${booking.PropertyId}`);
                    propertyToCheck = await firebaseService.getPropertyById(booking.PropertyId);
                } else {
                    console.log(`[isCompanyMemberOrAdmin] Booking not found or has no PropertyId.`);
                }
            }

            // 3. Извлекаем companyId из найденного property (если оно есть)
            targetCompanyId = propertyToCheck?.companyId;
            console.log(`[isCompanyMemberOrAdmin] Determined targetCompanyId from DB lookup: ${targetCompanyId}`);

        } catch (error) {
            console.error("[isCompanyMemberOrAdmin] CRITICAL ERROR determining target company:", error);
            // Оставляем targetCompanyId как undefined
        }
    // Логика для /company/* остается как была
    } else if (!targetCompanyId && req.baseUrl === '/company') { // Используем req.baseUrl ТОЛЬКО для /company
         targetCompanyId = currentUser.companyId;
         console.log(`[isCompanyMemberOrAdmin] Using user's session companyId for /company route: ${targetCompanyId}`);
    }
    // --- КОНЕЦ ИСПРАВЛЕННОЙ ЛОГИКИ ---


    // Финальная проверка
    if (!targetCompanyId) {
         console.warn(`[isCompanyMemberOrAdmin] Target Company ID is still UNDEFINED for user ${currentUser.username} at ${req.originalUrl}`);
         req.session.message = { type: 'error', text: 'Не удалось определить компанию для доступа.' };
         // Важно сохранить сессию ПЕРЕД редиректом
         return req.session.save(err => {
            if (err) console.error("Session save error in isCompanyMemberOrAdmin:", err);
            res.redirect('/');
         });
    }

    console.log(`[isCompanyMemberOrAdmin] Comparing user companyId (${currentUser.companyId}) with targetCompanyId (${targetCompanyId})`);
    if (currentUser.companyId === targetCompanyId) {
        console.log("[isCompanyMemberOrAdmin] Access GRANTED.");
        return next();
    }

    console.warn(`[isCompanyMemberOrAdmin] Access DENIED for user ${currentUser.username} (Company: ${currentUser.companyId}) to target company ${targetCompanyId} at ${req.originalUrl}`);
    req.session.message = { type: 'error', text: 'У вас нет доступа к данным этой компании.' };
    res.status(403);
    // Важно сохранить сессию ПЕРЕД редиректом
    return req.session.save(err => {
         if (err) console.error("Session save error in isCompanyMemberOrAdmin (Access Denied):", err);
         res.redirect('/');
    });
}
// Middleware: Убеждаемся, что у Owner'а создана запись о компании в /companies
// Если нет - создает её. Также добавляет companyId в сессию.
// Выполняется ПОСЛЕ checkCompanyProfile
async function ensureCompanyExists(req, res, next) {
    // Пропускаем не-владельцев и API запросы
    if (!req.session?.user || req.session.user.role !== 'Owner' || req.headers.accept?.includes('application/json')) {
        return next();
    }

    const ownerUsername = req.session.user.username;
    // ID компании = username владельца (для простоты уникальности)
    const companyId = ownerUsername;

    try {
        // 1. Проверяем/добавляем companyId в сессию пользователя
        if (!req.session.user.companyId) {
             req.session.user.companyId = companyId;
             console.log(`[ensureCompanyExists] Added companyId ${companyId} to session for user ${ownerUsername}.`);
        }

        // 2. Проверяем наличие узла компании в БД
        let company = await firebaseService.getCompanyById(companyId);

        if (!company) {
            // Создаем запись компании
            console.log(`[ensureCompanyExists] Company node not found for owner ${ownerUsername}. Creating...`);
            const userData = await firebaseService.getUserByUsername(ownerUsername); // Получаем данные пользователя
            const companyData = { // Формируем данные для создания компании
                 companyName: userData?.companyName || `${ownerUsername} Company`, // Берем имя из пользователя или дефолт
                 companyContactEmail: userData?.companyContactEmail,
                 companyContactPhone: userData?.companyContactPhone,
                 companyWebsite: userData?.companyWebsite,
                 companyLogoData: userData?.companyLogoData
            };
            company = await firebaseService.createCompany(companyId, ownerUsername, companyData);

            // Обновляем пользователя в БД, добавляя companyId (если его там не было)
            if (!userData?.companyId) {
                 await db.ref(`users/${ownerUsername}`).update({ companyId: companyId });
                 console.log(`[ensureCompanyExists] Added companyId to user ${ownerUsername} in DB.`);
            }
            // ВАЖНО: После создания компании, профиль пользователя ЕЩЕ НЕ ЗАВЕРШЕН
            // Флаг companyProfileCompleted ставится только после POST /company/setup

        }

        // 3. Обновляем имя компании в сессии, если оно там отсутствует, а в БД есть
        if (company?.companyName && !req.session.user.companyName) {
            req.session.user.companyName = company.companyName;
            console.log(`[ensureCompanyExists] Updated companyName in session for ${ownerUsername}.`);
        }
         // 4. Обновляем флаг завершенности профиля в сессии, если он есть в БД, но нет в сессии
         const profileCompletedInDB = (await firebaseService.getUserByUsername(ownerUsername))?.companyProfileCompleted === true;
         if (profileCompletedInDB && !req.session.user.companyProfileCompleted) {
              req.session.user.companyProfileCompleted = true;
              console.log(`[ensureCompanyExists] Updated companyProfileCompleted flag in session for ${ownerUsername}.`);
         }


        next(); // Переходим к следующему middleware или маршруту

    } catch (error) {
        console.error(`[ensureCompanyExists] Error ensuring company for ${ownerUsername}:`, error);
        // При ошибке лучше пропустить, чтобы не блокировать пользователя
        next();
    }
}


module.exports = {
    isCompanyMemberOrAdmin,
    ensureCompanyExists
};