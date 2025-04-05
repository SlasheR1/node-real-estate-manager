// middleware/authMiddleware.js

function isLoggedIn(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    // Добавим сообщение перед редиректом (флеш-сообщения)
    // req.session.message = { type: 'error', text: 'Пожалуйста, войдите для доступа к этой странице.' };
    res.redirect('/login');
}

function isLoggedOut(req, res, next) {
     if (!req.session || !req.session.user) {
        return next();
    }
    res.redirect('/');
}

// Проверяет, является ли пользователь админом ИЛИ владельцем
// (Для доступа к управлению объектами, которые им принадлежат, или всеми для админа)
function isAdminOrOwner(req, res, next) {
    if (!req.session || !req.session.user) {
        // req.session.message = { type: 'error', text: 'Доступ запрещен. Требуется авторизация.' };
        return res.redirect('/login');
    }
    const user = req.session.user;
    if (user.role === 'Admin' || user.role === 'Owner') {
        return next(); // Разрешаем доступ админам и владельцам
    }
    // У остальных нет доступа
    // req.session.message = { type: 'error', text: 'Доступ запрещен.' };
    res.status(403).render('error', { title: 'Доступ запрещен', message: 'У вас нет прав для выполнения этого действия.'}); // Отобразим страницу с ошибкой
}

// Проверяет, является ли пользователь ТОЛЬКО админом
function isAdmin(req, res, next) {
    if (!req.session || !req.session.user) {
        // req.session.message = { type: 'error', text: 'Доступ запрещен. Требуется авторизация.' };
        return res.redirect('/login');
    }
    if (req.session.user.role === 'Admin') {
        return next(); // Разрешаем доступ только админам
    }
    // У остальных нет доступа
    // req.session.message = { type: 'error', text: 'Доступ запрещен.' };
     res.status(403).render('error', { title: 'Доступ запрещен', message: 'Эта страница доступна только администраторам.'});
}


module.exports = {
    isLoggedIn,
    isLoggedOut,
    isAdminOrOwner, // Экспортируем новую функцию
    isAdmin
};