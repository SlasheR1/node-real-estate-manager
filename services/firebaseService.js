// services/firebaseService.js
const admin = require('firebase-admin');
const db = admin.database();
const log = require('electron-log');

// --- Пользователи (Users) ---
async function getUserByUsername(username) {
    try {
        if (!username) return null; // Добавим проверку
        const snapshot = await db.ref(`users/${username}`).once('value');
        return snapshot.val();
    } catch (error) {
        console.error(`Error fetching user ${username}:`, error);
        // Не бросаем ошибку, чтобы Promise.allSettled мог её обработать
        return null; // Возвращаем null при ошибке
        // throw error; // Старый вариант
    }
}

async function getAllUsers() {
    try {
        const snapshot = await db.ref('users').once('value');
        const usersData = snapshot.val();
        return usersData ? Object.values(usersData) : [];
    } catch (error) {
        console.error("Error fetching all users:", error);
        throw error;
    }
}

async function saveUser(user) {
    try {
        if (!user || !user.username) throw new Error("User object must have a username.");
        // Удаляем поля, которые не должны быть в узле юзера (пример)
        // delete user.password; // Удаляем пароль перед сохранением, если он там есть
        // delete user.confirmPassword;
        await db.ref(`users/${user.username}`).set(user);
        console.log(`User ${user.username} saved/updated.`);
        return user; // Возвращаем сохраненные данные
    } catch (error) {
        console.error(`Error saving user ${user.username}:`, error);
        throw error;
    }
}

async function deleteUser(username) {
    try {
        if (!username) throw new Error("Username is required for deletion.");
        // Дополнительно: Нужно удалить пользователя из списка staff компании, если он там был
        const user = await getUserByUsername(username);
        if (user && user.companyId && user.Role === 'Staff') {
             await removeStaffFromCompany(user.companyId, username); // Вызываем удаление из компании
             console.log(`Removed deleted user ${username} from staff of company ${user.companyId}`);
        }
        await db.ref(`users/${username}`).remove();
        console.log(`User ${username} deleted.`);
    } catch (error) {
        console.error(`Error deleting user ${username}:`, error);
        throw error;
    }
}


// --- Компании (Companies) ---
async function getCompanyById(companyId) {
    try {
        if (!companyId) return null;
        const snapshot = await db.ref(`companies/${companyId}`).once('value');
        return snapshot.val();
    } catch (error) { console.error(`Error fetching company ${companyId}:`, error); throw error; }
}

async function createCompany(companyId, ownerUsername, companyData) {
    try {
        if (!companyId || !ownerUsername || !companyData || !companyData.companyName) { throw new Error("Missing required data for company creation."); }
        const initialCompany = {
            companyId: companyId, ownerUsername: ownerUsername,
            companyName: companyData.companyName.trim(),
            companyContactEmail: companyData.companyContactEmail || null,
            companyContactPhone: companyData.companyContactPhone || null,
            companyWebsite: companyData.companyWebsite || null,
            companyLogoData: companyData.companyLogoData || null,
            Balance: 0, balanceHistory: {}, staff: {}
        };
        await db.ref(`companies/${companyId}`).set(initialCompany);
        console.log(`Company ${companyId} created for ${ownerUsername}`);
        return initialCompany;
    } catch (error) { console.error(`Error creating company ${companyId}:`, error); throw error; }
}

async function updateCompany(companyId, updates) {
    try {
        if (!companyId || !updates) { throw new Error("Missing companyId or updates."); }
        // Дополнительно: можно удалить undefined поля из updates перед сохранением
        Object.keys(updates).forEach(key => updates[key] === undefined && delete updates[key]);
        if (Object.keys(updates).length === 0) { console.warn(`No valid updates provided for company ${companyId}.`); return; }
        await db.ref(`companies/${companyId}`).update(updates);
        console.log(`Company ${companyId} updated.`);
    } catch (error) { console.error(`Error updating company ${companyId}:`, error); throw error; }
}

async function addStaffToCompany(companyId, staffUsername) {
    try {
        if (!companyId || !staffUsername) { throw new Error("Missing companyId or staffUsername."); }
        const updates = {};
        updates[`/companies/${companyId}/staff/${staffUsername}`] = true;
        updates[`/users/${staffUsername}/companyId`] = companyId;
        updates[`/users/${staffUsername}/Role`] = 'Staff';
        await db.ref().update(updates); console.log(`Staff ${staffUsername} added to company ${companyId}`);
    } catch (error) { console.error(`Error adding staff ${staffUsername} to ${companyId}:`, error); throw error; }
}

async function removeStaffFromCompany(companyId, staffUsername) {
    try {
        if (!companyId || !staffUsername) { throw new Error("Missing companyId or staffUsername."); }
        const updates = {};
        updates[`/companies/${companyId}/staff/${staffUsername}`] = null;
        updates[`/users/${staffUsername}/companyId`] = null;
        updates[`/users/${staffUsername}/Role`] = 'Tenant'; // Возвращаем роль по умолчанию
        await db.ref().update(updates); console.log(`Staff ${staffUsername} removed from company ${companyId}`);
    } catch (error) { console.error(`Error removing staff ${staffUsername} from ${companyId}:`, error); throw error; }
}

async function updateCompanyBalance(companyId, amountToAdd, operationType, description) {
    const companyRef = db.ref(`companies/${companyId}`);
    try {
        if (!companyId) throw new Error("Company ID required.");
        if (typeof amountToAdd !== 'number' || isNaN(amountToAdd)) throw new Error("Amount must be number.");

        const transactionResult = await companyRef.transaction(currentData => {
            if (currentData === null) { return undefined; } // Важно вернуть undefined для отмены транзакции Firebase
            const currentBalance = currentData.Balance || 0;
            const newBalance = parseFloat((currentBalance + amountToAdd).toFixed(2));
            currentData.Balance = newBalance;
            if (!currentData.balanceHistory) { currentData.balanceHistory = {}; }
            const historyRef = companyRef.child('balanceHistory').push();
            currentData.balanceHistory[historyRef.key] = {
                Id: historyRef.key, Date: new Date().toISOString(), Amount: amountToAdd,
                OperationType: operationType || "Не указано", Description: description || "-", NewBalance: newBalance
            };
            return currentData;
        });

        if (!transactionResult.committed || !transactionResult.snapshot.exists()) { throw new Error(`Company ${companyId} not found or balance transaction failed.`); }
        const finalBalance = transactionResult.snapshot.val().Balance;
        console.log(`Company ${companyId} balance updated by ${amountToAdd}. New balance: ${finalBalance}`);
        return finalBalance;
    } catch (error) { console.error(`Error updating balance for company ${companyId}:`, error); throw error; }
}


// --- Объекты (Properties) ---
async function getPropertyById(propertyId) {
    console.log(`[getPropertyById] START - Запрос для ID: ${propertyId}`); // Лог 1
    try {
        if (!propertyId) {
            console.warn("[getPropertyById] ID не предоставлен.");
            return null;
        }
        const propertyRef = db.ref(`properties/${propertyId}`);
        console.log(`[getPropertyById] Получена ссылка: ${propertyRef.toString()}`); // Лог 2
        const snapshot = await propertyRef.once('value');
        console.log(`[getPropertyById] Снэпшот получен. Существует? ${snapshot.exists()}`); // Лог 3

        if (!snapshot.exists()) {
            console.warn(`[getPropertyById] Снэпшот для ${propertyId} НЕ СУЩЕСТВУЕТ.`);
            return null;
        }

        const propertyData = snapshot.val();
        console.log(`[getPropertyById] Полученные данные (сырые):`, propertyData); // Лог 4 - Важный!

        // Проверяем наличие companyId ДО возврата
        if (propertyData && typeof propertyData === 'object') {
            console.log(`[getPropertyById] Проверка companyId в данных: ${propertyData.companyId}`); // Лог 5
            propertyData.Id = propertyId; // Добавляем ID для консистентности
            return propertyData;
        } else {
            console.error(`[getPropertyById] Неожиданный формат данных для ${propertyId}:`, typeof propertyData);
            return null; // Возвращаем null, если данные не объект
        }

    } catch (error) {
        console.error(`[getPropertyById] КРИТИЧЕСКАЯ ОШИБКА при запросе ${propertyId}:`, error);
        // Не пробрасываем ошибку дальше, чтобы middleware мог обработать null
        return null; // Возвращаем null при любой ошибке
    } finally {
        console.log(`[getPropertyById] END - Завершение для ID: ${propertyId}`); // Лог 6
    }
}
async function getAllProperties() {
    try { const snapshot = await db.ref('properties').once('value'); const d = snapshot.val(); return d ? Object.values(d) : []; }
    catch (error) { console.error("Error fetching all properties:", error); throw error; }
}
async function getPropertiesByCompanyId(companyId) {
    try { if(!companyId) return []; const snapshot = await db.ref('properties').orderByChild('companyId').equalTo(companyId).once('value'); const d = snapshot.val(); return d ? Object.values(d) : []; }
    catch (error) { console.error(`Error fetching properties for company ${companyId}:`, error); throw error; }
}
async function saveProperty(property) {
    try {
        if (!property) throw new Error("Property data is required.");
        // Генерируем ID, если его нет
        if (!property.Id) { property.Id = db.ref('properties').push().key; }
        if (!property.companyId) { throw new Error("Property must have a companyId."); }
        Object.keys(property).forEach(key => {
            if (property[key] === undefined) {
                console.warn(`[saveProperty] Found undefined value for key '${key}' in property ${property.Id}. Setting to null.`);
                property[key] = null;
            }
        });
        // Перед сохранением удалим поля, которых не должно быть в БД (если они случайно попали)
        // delete property.DisplayImageSrc;
        // delete property.CalculatedDailyPrice;
        // delete property.SortableAddedDate;
        await db.ref(`properties/${property.Id}`).set(property);
        console.log(`Property ${property.Id} (Company: ${property.companyId}) saved.`);
        return property;
    } catch (error) {
        // Добавляем ID в сообщение об ошибке для Firebase
        error.message = `Error saving property ${property?.Id || 'new'}: ${error.message}`;
        console.error(error.message); // Логируем полное сообщение
        throw error;
}
}
async function deleteProperty(propertyId) {
    try { if(!propertyId) throw new Error("Property ID required."); await db.ref(`properties/${propertyId}`).remove(); console.log(`Property ${propertyId} deleted.`); }
    catch (error) { console.error(`Error deleting property ${propertyId}:`, error); throw error; }
}

// --- Бронирования (Bookings) ---
async function getBookingById(bookingId) {
    try { if(!bookingId) return null; const snapshot = await db.ref(`bookings/${bookingId}`).once('value'); const d = snapshot.val(); if (d) d.Id = bookingId; return d; }
    catch (error) { console.error(`Error fetching booking ${bookingId}:`, error); throw error; }
}
async function getAllBookings() {
    try { const snapshot = await db.ref('bookings').once('value'); const d = snapshot.val(); return d ? Object.entries(d).map(([id, data]) => ({ Id: id, ...data })) : []; }
    catch (error) { console.error("Error fetching all bookings:", error); throw error; }
}
async function getBookingsByUserId(userId) {
    try { if(!userId) return []; const snapshot = await db.ref('bookings').orderByChild('UserId').equalTo(userId).once('value'); const d = snapshot.val(); return d ? Object.entries(d).map(([id, data]) => ({ Id: id, ...data })) : []; }
    catch (error) { console.error(`Error fetching bookings for user ${userId}:`, error); throw error; }
}
async function saveBooking(booking) {
    try { if(!booking) throw new Error("Booking data required."); if (!booking.Id) booking.Id = db.ref('bookings').push().key; await db.ref(`bookings/${booking.Id}`).set(booking); console.log(`Booking ${booking.Id} saved.`); return booking; }
    catch (error) { console.error(`Error saving booking ${booking.Id}:`, error); throw error; }
}
async function deleteBooking(bookingId) {
    try { if(!bookingId) throw new Error("Booking ID required."); await db.ref(`bookings/${bookingId}`).remove(); console.log(`Booking ${bookingId} deleted.`); }
    catch (error) { console.error(`Error deleting booking ${bookingId}:`, error); throw error; }
}

// --- Отзывы (Reviews) ---
async function getPropertyReviews(propertyId) {
    try { if(!propertyId) return []; const snapshot = await db.ref(`properties/${propertyId}/reviews`).once('value'); const d = snapshot.val(); return d ? Object.entries(d).map(([id, data]) => ({ reviewId: id, ...data })) : []; }
    catch (error) { console.error(`Error fetching reviews for ${propertyId}:`, error); throw error; }
}
async function hasUserReviewedProperty(propertyId, userId) {
    try { if(!propertyId || !userId) return false; const snapshot = await db.ref(`properties/${propertyId}/reviews`).orderByChild('userId').equalTo(userId).limitToFirst(1).once('value'); return snapshot.exists(); }
    catch (error) { console.error(`Error checking review status for prop ${propertyId}, user ${userId}:`, error); return true; /* Fail safe */ }
}

// --- Уведомления (Notifications) ---
async function addNotification(userId, notificationData) {
    if (!userId || !notificationData || !notificationData.type || !notificationData.title || !notificationData.message) {
        log.error(`[addNotification] Invalid data provided. UserID: ${userId}, Data:`, notificationData);
        return null;
    }
    try {
        const notificationsRef = db.ref(`user_notifications/${userId}`);
        const newNotifRef = notificationsRef.push(); // Генерируем уникальный ID
        const notificationId = newNotifRef.key;
        if (!notificationId) {
             log.error(`[addNotification] Failed to generate notification ID for user ${userId}`);
             return null;
        }

        const notificationPayload = {
            id: notificationId, // Сохраняем ID внутри объекта
            timestamp: admin.database.ServerValue.TIMESTAMP, // Время сервера Firebase
            read: false, // Новые всегда непрочитанные
            type: notificationData.type,
            title: notificationData.title,
            message: notificationData.message,
            ...(notificationData.bookingId && { bookingId: notificationData.bookingId }) // Добавляем bookingId, если он есть
        };

        await newNotifRef.set(notificationPayload);
        log.info(`[addNotification] Notification ${notificationId} added for user ${userId}`);
        return notificationId;
    } catch (error) {
        log.error(`[addNotification] Error adding notification for user ${userId}:`, error);
        return null;
    }
}

async function getLastNotifications(userId, limit = 20) { // Добавляем лимит по умолчанию
    if (!userId) return [];
    try {
        const snapshot = await db.ref(`user_notifications/${userId}`)
                                .orderByChild('timestamp') // Сортируем по времени
                                .limitToLast(limit)      // Берем последние N
                                .once('value');
        const data = snapshot.val();
        if (!data) return [];
        // Преобразуем и сортируем новые сверху
        return Object.values(data).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    } catch (error) {
        log.error(`[getLastNotifications] Error fetching last notifications for user ${userId}:`, error);
        return [];
    }
}

/**
 * Помечает уведомления как прочитанные.
 * @param {string} userId - Логин пользователя.
 * @param {Array<string>} notificationIds - Массив ID уведомлений для пометки.
 * @returns {Promise<boolean>} - true при успехе, false при ошибке.
 */
async function markNotificationsAsRead(userId, notificationIds) {
    if (!userId || !Array.isArray(notificationIds) || notificationIds.length === 0) {
        log.warn(`[markNotificationsAsRead] Invalid input. UserID: ${userId}, IDs:`, notificationIds);
        return false;
    }
    try {
        const updates = {};
        notificationIds.forEach(id => {
            if (id) { // Доп. проверка на пустой ID
                 updates[`/user_notifications/${userId}/${id}/read`] = true;
            }
        });
        if (Object.keys(updates).length === 0) {
             log.info(`[markNotificationsAsRead] No valid notification IDs provided for user ${userId}.`);
             return true; // Ничего не делаем, но не ошибка
        }
        await db.ref().update(updates);
        log.info(`[markNotificationsAsRead] Marked ${notificationIds.length} notifications as read for user ${userId}`);
        return true;
    } catch (error) {
        log.error(`[markNotificationsAsRead] Error marking notifications as read for user ${userId}:`, error);
        return false;
    }
}

/**
 * Удаляет конкретное уведомление пользователя.
 * @param {string} userId - Логин пользователя.
 * @param {string} notificationId - ID уведомления для удаления.
 * @returns {Promise<boolean>} - true при успехе, false при ошибке.
 */
async function deleteNotification(userId, notificationId) {
    if (!userId || !notificationId) {
        log.warn(`[deleteNotification] Invalid input. UserID: ${userId}, NotificationID: ${notificationId}`);
        return false;
    }
    try {
        await db.ref(`user_notifications/${userId}/${notificationId}`).remove();
        log.info(`[deleteNotification] Deleted notification ${notificationId} for user ${userId}`);
        return true;
    } catch (error) {
        log.error(`[deleteNotification] Error deleting notification ${notificationId} for user ${userId}:`, error);
        return false;
    }
}

/**
 * Удаляет ВСЕ уведомления пользователя.
 * @param {string} userId - Логин пользователя.
 * @returns {Promise<boolean>} - true при успехе, false при ошибке.
 */
async function clearAllNotificationsForUser(userId) {
     if (!userId) {
         log.warn(`[clearAllNotificationsForUser] Invalid input. UserID: ${userId}`);
         return false;
     }
     try {
         await db.ref(`user_notifications/${userId}`).remove();
         log.info(`[clearAllNotificationsForUser] Cleared all notifications for user ${userId}`);
         return true;
     } catch (error) {
         log.error(`[clearAllNotificationsForUser] Error clearing notifications for user ${userId}:`, error);
         return false;
     }
 }

// --- Экспорт ---
module.exports = {
    // Users
    getUserByUsername, getAllUsers, saveUser, deleteUser,
    // Companies
    getCompanyById, createCompany, updateCompany, addStaffToCompany, removeStaffFromCompany, updateCompanyBalance,
    // Properties
    getPropertyById, getAllProperties, getPropertiesByCompanyId, saveProperty, deleteProperty,
    // Bookings
    getBookingById, getAllBookings, getBookingsByUserId, saveBooking, deleteBooking,
    // Reviews
    getPropertyReviews, hasUserReviewedProperty,
    // Notifications (НОВОЕ)
    addNotification, getLastNotifications, markNotificationsAsRead, deleteNotification, clearAllNotificationsForUser
};