// middleware/ownerMiddleware.js
const firebaseService = require('../services/firebaseService');

// Перенаправляет Owner'а на страницу настройки, если его профиль не завершен
async function checkCompanyProfile(req, res, next) {
    // Пропускаем: не Owner, нет сессии, запросы API, страницы настройки/выхода
    if (!req.session?.user ||
        req.session.user.role !== 'Owner' ||
        req.path.startsWith('/company/setup') || // Пропускаем новую страницу настройки
        req.path === '/logout' ||
        req.headers.accept?.includes('application/json'))
    {
        return next();
    }

    try {
        // Проверяем флаг сначала в сессии
        let profileComplete = req.session.user.companyProfileCompleted === true;

        // Если в сессии false или undefined, проверяем БД
        if (!profileComplete) {
            console.log(`[checkCompanyProfile] Re-checking profile completion in DB for ${req.session.user.username}`);
            const dbUser = await firebaseService.getUserByUsername(req.session.user.username);
            profileComplete = dbUser?.companyProfileCompleted === true;
            // Обновляем сессию, если в БД true, а в сессии не было
            if (profileComplete) {
                 req.session.user.companyProfileCompleted = true;
            }
        }

        // Если после всех проверок профиль НЕ завершен - редирект
        if (!profileComplete) {
            console.log(`[checkCompanyProfile] User ${req.session.user.username} needs company profile setup. Redirecting.`);
            // Добавляем сообщение только если это не GET запрос на саму страницу настройки
            if (req.method === 'GET' && !req.path.startsWith('/company/setup')) {
                 req.session.message = { type: 'info', text: 'Пожалуйста, завершите настройку профиля вашей компании.' };
            }
            // Сохраняем сессию перед редиректом
            return req.session.save(err => {
                 if(err) console.error("Session save error in checkCompanyProfile:", err);
                 res.redirect('/company/setup'); // Редирект на НОВУЮ страницу настройки
            });
        }

        // Профиль завершен, идем дальше
        return next();

    } catch (error) {
        console.error(`[checkCompanyProfile] Error for ${req.session.user.username}:`, error);
        return next(); // Пропускаем при ошибке
    }
}

module.exports = {
    checkCompanyProfile
};