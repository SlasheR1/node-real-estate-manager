// services/firebaseService.js (Полная версия с изменениями для чатов и счетчиков)
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
        // log.debug(`[FirebaseService] Fetched user ${username}:`, userData ? 'Found' : 'Not Found');
        return userData;
    } catch (error) {
        log.error(`[FirebaseService] Error fetching user ${username}:`, error);
        return null; // Возвращаем null при ошибке, чтобы не ломать Promise.allSettled
    }
}
async function calculateTotalUnreadChats(userId, companyId, readerId) {
    let totalUnreadMessages = 0; // Считаем сообщения, а не чаты
    log.info(`[calculateTotalUnreadChats] Calculating for User: ${userId}, Company: ${companyId}, Reader: ${readerId}`);
    try {
        if (!userId || !readerId) {
             log.warn(`[calculateTotalUnreadChats] Cannot calculate count: userId or readerId is missing.`);
             return 0;
        }
        // Получаем ВСЕ чаты, доступные пользователю userId/companyId
        const userChats = await getUserChats(userId, companyId); // Используем существующую функцию
        userChats.forEach(chat => {
            // Суммируем счетчик для конкретного readerId из каждого чата
            const countForReader = chat?.unreadCounts?.[readerId];
            if (typeof countForReader === 'number' && countForReader > 0) {
                totalUnreadMessages += countForReader; // Суммируем КОЛИЧЕСТВО СООБЩЕНИЙ
                log.debug(`[calculateTotalUnreadChats] Chat ${chat.id}: Found ${countForReader} unread for ${readerId}. Current total: ${totalUnreadMessages}`);
            } else if (chat && chat.id) {
                 log.debug(`[calculateTotalUnreadChats] Chat ${chat.id}: No unread count found for ${readerId} (Value: ${countForReader})`);
            }
        });
        log.info(`[calculateTotalUnreadChats] Final calculated total unread MESSAGES for Reader ${readerId}: ${totalUnreadMessages}`);
    } catch (error) {
        log.error(`[calculateTotalUnreadChats] Error for user ${userId}, reader ${readerId}:`, error);
    }
    // Возвращаем именно количество сообщений, а не чатов
    return totalUnreadMessages;
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
        const userList = usersData ? Object.entries(usersData).map(([username, data]) => ({ Username: username, ...data })) : [];
        // log.info(`[FirebaseService] Fetched ${userList.length} users.`);
        return userList;
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

        // Дополнительная очистка полей в зависимости от роли (ВАЖНО!)
        if (userToSave.Role !== 'Tenant') {
             delete userToSave.Balance;
             delete userToSave.BalanceHistory;
             log.debug(`[saveUser] Removed Tenant-specific fields for ${username} (Role: ${userToSave.Role})`);
        } else {
             // Убедимся, что у Tenant есть эти поля (даже если они null/0)
             if (!userToSave.hasOwnProperty('Balance')) userToSave.Balance = 0;
             if (!userToSave.hasOwnProperty('BalanceHistory')) userToSave.BalanceHistory = {};
        }
        if (userToSave.Role !== 'Owner') {
             delete userToSave.companyProfileCompleted;
             log.debug(`[saveUser] Removed Owner-specific fields for ${username} (Role: ${userToSave.Role})`);
        } else {
             // Убедимся, что у Owner есть это поле (даже если false)
             if (!userToSave.hasOwnProperty('companyProfileCompleted')) userToSave.companyProfileCompleted = false;
        }
        if (userToSave.Role !== 'Staff' && userToSave.Role !== 'Owner') {
            // Убедимся, что у Admin и Tenant нет companyId
            delete userToSave.companyId;
        }

        // Убираем undefined значения перед сохранением
        Object.keys(userToSave).forEach(key => {
            if (userToSave[key] === undefined) {
                 log.warn(`[saveUser] Found undefined value for key '${key}' in user ${username}. Setting to null.`);
                 userToSave[key] = null; // Заменяем undefined на null
            }
        });


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
        // TODO: Подумать об удалении уведомлений пользователя? (Да, стоит удалить)
        await db.ref(`user_notifications/${username}`).remove(); // Удаляем все уведомления
        log.info(`[FirebaseService] Removed notifications for deleted user ${username}.`);

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
        if (!companyId) {
            log.warn("[FirebaseService] getCompanyById called with empty ID.");
            return null;
        }
        const snapshot = await db.ref(`companies/${companyId}`).once('value');
        const companyData = snapshot.val();
        if (companyData) {
            companyData.companyId = companyId; // Добавляем ID в объект для удобства
        }
        // log.debug(`[FirebaseService] Fetched company ${companyId}:`, companyData ? 'Found' : 'Not Found');
        return companyData;
    } catch (error) {
        log.error(`[FirebaseService] Error fetching company ${companyId}:`, error);
        throw error; // Пробрасываем ошибку
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
        const cleanedUpdates = { ...updates }; // Создаем копию
        Object.keys(cleanedUpdates).forEach(key => {
            if (cleanedUpdates[key] === undefined) {
                 log.warn(`[updateCompany] Removing undefined key '${key}' before updating company ${companyId}.`);
                 delete cleanedUpdates[key];
            }
        });

        if (Object.keys(cleanedUpdates).length === 0) {
            log.warn(`[FirebaseService] No valid updates provided for company ${companyId}.`);
            return;
        }
        await db.ref(`companies/${companyId}`).update(cleanedUpdates);
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
        // Убедимся, что удаляем флаг Owner'а
        updates[`/users/${staffUsername}/companyProfileCompleted`] = null;

        await db.ref().update(updates);
        log.info(`[FirebaseService] Staff ${staffUsername} added to company ${companyId}. User role set to Staff.`);
    } catch (error) {
        log.error(`[FirebaseService] Error adding staff ${staffUsername} to company ${companyId}:`, error);
        throw error;
    }
}

/**
 * Удаляет пользователя из персонала компании.
 * Обновляет запись компании и запись пользователя (сбрасывает роль на Tenant и companyId).
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
        updates[`/users/${staffUsername}/Balance`] = 0;           // Сбрасываем баланс
        updates[`/users/${staffUsername}/BalanceHistory`] = {};    // Очищаем историю
        // Удаляем флаг Owner'а, если он был (на всякий случай)
        updates[`/users/${staffUsername}/companyProfileCompleted`] = null;

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
        const propertyList = propertiesData ? Object.entries(propertiesData).map(([id, data]) => ({ Id: id, ...data })) : [];
        // log.info(`[FirebaseService] Fetched ${propertyList.length} properties.`);
        return propertyList;
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
        if (!companyId) {
            log.warn("[FirebaseService] getPropertiesByCompanyId called with empty companyId.");
            return [];
        }
        const snapshot = await db.ref('properties').orderByChild('companyId').equalTo(companyId).once('value');
        const propertiesData = snapshot.val();
        const propertyList = propertiesData ? Object.entries(propertiesData).map(([id, data]) => ({ Id: id, ...data })) : [];
        // log.info(`[FirebaseService] Fetched ${propertyList.length} properties for company ${companyId}.`);
        return propertyList;
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
            // Устанавливаем дату добавления только при создании
            if (!property.AddedDate) property.AddedDate = new Date().toISOString();
            // Устанавливаем начальный рейтинг при создании
            if (property.Rating === undefined) property.Rating = 0;
            if (property.NumberOfReviews === undefined) property.NumberOfReviews = 0;
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
        delete propertyToSave.AdditionalImages; // Удаляем массив DataURL'ов перед сохранением

        await db.ref(`properties/${propertyId}`).set(propertyToSave);
        log.info(`[FirebaseService] Property ${propertyId} (Company: ${propertyToSave.companyId}) saved.`);
        // Возвращаем сохраненный объект с доп. полями, если они нужны дальше
        return { ...propertyToSave, AdditionalImages: property.AdditionalImages || [] };
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
        // TODO: Подумать об удалении связанных бронирований/отзывов/чатов?
        // Сейчас просто удаляем объект.
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
        if (!bookingId) {
             log.warn("[FirebaseService] getBookingById called with empty ID.");
             return null;
        }
        const snapshot = await db.ref(`bookings/${bookingId}`).once('value');
        const bookingData = snapshot.val();
        if (bookingData) {
            bookingData.Id = bookingId; // Добавляем ID
        }
        // log.debug(`[FirebaseService] Fetched booking ${bookingId}:`, bookingData ? 'Found' : 'Not Found');
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
        const bookingList = bookingsData ? Object.entries(bookingsData).map(([id, data]) => ({ Id: id, ...data })) : [];
        // log.info(`[FirebaseService] Fetched ${bookingList.length} total bookings.`);
        return bookingList;
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
        if (!userId) {
            log.warn("[FirebaseService] getBookingsByUserId called with empty userId.");
            return [];
        }
        const snapshot = await db.ref('bookings').orderByChild('UserId').equalTo(userId).once('value');
        const bookingsData = snapshot.val();
        const bookingList = bookingsData ? Object.entries(bookingsData).map(([id, data]) => ({ Id: id, ...data })) : [];
        // log.info(`[FirebaseService] Fetched ${bookingList.length} bookings for user ${userId}.`);
        return bookingList;
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
            // Добавляем дату создания, если ее нет
            if (!booking.CreatedAt) booking.CreatedAt = new Date().toISOString();
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

/**
 * Получает бронирования по определенному статусу, опционально фильтруя по компании.
 * @param {string} status Требуемый статус ('Ожидает подтверждения', 'Активна' и т.д.).
 * @param {string} [companyId] Опциональный ID компании для фильтрации.
 * @returns {Promise<Array<object>>} Массив отфильтрованных бронирований.
 */
async function getBookingsByStatus(status, companyId = null) {
    log.info(`[getBookingsByStatus] Fetching bookings with status '${status}'${companyId ? ' for company ' + companyId : ''}`);
    try {
        const allBookings = await getAllBookings(); // Получаем все бронирования
        let filteredBookings = allBookings.filter(booking => booking && booking.Status === status);

        if (companyId) {
            // Если указана компания, фильтруем дополнительно
            const companyProperties = await getPropertiesByCompanyId(companyId);
            const companyPropertyIds = new Set(companyProperties.map(p => p.Id));
            filteredBookings = filteredBookings.filter(booking =>
                booking && booking.PropertyId && companyPropertyIds.has(booking.PropertyId)
            );
            log.debug(`[getBookingsByStatus] Filtered ${filteredBookings.length} bookings for company ${companyId} and status '${status}'.`);
        } else {
            log.debug(`[getBookingsByStatus] Found ${filteredBookings.length} bookings with status '${status}' (all companies).`);
        }

        return filteredBookings;
    } catch (error) {
        log.error(`[FirebaseService] Error in getBookingsByStatus (status: ${status}, company: ${companyId}):`, error);
        return []; // Возвращаем пустой массив при ошибке
    }
}

/**
 * Получает предстоящие заезды и выезды для активных бронирований в ближайшие N дней.
 * @param {string} [companyId] Опциональный ID компании для фильтрации.
 * @param {number} [daysAhead=7] Количество дней для проверки (включая сегодня).
 * @returns {Promise<{checkIns: Array<object>, checkOuts: Array<object>}>} Объект с массивами заездов и выездов.
 */
async function getUpcomingCheckInsOuts(companyId = null, daysAhead = 7) {
    log.info(`[getUpcomingCheckInsOuts] Fetching upcoming check-ins/outs within ${daysAhead} days${companyId ? ' for company ' + companyId : ''}`);
    try {
        const allBookings = await getAllBookings();
        let relevantBookings = allBookings.filter(b => b && b.Status === 'Активна'); // Только активные

        if (companyId) {
            // Фильтруем по компании, если указана
            const companyProperties = await getPropertiesByCompanyId(companyId);
            const companyPropertyIds = new Set(companyProperties.map(p => p.Id));
            relevantBookings = relevantBookings.filter(b =>
                b && b.PropertyId && companyPropertyIds.has(b.PropertyId)
            );
            log.debug(`[getUpcomingCheckInsOuts] Found ${relevantBookings.length} active bookings for company ${companyId}.`);
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0); // Устанавливаем начало текущего дня
        const todayMs = today.getTime();

        const futureDate = new Date(today);
        futureDate.setDate(today.getDate() + daysAhead);
        const futureDateMs = futureDate.getTime();

        const checkIns = [];
        const checkOuts = [];

        relevantBookings.forEach(booking => {
            try {
                if (booking.StartDate) {
                    const startDate = new Date(booking.StartDate);
                    startDate.setHours(0, 0, 0, 0);
                    const startMs = startDate.getTime();
                    if (startMs >= todayMs && startMs < futureDateMs) {
                         // Добавляем детали объекта для удобства отображения
                         // Попробуем получить из кэша или сделать доп. запрос
                         // Пока просто добавим ID
                        checkIns.push({ ...booking, propertyTitle: `ID: ${booking.PropertyId}` });
                    }
                }
                if (booking.EndDate) {
                    const endDate = new Date(booking.EndDate);
                    endDate.setHours(0, 0, 0, 0);
                    const endMs = endDate.getTime();
                    // Заезд может быть сегодня, а выезд - нет. Выезды ищем >= today и < future
                    if (endMs >= todayMs && endMs < futureDateMs) {
                        checkOuts.push({ ...booking, propertyTitle: `ID: ${booking.PropertyId}` });
                    }
                }
            } catch (dateError) {
                log.warn(`[getUpcomingCheckInsOuts] Error processing dates for booking ${booking.Id}:`, dateError);
            }
        });

        log.info(`[getUpcomingCheckInsOuts] Found ${checkIns.length} upcoming check-ins and ${checkOuts.length} check-outs.`);

        // TODO: Оптимизация - Можно добавить получение названий объектов одним запросом после фильтрации
        // Например, собрать все PropertyId из checkIns и checkOuts, получить их и добавить Title

        return { checkIns, checkOuts };

    } catch (error) {
        log.error(`[FirebaseService] Error in getUpcomingCheckInsOuts (company: ${companyId}, days: ${daysAhead}):`, error);
        return { checkIns: [], checkOuts: [] }; // Возвращаем пустые массивы при ошибке
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
        if (!propertyId) {
             log.warn("[FirebaseService] getPropertyReviews called with empty propertyId.");
             return [];
        }
        const snapshot = await db.ref(`properties/${propertyId}/reviews`).once('value');
        const reviewsData = snapshot.val();
        const reviewList = reviewsData ? Object.entries(reviewsData).map(([id, data]) => ({ reviewId: id, ...data })) : [];
        // log.debug(`[FirebaseService] Fetched ${reviewList.length} reviews for property ${propertyId}.`);
        return reviewList;
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
        const snapshot = await db.ref(`properties/${propertyId}/reviews`)
                                .orderByChild('userId') // Убедитесь, что поле называется 'userId'
                                .equalTo(userId)
                                .limitToFirst(1)
                                .once('value');
        const exists = snapshot.exists();
        // log.debug(`[FirebaseService] User ${userId} reviewed property ${propertyId}: ${exists}`);
        return exists;
    } catch (error) {
        log.error(`[FirebaseService] Error checking review status for prop ${propertyId}, user ${userId}:`, error);
        return true; // Fail safe
    }
}


// --- Уведомления (Notifications - колокольчик) ---

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
            timestamp: admin.database.ServerValue.TIMESTAMP, // Используем серверное время для точности
            read: false,
            type: notificationData.type,
            title: notificationData.title,
            message: notificationData.message,
            ...(notificationData.bookingId && { bookingId: notificationData.bookingId }) // Добавляем bookingId, если он есть
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
    if (!userId) {
        log.warn("[FirebaseService:getLastNotifications] Called with empty userId.");
        return [];
    }
    try {
        const snapshot = await db.ref(`user_notifications/${userId}`)
                                .orderByChild('timestamp') // Сортируем по времени
                                .limitToLast(limit) // Берем последние N
                                .once('value');
        const data = snapshot.val();
        if (!data) return [];
        // Преобразуем в массив и сортируем еще раз на клиенте (новые сверху)
        const notificationList = Object.values(data).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        // log.debug(`[FirebaseService:getLastNotifications] Fetched ${notificationList.length} notifications for ${userId}.`);
        return notificationList;
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
             return true; // Считаем успехом, т.к. делать нечего
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
    if (!chatId) {
        log.warn("[FirebaseService] getChatById called with empty ID.");
        return null;
    }
    try {
        const snapshot = await db.ref(`chats/${chatId}`).once('value');
        const chatData = snapshot.val();
        if (chatData) chatData.id = chatId; // Добавляем ID для удобства
        // log.debug(`[FirebaseService] Fetched chat ${chatId}:`, chatData ? 'Found' : 'Not Found');
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
        const userChatsSnapshot = await db.ref(`user_chats/${userId}`)
                                        .orderByValue() // Сортируем по timestamp'у
                                        .limitToLast(100) // Ограничиваем количество для производительности
                                        .once('value');
        const userChatIdsObject = userChatsSnapshot.val();
        if (userChatIdsObject) {
            Object.keys(userChatIdsObject).forEach(id => chatIds.add(id));
            log.debug(`[getUserChats] Found ${Object.keys(userChatIdsObject).length} chat IDs for user ${userId}`);
        }

        // Загружаем чаты компании (если применимо)
        if (companyId) {
            const companyChatsSnapshot = await db.ref(`company_chats/${companyId}`)
                                               .orderByValue()
                                               .limitToLast(100)
                                               .once('value');
            const companyChatIdsObject = companyChatsSnapshot.val();
            if (companyChatIdsObject) {
                Object.keys(companyChatIdsObject).forEach(id => chatIds.add(id));
                log.debug(`[getUserChats] Found ${Object.keys(companyChatIdsObject).length} chat IDs for company ${companyId}`);
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
 * @param {object} chatData Данные нового чата. Должен содержать `participants` (объект или массив).
 * @returns {Promise<string>} ID созданного чата.
 */
async function createChat(chatData) {
    if (!chatData || !chatData.participants) {
        throw new Error("Invalid chat data provided for creation (missing participants).");
    }
    try {
        const newChatRef = db.ref('chats').push();
        const newChatId = newChatRef.key;
        if (!newChatId) throw new Error("Failed to generate chat ID.");

        // Убедимся, что timestamp'ы являются ServerValue или числами
        if (chatData.createdAt === undefined) chatData.createdAt = admin.database.ServerValue.TIMESTAMP;
        if (chatData.lastMessageTimestamp === undefined) chatData.lastMessageTimestamp = admin.database.ServerValue.TIMESTAMP;

        // Инициализируем счетчики непрочитанных и время прочтения для всех участников,
        // только если они не были предоставлены
        if (!chatData.unreadCounts) chatData.unreadCounts = {};
        if (!chatData.lastReadTimestamp) chatData.lastReadTimestamp = {};

        let participantIds = [];
        if (Array.isArray(chatData.participants)) {
             participantIds = chatData.participants.filter(Boolean);
             // Преобразуем массив в объект для хранения в БД
             const participantsObj = {};
             participantIds.forEach(id => { participantsObj[id] = true; });
             chatData.participants = participantsObj;
        } else if (typeof chatData.participants === 'object') {
             participantIds = Object.keys(chatData.participants).filter(id => chatData.participants[id]);
        } else {
             throw new Error("Invalid participants format. Must be array or object.");
        }

        participantIds.forEach(participantId => {
            if (!chatData.unreadCounts.hasOwnProperty(participantId)) {
                chatData.unreadCounts[participantId] = 0; // Изначально 0
            }
            // Изначально время прочтения не ставим, или ставим 0? Ставим 0.
             if (!chatData.lastReadTimestamp.hasOwnProperty(participantId)) {
                 chatData.lastReadTimestamp[participantId] = 0;
             }
        });

        log.info(`[createChat] Attempting to set chat data for new chat ID ${newChatId}:`, chatData);
        await newChatRef.set(chatData);
        log.info(`[FirebaseService] Chat ${newChatId} created successfully.`);
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
        const userChatLinks = await db.ref(`user_chats/${tenantId}`).orderByValue().once('value');
        const userChatIdsObject = userChatLinks.val() || {};
        const userChatIds = Object.entries(userChatIdsObject)
                                  .sort(([, tsA], [, tsB]) => (tsB || 0) - (tsA || 0))
                                  .map(([id]) => id);

        if (userChatIds.length === 0) {
            log.debug(`[findExistingChat] User ${tenantId} has no chats.`);
            return null;
        }
        log.debug(`[findExistingChat] Found ${userChatIds.length} chats for user ${tenantId}. Checking participants and property...`);

        for (const chatId of userChatIds) {
            const chat = await getChatById(chatId);
            if (chat && chat.participants && chat.participants[companyId]) {
                if (propertyId) {
                    if (chat.propertyId === propertyId) {
                        log.debug(`[findExistingChat] Found existing chat ${chatId} matching property ${propertyId}.`);
                        return chatId;
                    }
                } else {
                    if (!chat.propertyId) { // Ищем общий чат
                        log.debug(`[findExistingChat] Found existing general chat ${chatId} (no property linked).`);
                        return chatId;
                    }
                }
            }
        }
        log.debug(`[findExistingChat] No existing chat found matching criteria.`);
        return null;
    } catch (error) {
        log.error(`[FirebaseService] Error finding existing chat for ${tenantId}/${companyId}:`, error);
        return null;
    }
}


/**
 * Обновляет метаданные чата при отправке нового сообщения.
 * Использует транзакцию для атомарного увеличения счетчиков непрочитанных.
 * @param {string} chatId ID чата.
 * @param {object} data Данные для обновления: { lastMessageText, lastMessageTimestamp, lastMessageSenderId, recipientsToIncrementUnread }
 * @returns {Promise<boolean>} true если обновление успешно, иначе false.
 */
async function updateChatMetadata(chatId, data) {
    if (!chatId || !data) {
        log.warn('[updateChatMetadata] Invalid parameters:', { chatId, data });
        return false;
    }
    log.info(`[updateChatMetadata] Starting NON-TRANSACTIONAL update for chat ${chatId} with data:`, data);
    try {
        const updates = {};
        // Обновляем основные метаданные
        if (data.lastMessageText !== undefined) updates[`/chats/${chatId}/lastMessageText`] = data.lastMessageText;
        if (data.lastMessageTimestamp !== undefined) updates[`/chats/${chatId}/lastMessageTimestamp`] = data.lastMessageTimestamp;
        if (data.lastMessageSenderId !== undefined) updates[`/chats/${chatId}/lastMessageSenderId`] = data.lastMessageSenderId;

        // Атомарно обновляем счетчики непрочитанных с помощью ServerValue.increment
        if (data.recipientsToIncrementUnread && Array.isArray(data.recipientsToIncrementUnread)) {
            log.debug(`[updateChatMetadata] Preparing increments for recipients:`, data.recipientsToIncrementUnread);
            data.recipientsToIncrementUnread.forEach(recipientId => {
                if (recipientId) { // Пропускаем пустые ID
                    updates[`/chats/${chatId}/unreadCounts/${recipientId}`] = admin.database.ServerValue.increment(1);
                    log.debug(`[updateChatMetadata] Added increment operation for ${recipientId} in chat ${chatId}.`);
                }
            });
        }

        if (Object.keys(updates).length === 0) {
             log.warn(`[updateChatMetadata] No valid fields to update for chat ${chatId}.`);
             return true; // Нечего обновлять
        }

        log.debug(`[updateChatMetadata] Performing multi-path update for chat ${chatId}:`, updates);
        await db.ref().update(updates);
        log.info(`[updateChatMetadata] Non-transactional update for chat ${chatId} completed successfully.`);
        return true;
    } catch (error) {
        log.error(`[updateChatMetadata] Non-transactional update error for chat ${chatId}:`, error);
        return false;
    }
}

/**
 * Обновляет данные чата. НЕ ИСПОЛЬЗУЕТ ТРАНЗАКЦИЮ.
 * Используйте `updateChatMetadata` для счетчиков.
 * @param {string} chatId ID чата.
 * @param {object} updates Объект с полями для обновления.
 * @returns {Promise<boolean>} Успешность операции.
 */
async function updateChat(chatId, updates) {
    if (!chatId || !updates || typeof updates !== 'object') {
        log.warn(`[updateChat] Invalid input. Chat: ${chatId}, UpdateData:`, updates);
        return false;
    }
    try {
        // Очищаем от undefined
        const cleanedUpdates = { ...updates };
        Object.keys(cleanedUpdates).forEach(key => cleanedUpdates[key] === undefined && delete cleanedUpdates[key]);
        if (Object.keys(cleanedUpdates).length === 0) {
             log.info(`[updateChat] No valid fields to update for chat ${chatId}.`);
             return true; // Считаем успехом, т.к. нечего обновлять
        }
        await db.ref(`chats/${chatId}`).update(cleanedUpdates);
        log.info(`[updateChat] Successfully updated chat ${chatId} with:`, cleanedUpdates);
        return true;
    } catch (error) {
        log.error(`[FirebaseService] Error updating chat ${chatId}:`, error);
        return false;
    }
}

/**
 * Сбрасывает счетчик непрочитанных сообщений для указанного участника чата.
 * @param {string} chatId ID чата.
 * @param {string} readerId ID пользователя или компании, который прочитал сообщения.
 * @returns {Promise<boolean>} Успешность операции.
 */
async function resetUnreadCount(chatId, readerId) {
    if (!chatId || !readerId) {
        log.warn(`[resetUnreadCount] Invalid chatId or readerId. Chat: ${chatId}, Reader: ${readerId}`);
        return false;
    }
    log.debug(`[resetUnreadCount] Resetting unread count for reader ${readerId} in chat ${chatId}`);
    try {
        // Используем update, чтобы создать поле, если его нет, или установить 0
        await db.ref(`chats/${chatId}/unreadCounts`).update({ [readerId]: 0 });
        log.info(`[resetUnreadCount] Unread count reset for ${readerId} in chat ${chatId}.`);
        return true;
    } catch (error) {
        log.error(`[FirebaseService] Error resetting unread count for ${readerId} in chat ${chatId}:`, error);
        return false;
    }
}

/**
 * Обновляет время последнего прочтения для участника чата.
 * @param {string} chatId ID чата.
 * @param {string} readerId ID пользователя или компании.
 * @param {number} timestamp Метка времени прочтения (Date.now()).
 * @returns {Promise<boolean>} Успешность операции.
 */
async function updateLastReadTimestamp(chatId, readerId, timestamp) {
    if (!chatId || !readerId || typeof timestamp !== 'number') {
        log.warn(`[updateLastReadTimestamp] Invalid input. Chat: ${chatId}, Reader: ${readerId}, Timestamp: ${timestamp}`);
        return false;
    }
    log.debug(`[updateLastReadTimestamp] Updating for reader ${readerId} in chat ${chatId} to timestamp ${timestamp}`);
    try {
        // Используем update, чтобы создать поле, если его нет
        await db.ref(`chats/${chatId}/lastReadTimestamp`).update({ [readerId]: timestamp });
        log.info(`[updateLastReadTimestamp] Timestamp updated for ${readerId} in chat ${chatId}.`);
        return true;
    } catch (error) {
        log.error(`[FirebaseService] Error updating last read timestamp for ${readerId} in chat ${chatId}:`, error);
        return false;
    }
}

/**
 * Атомарно сбрасывает счетчик непрочитанных и обновляет время последнего прочтения.
 * @param {string} chatId ID чата.
 * @param {string} readerId ID прочитавшего участника.
 * @param {number} readTimestamp Время прочтения (Date.now()).
 * @returns {Promise<boolean>} Успешность операции.
 */
async function resetUnreadCountAndTimestamp(chatId, readerId, readTimestamp) {
    if (!chatId || !readerId) {
        log.warn('[resetUnreadCountAndTimestamp] Invalid parameters:', { chatId, readerId });
        return false;
    }
    log.info(`[resetUnreadCountAndTimestamp] Starting NON-TRANSACTIONAL reset for Chat: ${chatId}, Reader: ${readerId}, Timestamp: ${readTimestamp}`);
    try {
        const updates = {};
        updates[`/chats/${chatId}/unreadCounts/${readerId}`] = 0; // Сброс счетчика
        updates[`/chats/${chatId}/lastReadTimestamp/${readerId}`] = readTimestamp; // Обновление времени

        log.debug(`[resetUnreadCountAndTimestamp] Performing multi-path update for chat ${chatId}, reader ${readerId}:`, updates);
        await db.ref().update(updates);
        log.info(`[resetUnreadCountAndTimestamp] Non-transactional reset for chat ${chatId}, reader ${readerId} completed successfully.`);
        return true;
    } catch (error) {
        log.error(`[resetUnreadCountAndTimestamp] Non-transactional reset error for chat ${chatId}, reader ${readerId}:`, error);
        return false;
    }
}

/**
 * Атомарно обновляет данные чата (общий метод).
 * Используйте его, если нужно обновить несколько полей за раз.
 * @param {string} chatId ID чата.
 * @param {object} updates Объект с путями и значениями для обновления.
 * @returns {Promise<boolean>} Успешность операции.
 */
async function updateChatAtomic(chatId, updates) {
    try {
        if (!chatId || !updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
            log.warn('[FirebaseService] updateChatAtomic called with invalid chatId or empty updates.');
            return false;
        }
        // Создаем правильные пути для атомарного обновления
        const atomicUpdates = {};
        for (const key in updates) {
             atomicUpdates[`/chats/${chatId}/${key}`] = updates[key];
        }
        await db.ref().update(atomicUpdates);
        log.info(`[FirebaseService] Atomic update performed on chat ${chatId}.`);
        return true;
    } catch (error) {
        log.error(`[FirebaseService] Error during atomic update for chat ${chatId}:`, error);
        return false;
    }
}


// --- Сообщения (Messages) ---

/**
 * Создает новое сообщение в /messages/{chatId}.
 * @param {object} messageData Данные сообщения {chatId, senderId, senderRole, text, timestamp?}.
 * @returns {Promise<object>} Созданный объект сообщения с присвоенным ID и timestamp.
 */
async function createMessage(messageData) {
    try {
        if (!messageData || !messageData.chatId || !messageData.senderId || !messageData.text) {
            throw new Error("Missing required fields for creating message (chatId, senderId, text).");
        }
        const messageRef = db.ref(`messages/${messageData.chatId}`).push();
        const messageId = messageRef.key;
        if (!messageId) throw new Error("Failed to generate message ID.");

        // Используем серверное время, если timestamp не передан
        const timestamp = messageData.timestamp || admin.database.ServerValue.TIMESTAMP;

        const messageToSave = {
             id: messageId, // Дублируем ID в объект
             chatId: messageData.chatId,
             senderId: messageData.senderId,
             senderRole: messageData.senderRole || 'Unknown', // Добавляем роль, если есть
             text: messageData.text,
             timestamp: timestamp
        };

        await messageRef.set(messageToSave);
        log.info(`[FirebaseService] Message ${messageId} created in chat ${messageData.chatId}.`);

        // Возвращаем объект с потенциально разрешенным серверным timestamp'ом
        // Firebase не возвращает разрешенное значение сразу, нужно делать read или передавать Date.now()
        // Для простоты вернем то, что сохранили, предполагая, что ServerValue сработает
        // Или лучше сразу использовать Date.now() при создании? Используем Date.now(), если timestamp не передан.
        const finalTimestamp = messageData.timestamp || Date.now();
        return { ...messageToSave, timestamp: finalTimestamp };

    } catch (error) {
        log.error('[FirebaseService] Error creating message:', error);
        throw error;
    }
}

/**
 * Получает сообщения для конкретного чата с пагинацией.
 * Включает логику для определения, прочитано ли сообщение получателем.
 * @param {string} chatId ID чата.
 * @param {object} requestingUser Объект текущего пользователя (для определения isOwnMessage и isReadByRecipient).
 * @param {number} [limit=50] Количество сообщений для загрузки.
 * @param {number|null} [beforeTimestamp=null] Timestamp самого старого загруженного сообщения (для загрузки более старых).
 * @returns {Promise<Array<object>>} Массив объектов сообщений, отсортированных по времени (старые сверху).
 */
async function getChatMessages(chatId, requestingUser, limit = 50, beforeTimestamp = null) {
    if (!chatId || !requestingUser || !requestingUser.username) {
        log.warn('[getChatMessages] Invalid parameters: chatId or requestingUser missing.');
        return [];
    }
    log.debug(`[getChatMessages] Fetching messages for chat ${chatId}, user ${requestingUser.username}, limit ${limit}, before ${beforeTimestamp}`);

    try {
        let query = db.ref(`messages/${chatId}`).orderByChild('timestamp');

        if (beforeTimestamp && typeof beforeTimestamp === 'number' && beforeTimestamp > 0) {
            // End before the specified timestamp (exclusive, so subtract 1ms)
             query = query.endAt(beforeTimestamp - 1);
             log.debug(`[getChatMessages] Applying endAt filter: ${beforeTimestamp - 1}`);
        }

        // Берем последние N сообщений (до endAt, если он есть)
        query = query.limitToLast(limit);

        const snapshot = await query.once('value');
        if (!snapshot.exists()) {
            log.info(`[getChatMessages] No messages found for chat ${chatId}.`);
            return [];
        }

        const messagesData = snapshot.val();
        const messagesArray = messagesData ? Object.entries(messagesData).map(([id, data]) => ({ id: id, ...data })) : [];

        if (messagesArray.length === 0) {
            log.info(`[getChatMessages] Message data object was empty for chat ${chatId}.`);
            return [];
        }

        // Сортируем сообщения по timestamp (старые в начале)
        messagesArray.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        log.debug(`[getChatMessages] Fetched ${messagesArray.length} messages for chat ${chatId}.`);

        // Получаем данные чата один раз для определения времени прочтения
        const chatData = await getChatById(chatId);
        const participantsData = chatData?.participants || {};
        const lastReadTimestamps = chatData?.lastReadTimestamp || {};

        // Определяем ID других участников (не текущего пользователя/его компании)
        const currentParticipantId = (requestingUser.role === 'Owner' || requestingUser.role === 'Staff') ? requestingUser.companyId : requestingUser.username;
        const otherParticipantIds = Object.keys(participantsData).filter(pId => pId !== currentParticipantId);

        // Определяем минимальное время прочтения среди ВСЕХ ДРУГИХ участников
        let minOtherReadTimestamp = Infinity;
        otherParticipantIds.forEach(pId => {
            const readTs = lastReadTimestamps[pId];
            if (typeof readTs === 'number' && readTs > 0) {
                minOtherReadTimestamp = Math.min(minOtherReadTimestamp, readTs);
            } else {
                // Если хоть один не прочитал (нет timestamp'а или он 0), считаем, что никто не прочитал
                minOtherReadTimestamp = 0;
            }
        });
        if (minOtherReadTimestamp === Infinity) minOtherReadTimestamp = 0; // Если других участников нет или никто не читал
        log.debug(`[getChatMessages] Min read timestamp by others for chat ${chatId}: ${minOtherReadTimestamp}`);

        // Обогащаем каждое сообщение
        const enrichedMessages = messagesArray.map(msg => {
             const isOwn = msg.senderId === requestingUser.username;
             // Сообщение прочитано получателем(ями), если ОНО СВОЕ (isOwn = true)
             // И его timestamp МЕНЬШЕ ИЛИ РАВЕН минимальному времени прочтения ДРУГИХ участников
             const isRead = isOwn && msg.timestamp <= minOtherReadTimestamp;
             return {
                 ...msg,
                 isOwnMessage: isOwn,
                 isReadByRecipient: isRead // Флаг для галочек
             };
        });

        return enrichedMessages;

    } catch (error) {
        log.error(`[FirebaseService] Error fetching messages for chat ${chatId}:`, error);
        throw error;
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
        if (user && user.ImageData && typeof user.ImageData === 'string') {
            // Простая проверка на JPEG или PNG по началу base64 строки
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
        if (company && company.companyLogoData && typeof company.companyLogoData === 'string') {
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
    calculateTotalUnreadChats,
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
    getBookingsByStatus,
    getUpcomingCheckInsOuts,
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
    // Chats
    getChatById,
    getUserChats,
    createChat,
    findExistingChat,
    updateChatMetadata,
    updateChat,
    resetUnreadCount,
    updateLastReadTimestamp,
    resetUnreadCountAndTimestamp,
    updateChatAtomic,
    // Messages
    createMessage,
    getChatMessages,
    // Helpers
    getUserAvatarDataUri,
    getCompanyLogoDataUri,
};