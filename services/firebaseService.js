// services/firebaseService.js
const admin = require('firebase-admin');
const db = admin.database();
const log = require('electron-log');

// --- Пользователи (Users) ---

/**
 * Получает данные пользователя по его логину (username).
 * @param {string} username Логин пользователя.
 * @returns {Promise<object|null>} Объект с данными пользователя или null, если не найден или произошла ошибка.
 */
async function getUserByUsername(username) {
    try {
        if (!username) {
            log.warn('[FirebaseService] getUserByUsername called with empty username.');
            return null;
        }
        const snapshot = await db.ref(`users/${username}`).once('value');
        const userData = snapshot.val();
        if (userData) {
            // Добавляем Username в объект, так как ключ узла не всегда передается
            userData.Username = username;
        }
        return userData;
    } catch (error) {
        log.error(`[FirebaseService] Error fetching user ${username}:`, error);
        return null; // Возвращаем null при ошибке, чтобы не ломать Promise.allSettled
    }
}

/**
 * Получает список всех пользователей.
 * @returns {Promise<Array<object>>} Массив объектов пользователей.
 */
async function getAllUsers() {
    try {
        const snapshot = await db.ref('users').once('value');
        const usersData = snapshot.val();
        // Преобразуем объект в массив, добавляя ключ (username) в каждый объект
        return usersData ? Object.entries(usersData).map(([username, data]) => ({ Username: username, ...data })) : [];
    } catch (error) {
        log.error("[FirebaseService] Error fetching all users:", error);
        throw error; // Пробрасываем ошибку для обработки выше
    }
}

/**
 * Сохраняет (создает или обновляет) данные пользователя.
 * @param {object} user Объект пользователя. Должен содержать поле `username`.
 * @returns {Promise<object>} Сохраненный объект пользователя.
 */
async function saveUser(user) {
    try {
        if (!user || !user.username) throw new Error("User object must have a username.");
        const username = user.username; // Получаем username
        // Создаем копию объекта для сохранения, чтобы не изменять оригинал
        const userToSave = { ...user };
        // Удаляем поле username, так как оно используется как ключ узла
        delete userToSave.username;
        // Удаляем другие поля, которых не должно быть в БД (например, DisplayAvatarSrc)
        delete userToSave.DisplayAvatarSrc;

        await db.ref(`users/${username}`).set(userToSave);
        log.info(`[FirebaseService] User ${username} saved/updated.`);
        return { ...userToSave, Username: username }; // Возвращаем данные с добавленным Username
    } catch (error) {
        log.error(`[FirebaseService] Error saving user ${user.username}:`, error);
        throw error;
    }
}

/**
 * Удаляет пользователя и связанные данные (например, из staff компании).
 * @param {string} username Логин пользователя для удаления.
 * @returns {Promise<void>}
 */
async function deleteUser(username) {
    try {
        if (!username) throw new Error("Username is required for deletion.");
        const user = await getUserByUsername(username); // Получаем данные перед удалением
        if (!user) {
             log.warn(`[FirebaseService] Attempted to delete non-existent user: ${username}`);
             return; // Пользователя нет, удалять нечего
        }
        // Удаляем пользователя из staff компании, если он там был
        if (user.companyId && user.Role === 'Staff') {
             await removeStaffFromCompany(user.companyId, username)
                    .catch(err => log.warn(`[FirebaseService] Failed to remove user ${username} from staff of company ${user.companyId} during deletion: ${err.message}`)); // Логируем, но не прерываем удаление
        }
        // TODO: Подумать об удалении чатов/сообщений пользователя? (Сложно и может быть не нужно)
        // TODO: Подумать об удалении уведомлений пользователя?
        await db.ref(`users/${username}`).remove();
        log.info(`[FirebaseService] User ${username} deleted.`);
    } catch (error) {
        log.error(`[FirebaseService] Error deleting user ${username}:`, error);
        throw error;
    }
}


// --- Компании (Companies) ---

/**
 * Получает данные компании по ее ID.
 * @param {string} companyId ID компании.
 * @returns {Promise<object|null>} Объект с данными компании или null.
 */
async function getCompanyById(companyId) {
    try {
        if (!companyId) return null;
        const snapshot = await db.ref(`companies/${companyId}`).once('value');
        const companyData = snapshot.val();
         if (companyData) companyData.companyId = companyId; // Добавляем ID в объект
        return companyData;
    } catch (error) {
        log.error(`[FirebaseService] Error fetching company ${companyId}:`, error);
        throw error;
    }
}

/**
 * Создает новую компанию в базе данных.
 * @param {string} companyId ID для новой компании (обычно username владельца).
 * @param {string} ownerUsername Логин владельца компании.
 * @param {object} companyData Начальные данные компании (минимум { companyName }).
 * @returns {Promise<object>} Созданный объект компании.
 */
async function createCompany(companyId, ownerUsername, companyData) {
    try {
        if (!companyId || !ownerUsername || !companyData || !companyData.companyName) {
            throw new Error("Missing required data for company creation (companyId, ownerUsername, companyName).");
        }
        const initialCompany = {
            companyId: companyId, // Дублируем ID в объект для удобства
            ownerUsername: ownerUsername,
            companyName: companyData.companyName.trim(),
            companyContactEmail: companyData.companyContactEmail || null,
            companyContactPhone: companyData.companyContactPhone || null,
            companyWebsite: companyData.companyWebsite || null,
            companyLogoData: companyData.companyLogoData || null,
            Balance: 0, // Начальный баланс
            balanceHistory: {}, // Пустая история баланса
            staff: {} // Пустой список персонала
        };
        await db.ref(`companies/${companyId}`).set(initialCompany);
        log.info(`[FirebaseService] Company ${companyId} created for owner ${ownerUsername}.`);
        return initialCompany;
    } catch (error) {
        log.error(`[FirebaseService] Error creating company ${companyId}:`, error);
        throw error;
    }
}

/**
 * Обновляет данные компании.
 * @param {string} companyId ID компании.
 * @param {object} updates Объект с полями для обновления.
 * @returns {Promise<void>}
 */
async function updateCompany(companyId, updates) {
    try {
        if (!companyId || !updates || typeof updates !== 'object') {
            throw new Error("Missing companyId or updates object.");
        }
        // Удаляем undefined поля из updates перед сохранением
        Object.keys(updates).forEach(key => updates[key] === undefined && delete updates[key]);
        if (Object.keys(updates).length === 0) {
            log.warn(`[FirebaseService] No valid updates provided for company ${companyId}.`);
            return;
        }
        await db.ref(`companies/${companyId}`).update(updates);
        log.info(`[FirebaseService] Company ${companyId} updated.`);
    } catch (error) {
        log.error(`[FirebaseService] Error updating company ${companyId}:`, error);
        throw error;
    }
}

/**
 * Добавляет пользователя в персонал компании.
 * Обновляет запись компании и запись пользователя (роль и companyId).
 * @param {string} companyId ID компании.
 * @param {string} staffUsername Логин добавляемого пользователя.
 * @returns {Promise<void>}
 */
async function addStaffToCompany(companyId, staffUsername) {
    try {
        if (!companyId || !staffUsername) {
            throw new Error("Missing companyId or staffUsername for adding staff.");
        }
        // Используем мульти-путевое обновление для атомарности
        const updates = {};
        updates[`/companies/${companyId}/staff/${staffUsername}`] = true; // Добавляем в staff компании
        updates[`/users/${staffUsername}/companyId`] = companyId;      // Добавляем companyId пользователю
        updates[`/users/${staffUsername}/Role`] = 'Staff';             // Устанавливаем роль Staff
        // Убедимся, что удаляем поля Tenant'а, если они были
        updates[`/users/${staffUsername}/Balance`] = null;
        updates[`/users/${staffUsername}/BalanceHistory`] = null;

        await db.ref().update(updates);
        log.info(`[FirebaseService] Staff ${staffUsername} added to company ${companyId}. User role set to Staff.`);
    } catch (error) {
        log.error(`[FirebaseService] Error adding staff ${staffUsername} to company ${companyId}:`, error);
        throw error;
    }
}

/**
 * Удаляет пользователя из персонала компании.
 * Обновляет запись компании и запись пользователя (сбрасывает роль и companyId).
 * @param {string} companyId ID компании.
 * @param {string} staffUsername Логин удаляемого пользователя.
 * @returns {Promise<void>}
 */
async function removeStaffFromCompany(companyId, staffUsername) {
    try {
        if (!companyId || !staffUsername) {
            throw new Error("Missing companyId or staffUsername for removing staff.");
        }
        // Используем мульти-путевое обновление
        const updates = {};
        updates[`/companies/${companyId}/staff/${staffUsername}`] = null; // Удаляем из staff компании
        updates[`/users/${staffUsername}/companyId`] = null;      // Убираем companyId у пользователя
        updates[`/users/${staffUsername}/Role`] = 'Tenant';       // Возвращаем роль Tenant по умолчанию
        // Добавляем поля Tenant'а
        updates[`/users/${staffUsername}/Balance`] = 0;
        updates[`/users/${staffUsername}/BalanceHistory`] = {};

        await db.ref().update(updates);
        log.info(`[FirebaseService] Staff ${staffUsername} removed from company ${companyId}. User role reset to Tenant.`);
    } catch (error) {
        log.error(`[FirebaseService] Error removing staff ${staffUsername} from company ${companyId}:`, error);
        throw error;
    }
}

/**
 * Обновляет баланс компании с использованием транзакции.
 * @param {string} companyId ID компании.
 * @param {number} amountToAdd Сумма для добавления (может быть отрицательной для списания).
 * @param {string} operationType Тип операции для истории.
 * @param {string} description Описание операции для истории.
 * @returns {Promise<number>} Финальный баланс компании после обновления.
 */
async function updateCompanyBalance(companyId, amountToAdd, operationType, description) {
    const companyRef = db.ref(`companies/${companyId}`);
    try {
        if (!companyId) throw new Error("Company ID required for balance update.");
        if (typeof amountToAdd !== 'number' || isNaN(amountToAdd)) throw new Error("Amount must be a number.");

        const transactionResult = await companyRef.transaction(currentData => {
            if (currentData === null) {
                log.error(`[FirebaseService] updateCompanyBalance: Company ${companyId} not found during transaction.`);
                return undefined; // Отменяем транзакцию
            }
            const currentBalance = currentData.Balance || 0;
            const newBalance = parseFloat((currentBalance + amountToAdd).toFixed(2)); // Округление до 2 знаков

            // Обновляем баланс
            currentData.Balance = newBalance;

            // Добавляем запись в историю
            if (!currentData.balanceHistory) { currentData.balanceHistory = {}; }
            const historyRef = companyRef.child('balanceHistory').push(); // Генерируем ключ
            const historyKey = historyRef.key;
            if (historyKey) {
                 currentData.balanceHistory[historyKey] = {
                     Id: historyKey,
                     Date: new Date().toISOString(), // Используем ISO строку для простоты
                     Amount: amountToAdd,
                     OperationType: operationType || "Коррекция",
                     Description: description || "-",
                     NewBalance: newBalance
                 };
            } else {
                 log.error(`[FirebaseService] Failed to generate history key for company ${companyId}`);
                 // Можно отменить транзакцию, вернув undefined, или просто не добавлять историю
            }
            return currentData; // Возвращаем обновленные данные для Firebase
        });

        if (!transactionResult.committed || !transactionResult.snapshot.exists()) {
            // Либо компания не найдена, либо транзакция была отменена (вернули undefined)
            throw new Error(`Company ${companyId} not found or balance transaction aborted.`);
        }
        const finalBalance = transactionResult.snapshot.val().Balance;
        log.info(`[FirebaseService] Company ${companyId} balance updated by ${amountToAdd}. New balance: ${finalBalance}`);
        return finalBalance; // Возвращаем финальный баланс
    } catch (error) {
        log.error(`[FirebaseService] Error updating balance for company ${companyId}:`, error);
        throw error;
    }
}


// --- Объекты (Properties) ---

/**
 * Получает данные объекта недвижимости по его ID.
 * Добавляет поле Id в возвращаемый объект.
 * @param {string} propertyId ID объекта.
 * @returns {Promise<object|null>} Объект с данными объекта или null.
 */
async function getPropertyById(propertyId) {
    log.debug(`[FirebaseService] getPropertyById - Request for ID: ${propertyId}`);
    try {
        if (!propertyId) {
            log.warn("[FirebaseService] getPropertyById - No ID provided.");
            return null;
        }
        const propertyRef = db.ref(`properties/${propertyId}`);
        const snapshot = await propertyRef.once('value');

        if (!snapshot.exists()) {
            log.warn(`[FirebaseService] getPropertyById - Snapshot for ${propertyId} does NOT exist.`);
            return null;
        }

        const propertyData = snapshot.val();
        if (propertyData && typeof propertyData === 'object') {
            propertyData.Id = propertyId; // Добавляем ID
            // Добавим лог перед возвратом
            log.debug(`[FirebaseService] getPropertyById - Found property ${propertyId}, Company ID: ${propertyData.companyId}`);
            return propertyData;
        } else {
            log.error(`[FirebaseService] getPropertyById - Unexpected data format for ${propertyId}:`, typeof propertyData);
            return null;
        }
    } catch (error) {
        log.error(`[FirebaseService] getPropertyById - CRITICAL ERROR fetching ${propertyId}:`, error);
        return null; // Возвращаем null при любой ошибке
    }
}

/**
 * Получает список всех объектов недвижимости.
 * @returns {Promise<Array<object>>} Массив объектов недвижимости.
 */
async function getAllProperties() {
    try {
        const snapshot = await db.ref('properties').once('value');
        const propertiesData = snapshot.val();
        // Преобразуем объект в массив, добавляя ключ (ID) в каждый объект
        return propertiesData ? Object.entries(propertiesData).map(([id, data]) => ({ Id: id, ...data })) : [];
    } catch (error) {
        log.error("[FirebaseService] Error fetching all properties:", error);
        throw error;
    }
}

/**
 * Получает список объектов недвижимости для конкретной компании.
 * @param {string} companyId ID компании.
 * @returns {Promise<Array<object>>} Массив объектов недвижимости.
 */
async function getPropertiesByCompanyId(companyId) {
    try {
        if (!companyId) return [];
        const snapshot = await db.ref('properties').orderByChild('companyId').equalTo(companyId).once('value');
        const propertiesData = snapshot.val();
        // Преобразуем объект в массив, добавляя ключ (ID) в каждый объект
        return propertiesData ? Object.entries(propertiesData).map(([id, data]) => ({ Id: id, ...data })) : [];
    } catch (error) {
        log.error(`[FirebaseService] Error fetching properties for company ${companyId}:`, error);
        throw error;
    }
}

/**
 * Сохраняет (создает или обновляет) объект недвижимости.
 * Генерирует ID, если он не предоставлен.
 * @param {object} property Объект недвижимости. Должен содержать `companyId`. `Id` опционален.
 * @returns {Promise<object>} Сохраненный объект недвижимости с присвоенным `Id`.
 */
async function saveProperty(property) {
    try {
        if (!property) throw new Error("Property data is required.");
        if (!property.companyId) throw new Error("Property must have a companyId.");

        let propertyId = property.Id;
        // Генерируем ID, если его нет (при создании)
        if (!propertyId) {
            propertyId = db.ref('properties').push().key;
            if (!propertyId) throw new Error("Failed to generate property ID.");
            property.Id = propertyId; // Добавляем ID обратно в объект
            log.info(`[FirebaseService] Generated new ID for property: ${propertyId}`);
        }

        // Убедимся, что нет undefined полей перед сохранением
        const propertyToSave = { ...property }; // Создаем копию
        Object.keys(propertyToSave).forEach(key => {
            if (propertyToSave[key] === undefined) {
                log.warn(`[FirebaseService] Found undefined value for key '${key}' in property ${propertyId}. Setting to null.`);
                propertyToSave[key] = null;
            }
        });
        // Удаляем временные поля, если они есть (например, из EJS)
        delete propertyToSave.DisplayImageSrc;
        delete propertyToSave.CalculatedDailyPrice;
        delete propertyToSave.SortableAddedDate;

        await db.ref(`properties/${propertyId}`).set(propertyToSave);
        log.info(`[FirebaseService] Property ${propertyId} (Company: ${propertyToSave.companyId}) saved.`);
        return propertyToSave; // Возвращаем сохраненный объект
    } catch (error) {
        error.message = `[FirebaseService] Error saving property ${property?.Id || 'new'}: ${error.message}`;
        log.error(error.message);
        throw error;
    }
}

/**
 * Удаляет объект недвижимости.
 * @param {string} propertyId ID объекта для удаления.
 * @returns {Promise<void>}
 */
async function deleteProperty(propertyId) {
    try {
        if (!propertyId) throw new Error("Property ID required for deletion.");
        // TODO: Подумать об удалении связанных бронирований/отзывов? Или оставить как есть?
        await db.ref(`properties/${propertyId}`).remove();
        log.info(`[FirebaseService] Property ${propertyId} deleted.`);
    } catch (error) {
        log.error(`[FirebaseService] Error deleting property ${propertyId}:`, error);
        throw error;
    }
}


// --- Бронирования (Bookings) ---

/**
 * Получает данные бронирования по его ID.
 * @param {string} bookingId ID бронирования.
 * @returns {Promise<object|null>} Объект бронирования или null.
 */
async function getBookingById(bookingId) {
    try {
        if (!bookingId) return null;
        const snapshot = await db.ref(`bookings/${bookingId}`).once('value');
        const bookingData = snapshot.val();
        if (bookingData) bookingData.Id = bookingId; // Добавляем ID
        return bookingData;
    } catch (error) {
        log.error(`[FirebaseService] Error fetching booking ${bookingId}:`, error);
        throw error;
    }
}

/**
 * Получает список всех бронирований.
 * @returns {Promise<Array<object>>} Массив объектов бронирований.
 */
async function getAllBookings() {
    try {
        const snapshot = await db.ref('bookings').once('value');
        const bookingsData = snapshot.val();
        return bookingsData ? Object.entries(bookingsData).map(([id, data]) => ({ Id: id, ...data })) : [];
    } catch (error) {
        log.error("[FirebaseService] Error fetching all bookings:", error);
        throw error;
    }
}

/**
 * Получает список бронирований для конкретного пользователя.
 * @param {string} userId Логин пользователя (арендатора).
 * @returns {Promise<Array<object>>} Массив объектов бронирований.
 */
async function getBookingsByUserId(userId) {
    try {
        if (!userId) return [];
        const snapshot = await db.ref('bookings').orderByChild('UserId').equalTo(userId).once('value');
        const bookingsData = snapshot.val();
        return bookingsData ? Object.entries(bookingsData).map(([id, data]) => ({ Id: id, ...data })) : [];
    } catch (error) {
        log.error(`[FirebaseService] Error fetching bookings for user ${userId}:`, error);
        throw error;
    }
}

/**
 * Сохраняет (создает или обновляет) бронирование.
 * @param {object} booking Объект бронирования. `Id` опционален (генерируется при создании).
 * @returns {Promise<object>} Сохраненный объект бронирования.
 */
async function saveBooking(booking) {
    try {
        if (!booking) throw new Error("Booking data required.");
        let bookingId = booking.Id;
        if (!bookingId) {
            bookingId = db.ref('bookings').push().key;
             if (!bookingId) throw new Error("Failed to generate booking ID.");
            booking.Id = bookingId;
        }
        await db.ref(`bookings/${bookingId}`).set(booking);
        log.info(`[FirebaseService] Booking ${bookingId} saved.`);
        return booking;
    } catch (error) {
        log.error(`[FirebaseService] Error saving booking ${booking.Id || 'new'}:`, error);
        throw error;
    }
}

/**
 * Удаляет бронирование.
 * @param {string} bookingId ID бронирования для удаления.
 * @returns {Promise<void>}
 */
async function deleteBooking(bookingId) {
    try {
        if (!bookingId) throw new Error("Booking ID required for deletion.");
        await db.ref(`bookings/${bookingId}`).remove();
        log.info(`[FirebaseService] Booking ${bookingId} deleted.`);
    } catch (error) {
        log.error(`[FirebaseService] Error deleting booking ${bookingId}:`, error);
        throw error;
    }
}


// --- Отзывы (Reviews) ---

/**
 * Получает все отзывы для конкретного объекта.
 * @param {string} propertyId ID объекта.
 * @returns {Promise<Array<object>>} Массив объектов отзывов.
 */
async function getPropertyReviews(propertyId) {
    try {
        if (!propertyId) return [];
        const snapshot = await db.ref(`properties/${propertyId}/reviews`).once('value');
        const reviewsData = snapshot.val();
        // Преобразуем объект в массив, добавляя ключ (reviewId) в каждый объект
        return reviewsData ? Object.entries(reviewsData).map(([id, data]) => ({ reviewId: id, ...data })) : [];
    } catch (error) {
        log.error(`[FirebaseService] Error fetching reviews for property ${propertyId}:`, error);
        throw error;
    }
}

/**
 * Проверяет, оставлял ли пользователь отзыв на данный объект.
 * @param {string} propertyId ID объекта.
 * @param {string} userId Логин пользователя.
 * @returns {Promise<boolean>} true, если отзыв найден, иначе false.
 */
async function hasUserReviewedProperty(propertyId, userId) {
    try {
        if (!propertyId || !userId) return false;
        // Ищем хотя бы один отзыв по userId
        const snapshot = await db.ref(`properties/${propertyId}/reviews`)
                                .orderByChild('userId') // Убедитесь, что поле называется 'userId' в отзывах
                                .equalTo(userId)
                                .limitToFirst(1) // Достаточно одного совпадения
                                .once('value');
        return snapshot.exists(); // true, если что-то найдено
    } catch (error) {
        log.error(`[FirebaseService] Error checking review status for prop ${propertyId}, user ${userId}:`, error);
        return true; // Fail safe - лучше не дать оставить второй отзыв, чем разрешить случайно
    }
}


// --- Уведомления (Notifications) ---

/**
 * Добавляет новое уведомление для пользователя.
 * @param {string} userId Логин пользователя.
 * @param {object} notificationData Данные уведомления { type, title, message, bookingId? }.
 * @returns {Promise<string|null>} ID созданного уведомления или null при ошибке.
 */
async function addNotification(userId, notificationData) {
    if (!userId || !notificationData || !notificationData.type || !notificationData.title || !notificationData.message) {
        log.error(`[FirebaseService:addNotification] Invalid data provided. UserID: ${userId}, Data:`, notificationData);
        return null;
    }
    try {
        const notificationsRef = db.ref(`user_notifications/${userId}`);
        const newNotifRef = notificationsRef.push();
        const notificationId = newNotifRef.key;
        if (!notificationId) {
             log.error(`[FirebaseService:addNotification] Failed to generate notification ID for user ${userId}`);
             return null;
        }
        const notificationPayload = {
            id: notificationId,
            timestamp: admin.database.ServerValue.TIMESTAMP,
            read: false,
            type: notificationData.type,
            title: notificationData.title,
            message: notificationData.message,
            ...(notificationData.bookingId && { bookingId: notificationData.bookingId })
        };
        await newNotifRef.set(notificationPayload);
        log.info(`[FirebaseService:addNotification] Notification ${notificationId} added for user ${userId}`);
        return notificationId;
    } catch (error) {
        log.error(`[FirebaseService:addNotification] Error adding notification for user ${userId}:`, error);
        return null;
    }
}

/**
 * Получает последние N уведомлений для пользователя.
 * @param {string} userId Логин пользователя.
 * @param {number} [limit=20] Количество уведомлений для загрузки.
 * @returns {Promise<Array<object>>} Массив объектов уведомлений (новые сверху).
 */
async function getLastNotifications(userId, limit = 20) {
    if (!userId) return [];
    try {
        const snapshot = await db.ref(`user_notifications/${userId}`)
                                .orderByChild('timestamp')
                                .limitToLast(limit)
                                .once('value');
        const data = snapshot.val();
        if (!data) return [];
        return Object.values(data).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)); // Сортируем новые сверху
    } catch (error) {
        log.error(`[FirebaseService:getLastNotifications] Error fetching for user ${userId}:`, error);
        return [];
    }
}

/**
 * Помечает указанные уведомления как прочитанные.
 * @param {string} userId Логин пользователя.
 * @param {Array<string>} notificationIds Массив ID уведомлений.
 * @returns {Promise<boolean>} true при успехе, false при ошибке или если нет ID.
 */
async function markNotificationsAsRead(userId, notificationIds) {
    if (!userId || !Array.isArray(notificationIds) || notificationIds.length === 0) {
        log.warn(`[FirebaseService:markNotificationsAsRead] Invalid input. UserID: ${userId}, IDs:`, notificationIds);
        return false;
    }
    try {
        const updates = {};
        let validIdsCount = 0;
        notificationIds.forEach(id => {
            if (id && typeof id === 'string') { // Проверка ID
                 updates[`/user_notifications/${userId}/${id}/read`] = true;
                 validIdsCount++;
            }
        });
        if (validIdsCount === 0) {
             log.info(`[FirebaseService:markNotificationsAsRead] No valid notification IDs provided for user ${userId}.`);
             return true;
        }
        await db.ref().update(updates);
        log.info(`[FirebaseService:markNotificationsAsRead] Marked ${validIdsCount} notifications as read for user ${userId}`);
        return true;
    } catch (error) {
        log.error(`[FirebaseService:markNotificationsAsRead] Error marking as read for user ${userId}:`, error);
        return false;
    }
}

/**
 * Удаляет конкретное уведомление пользователя.
 * @param {string} userId Логин пользователя.
 * @param {string} notificationId ID уведомления.
 * @returns {Promise<boolean>} true при успехе, false при ошибке.
 */
async function deleteNotification(userId, notificationId) {
    if (!userId || !notificationId) {
        log.warn(`[FirebaseService:deleteNotification] Invalid input. UserID: ${userId}, NotificationID: ${notificationId}`);
        return false;
    }
    try {
        await db.ref(`user_notifications/${userId}/${notificationId}`).remove();
        log.info(`[FirebaseService:deleteNotification] Deleted notification ${notificationId} for user ${userId}`);
        return true;
    } catch (error) {
        log.error(`[FirebaseService:deleteNotification] Error deleting notification ${notificationId} for user ${userId}:`, error);
        return false;
    }
}

/**
 * Удаляет ВСЕ уведомления пользователя.
 * @param {string} userId Логин пользователя.
 * @returns {Promise<boolean>} true при успехе, false при ошибке.
 */
async function clearAllNotificationsForUser(userId) {
     if (!userId) {
         log.warn(`[FirebaseService:clearAllNotificationsForUser] Invalid input. UserID: ${userId}`);
         return false;
     }
     try {
         await db.ref(`user_notifications/${userId}`).remove();
         log.info(`[FirebaseService:clearAllNotificationsForUser] Cleared all notifications for user ${userId}`);
         return true;
     } catch (error) {
         log.error(`[FirebaseService:clearAllNotificationsForUser] Error clearing notifications for user ${userId}:`, error);
         return false;
     }
}


// --- Чаты (Chats) ---

/**
 * Получает данные чата по ID.
 * @param {string} chatId ID чата.
 * @returns {Promise<object|null>} Данные чата или null, если не найден.
 */
async function getChatById(chatId) {
    if (!chatId) return null;
    try {
        const snapshot = await db.ref(`chats/${chatId}`).once('value');
        const chatData = snapshot.val();
        if (chatData) chatData.id = chatId; // Добавляем ID для удобства
        return chatData;
    } catch (error) {
        log.error(`[FirebaseService] Error fetching chat ${chatId}:`, error);
        throw error; // Пробрасываем ошибку
    }
}

/**
 * Получает список ID чатов для пользователя и/или компании.
 * Использует денормализованные данные из user_chats и company_chats.
 * @param {string} userId Username пользователя.
 * @param {string|null} companyId ID компании (если пользователь Owner/Staff).
 * @returns {Promise<Array<object>>} Массив объектов с метаданными чатов.
 */
async function getUserChats(userId, companyId) {
    if (!userId) return [];
    log.debug(`[getUserChats] Fetching chat IDs for user: ${userId}, company: ${companyId}`);
    try {
        const chatIds = new Set(); // Используем Set для уникальности ID

        // Загружаем чаты пользователя
        // Сортируем по значению (timestamp) и берем последние (самые свежие)
        const userChatsSnapshot = await db.ref(`user_chats/${userId}`)
                                        .orderByValue() // Сортируем по timestamp'у
                                        .limitToLast(100) // Ограничиваем количество для производительности
                                        .once('value');
        const userChatIds = userChatsSnapshot.val();
        if (userChatIds) {
            Object.keys(userChatIds).forEach(id => chatIds.add(id));
            log.debug(`[getUserChats] Found ${Object.keys(userChatIds).length} chat IDs for user ${userId}`);
        }

        // Загружаем чаты компании (если применимо)
        if (companyId) {
            const companyChatsSnapshot = await db.ref(`company_chats/${companyId}`)
                                               .orderByValue()
                                               .limitToLast(100)
                                               .once('value');
            const companyChatIds = companyChatsSnapshot.val();
            if (companyChatIds) {
                Object.keys(companyChatIds).forEach(id => chatIds.add(id));
                log.debug(`[getUserChats] Found ${Object.keys(companyChatIds).length} chat IDs for company ${companyId}`);
            }
        }

        if (chatIds.size === 0) {
            log.info(`[getUserChats] No chats found for user ${userId} / company ${companyId}.`);
            return [];
        }

        log.debug(`[getUserChats] Total unique chat IDs to fetch: ${chatIds.size}`);

        // Загружаем метаданные для каждого чата
        const chatPromises = Array.from(chatIds).map(chatId => getChatById(chatId).catch(e => {
             log.warn(`[getUserChats] Failed to fetch details for chat ${chatId}:`, e.message);
             return null; // Возвращаем null при ошибке загрузки конкретного чата
        }));
        const chatResults = await Promise.all(chatPromises);

        const validChats = chatResults.filter(Boolean); // Фильтруем null значения (ошибки загрузки)
        log.info(`[getUserChats] Successfully fetched details for ${validChats.length} chats.`);
        // Сортируем результат по времени последнего сообщения (desc)
        validChats.sort((a, b) => (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0));
        return validChats;

    } catch (error) {
        log.error(`[FirebaseService] Error fetching chats for user ${userId} / company ${companyId}:`, error);
        throw error;
    }
}


/**
 * Создает новую запись чата в /chats.
 * @param {object} chatData Данные нового чата.
 * @returns {Promise<string>} ID созданного чата.
 */
async function createChat(chatData) {
    if (!chatData || !chatData.participants) {
        throw new Error("Invalid chat data provided for creation.");
    }
    try {
        const newChatRef = db.ref('chats').push();
        const newChatId = newChatRef.key;
        if (!newChatId) throw new Error("Failed to generate chat ID.");

        // Убедимся, что timestamp'ы являются ServerValue или числами
        if (chatData.createdAt === undefined) chatData.createdAt = admin.database.ServerValue.TIMESTAMP;
        if (chatData.lastMessageTimestamp === undefined) chatData.lastMessageTimestamp = admin.database.ServerValue.TIMESTAMP;

        await newChatRef.set(chatData);
        log.info(`[FirebaseService] Chat created with ID: ${newChatId}`);
        return newChatId;
    } catch (error) {
        log.error('[FirebaseService] Error creating chat:', error);
        throw error;
    }
}

/**
 * Ищет существующий чат между пользователем и компанией, опционально связанный с объектом.
 * @param {string} tenantId ID арендатора.
 * @param {string} companyId ID компании.
 * @param {string|null} propertyId ID объекта (опционально).
 * @returns {Promise<string|null>} ID найденного чата или null.
 */
async function findExistingChat(tenantId, companyId, propertyId = null) {
    if (!tenantId || !companyId) return null;
    log.debug(`[findExistingChat] Searching for chat: Tenant=${tenantId}, Company=${companyId}, Property=${propertyId}`);
    try {
        // Загружаем чаты пользователя (т.к. их обычно меньше, чем у компании)
        const userChatLinks = await db.ref(`user_chats/${tenantId}`).once('value');
        const userChatIdsObject = userChatLinks.val() || {};
         // Сортируем ID чатов по timestamp'у (desc), чтобы сначала проверять недавние
         const userChatIds = Object.entries(userChatIdsObject)
                                  .sort(([, tsA], [, tsB]) => (tsB || 0) - (tsA || 0))
                                  .map(([id]) => id);

        if (userChatIds.length === 0) {
            log.debug(`[findExistingChat] User ${tenantId} has no chats.`);
            return null;
        }
        log.debug(`[findExistingChat] Found ${userChatIds.length} chats for user ${tenantId}. Checking participants and property...`);

        // Последовательно проверяем чаты пользователя
        for (const chatId of userChatIds) {
            const chat = await getChatById(chatId);
            // Проверяем наличие второго участника (компании)
            if (chat && chat.participants && chat.participants[companyId]) {
                // Проверяем соответствие propertyId
                if (propertyId) { // Если ищем чат по конкретному объекту
                    if (chat.propertyId === propertyId) {
                        log.debug(`[findExistingChat] Found existing chat ${chatId} matching property ${propertyId}.`);
                        return chatId; // Нашли чат с нужным propertyId
                    }
                } else { // Если ищем общий чат (propertyId не указан)
                    if (!chat.propertyId) { // Ищем чат БЕЗ привязки к объекту
                        log.debug(`[findExistingChat] Found existing general chat ${chatId} (no property linked).`);
                        return chatId;
                    }
                }
            }
        }

        log.debug(`[findExistingChat] No existing chat found matching criteria.`);
        return null; // Не нашли подходящий чат

    } catch (error) {
        log.error(`[FirebaseService] Error finding existing chat for ${tenantId}/${companyId}:`, error);
        return null; // Возвращаем null при ошибке
    }
}


/**
 * Обновляет метаданные чата при отправке нового сообщения.
 * Использует транзакцию для атомарного увеличения счетчиков непрочитанных.
 * @param {string} chatId ID чата.
 * @param {object} data Данные для обновления: { lastMessageText, lastMessageTimestamp, lastMessageSenderId, recipientsToIncrementUnread }
 */
async function updateChatMetadataOnNewMessage(chatId, data) {
    if (!chatId || !data || typeof data.lastMessageText !== 'string' || typeof data.lastMessageTimestamp !== 'number' || !data.lastMessageSenderId || !Array.isArray(data.recipientsToIncrementUnread)) {
        log.error(`[updateChatMetadata] Invalid data for chat ${chatId}:`, data);
        return;
    }
    log.debug(`[updateChatMetadata] Updating metadata for chat ${chatId}. Recipients for unread increment:`, data.recipientsToIncrementUnread);
    try {
        const chatRef = db.ref(`chats/${chatId}`);

        // Используем транзакцию для обновления всего узла (или создаем, если его нет)
        const transactionResult = await chatRef.transaction(currentChatData => {
             if (currentChatData === null) {
                 // Это неожиданно, чат должен существовать. Логируем ошибку.
                 log.error(`[updateChatMetadata] Chat ${chatId} not found during transaction!`);
                 return undefined; // Отменяем транзакцию
             }

             // Обновляем основные поля
             currentChatData.lastMessageText = data.lastMessageText;
             currentChatData.lastMessageTimestamp = data.lastMessageTimestamp;
             currentChatData.lastMessageSenderId = data.lastMessageSenderId;

             // Инициализируем счетчики, если их нет
             if (!currentChatData.unreadCounts) {
                 currentChatData.unreadCounts = {};
             }

             // Увеличиваем счетчики для получателей
             data.recipientsToIncrementUnread.forEach(recipientId => {
                 if (recipientId) { // Проверка на пустой ID
                     currentChatData.unreadCounts[recipientId] = (currentChatData.unreadCounts[recipientId] || 0) + 1;
                 }
             });

             return currentChatData; // Возвращаем обновленные данные
        });

        if (!transactionResult.committed) {
             log.warn(`[updateChatMetadata] Transaction for chat ${chatId} was aborted (maybe chat deleted?).`);
        } else {
             log.info(`[updateChatMetadata] Metadata and unread counts updated successfully for chat ${chatId}.`);
        }

    } catch (error) {
        log.error(`[FirebaseService] Error updating chat metadata transaction for ${chatId}:`, error);
        // Не пробрасываем ошибку, чтобы не прерывать основной процесс
    }
}


/**
 * Сбрасывает счетчик непрочитанных сообщений для указанного участника чата.
 * @param {string} chatId ID чата.
 * @param {string} readerId ID пользователя или компании, который прочитал сообщения.
 */
async function resetUnreadCount(chatId, readerId) {
    if (!chatId || !readerId) {
        log.warn(`[resetUnreadCount] Invalid chatId or readerId. Chat: ${chatId}, Reader: ${readerId}`);
        return;
    }
    log.debug(`[resetUnreadCount] Resetting unread count for reader ${readerId} in chat ${chatId}`);
    try {
        // Используем update, чтобы создать поле, если его нет, или установить 0
        await db.ref(`chats/${chatId}/unreadCounts`).update({ [readerId]: 0 });
        log.info(`[resetUnreadCount] Unread count reset for ${readerId} in chat ${chatId}.`);
    } catch (error) {
        log.error(`[FirebaseService] Error resetting unread count for ${readerId} in chat ${chatId}:`, error);
    }
}


// --- Сообщения (Messages) ---

/**
 * Создает новое сообщение в /messages.
 * @param {object} messageData Данные сообщения (chatId, senderId, senderRole, text, timestamp).
 * @returns {Promise<object>} Созданный объект сообщения с присвоенным ID и timestamp.
 */
async function createMessage(messageData) {
    if (!messageData || !messageData.chatId || !messageData.senderId || !messageData.text) {
        throw new Error("Invalid message data provided for creation (chatId, senderId, text required).");
    }
    try {
        const newMessageRef = db.ref('messages').push();
        const newMessageId = newMessageRef.key;
        if (!newMessageId) throw new Error("Failed to generate message ID.");

        const messageToSave = {
            chatId: messageData.chatId,
            senderId: messageData.senderId,
            senderRole: messageData.senderRole || 'Unknown', // Добавляем роль
            text: messageData.text,
            timestamp: messageData.timestamp || admin.database.ServerValue.TIMESTAMP // Время сервера
        };

        await newMessageRef.set(messageToSave);
        log.info(`[FirebaseService] Message ${newMessageId} created for chat ${messageData.chatId}`);

        // Возвращаем данные с ID и примерным timestamp для UI
        // Серверный timestamp будет доступен только после сохранения, поэтому используем Date.now()
        const approxTimestamp = (messageData.timestamp === admin.database.ServerValue.TIMESTAMP)
                                ? Date.now()
                                : messageData.timestamp;
        return { ...messageToSave, id: newMessageId, timestamp: approxTimestamp };

    } catch (error) {
        log.error('[FirebaseService] Error creating message:', error);
        throw error;
    }
}

/**
 * Получает сообщения для конкретного чата с пагинацией.
 * @param {string} chatId ID чата.
 * @param {number} [limit=50] Количество сообщений для загрузки.
 * @param {number|null} [beforeTimestamp=null] Timestamp самого старого загруженного сообщения (для загрузки более старых).
 * @returns {Promise<Array<object>>} Массив объектов сообщений, отсортированных по времени (старые сверху).
 */
async function getChatMessages(chatId, limit = 50, beforeTimestamp = null) {
    if (!chatId) return [];
    log.debug(`[getChatMessages] Fetching messages for chat ${chatId}, limit: ${limit}, before: ${beforeTimestamp}`);
    try {
        // 1. Запрос ВСЕХ сообщений для данного chatId
        //    Используем ТОЛЬКО фильтрацию по chatId. Сортировку и лимитирование сделаем на сервере.
        const query = db.ref('messages')
                      .orderByChild('chatId') // <<< ОСТАВЛЯЕМ ТОЛЬКО ЭТОТ ИНДЕКС
                      .equalTo(chatId);

        const snapshot = await query.once('value');
        const messagesData = snapshot.val();

        if (!messagesData) {
            log.debug(`[getChatMessages] No messages found for chat ${chatId}.`);
            return [];
        }

        // 2. Преобразуем в массив и добавляем ID
        let messagesArray = Object.entries(messagesData).map(([id, data]) => ({
            id: id,
            ...data
        }));

        // 3. Сортируем ВСЕ сообщения чата по timestamp (ПО УБЫВАНИЮ - новые сверху)
        messagesArray.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        // 4. Применяем пагинацию (limit и beforeTimestamp) уже к отсортированному массиву
        let paginatedMessages;
        if (beforeTimestamp && typeof beforeTimestamp === 'number' && beforeTimestamp > 0) {
            // Ищем индекс первого сообщения, которое СТАРШЕ (или равно) 'beforeTimestamp'
            // Так как массив отсортирован DESC (новые сверху), ищем первое <= beforeTimestamp-1
            const startIndex = messagesArray.findIndex(msg => (msg.timestamp || 0) < beforeTimestamp);
            if (startIndex === -1) {
                // Нет сообщений старше 'beforeTimestamp'
                paginatedMessages = [];
                 log.debug(`[getChatMessages] No messages found before ${beforeTimestamp}`);
            } else {
                // Берем 'limit' сообщений, начиная с найденного индекса
                paginatedMessages = messagesArray.slice(startIndex, startIndex + limit);
                 log.debug(`[getChatMessages] Sliced ${paginatedMessages.length} messages starting from index ${startIndex}`);
            }
             // Возвращаем старые сверху для добавления в начало списка в UI
             paginatedMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        } else {
            // Если 'beforeTimestamp' нет, берем самые ПОСЛЕДНИЕ 'limit' сообщений
            paginatedMessages = messagesArray.slice(0, limit);
             log.debug(`[getChatMessages] Sliced latest ${paginatedMessages.length} messages.`);
             // Возвращаем новые сверху для первичной загрузки
             // Они уже отсортированы desc, дополнительная сортировка не нужна
             // НО для консистентности в UI чата, ЛУЧШЕ ВСЕГДА возвращать старые сверху:
             paginatedMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        }


        log.info(`[getChatMessages] Processed and returning ${paginatedMessages.length} messages for chat ${chatId}.`); // Используем info для большей заметности
        return paginatedMessages;

    } catch (error) {
        // Логируем ошибку, но НЕ пробрасываем ее, чтобы вызывающий код мог обработать пустой массив
        log.error(`[FirebaseService] Error fetching messages for chat ${chatId}:`, error);
        return []; // Возвращаем пустой массив в случае ошибки
    }
}
// --- Вспомогательные функции для аватаров/лого ---

/**
 * Получает Data URI для аватара пользователя.
 * @param {string} username Логин пользователя.
 * @returns {Promise<string>} Data URI или путь к плейсхолдеру.
 */
async function getUserAvatarDataUri(username) {
    try {
        const user = await getUserByUsername(username);
        if (user && user.ImageData) {
            let type = user.ImageData.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
            return `data:${type};base64,${user.ImageData}`;
        }
    } catch (e) {
        log.warn(`[getUserAvatarDataUri] Error fetching/processing avatar for ${username}:`, e.message);
    }
    return '/images/placeholder-avatar.png'; // Путь к дефолтному аватару
}

/**
 * Получает Data URI для логотипа компании.
 * @param {string} companyId ID компании.
 * @returns {Promise<string>} Data URI или путь к плейсхолдеру.
 */
async function getCompanyLogoDataUri(companyId) {
     try {
        const company = await getCompanyById(companyId);
        if (company && company.companyLogoData) {
            let type = company.companyLogoData.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
            return `data:${type};base64,${company.companyLogoData}`;
        }
    } catch (e) {
        log.warn(`[getCompanyLogoDataUri] Error fetching/processing logo for ${companyId}:`, e.message);
    }
    return '/images/placeholder-company.png'; // Путь к дефолтному лого компании
}


// --- ЭКСПОРТ ВСЕХ ФУНКЦИЙ ---
module.exports = {
    // Users
    getUserByUsername,
    getAllUsers,
    saveUser,
    deleteUser,
    // Companies
    getCompanyById,
    createCompany,
    updateCompany,
    addStaffToCompany,
    removeStaffFromCompany,
    updateCompanyBalance,
    // Properties
    getPropertyById,
    getAllProperties,
    getPropertiesByCompanyId,
    saveProperty,
    deleteProperty,
    // Bookings
    getBookingById,
    getAllBookings,
    getBookingsByUserId,
    saveBooking,
    deleteBooking,
    // Reviews
    getPropertyReviews,
    hasUserReviewedProperty,
    // Notifications
    addNotification,
    getLastNotifications,
    markNotificationsAsRead,
    deleteNotification,
    clearAllNotificationsForUser,
    // Chats (Новые функции)
    getChatById,
    getUserChats,
    createChat,
    findExistingChat,
    updateChatMetadataOnNewMessage,
    resetUnreadCount,
    // Messages (Новые функции)
    createMessage,
    getChatMessages,
    // Helpers (Новые функции)
    getUserAvatarDataUri,
    getCompanyLogoDataUri
};