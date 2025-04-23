// public/js/chat.js (Полная обновленная версия)

// --- Глобальные переменные для состояния чата ---
let currentChatId = null; // ID текущего открытого чата
let isLoadingMessages = false; // Флаг, идет ли загрузка старых сообщений
let hasMoreMessages = true; // Флаг, есть ли еще сообщения для загрузки
let oldestMessageTimestamp = null; // Timestamp самого старого загруженного сообщения
let socket = null; // Глобальная переменная для объекта Socket.IO

// --- Функции для установки переменных извне (вызываются из EJS при загрузке chat-view) ---
/**
 * Устанавливает timestamp самого старого сообщения (для пагинации).
 * @param {number} timestamp - Timestamp сообщения.
 */
window.setOldestMessageTimestamp = (timestamp) => {
    if (typeof timestamp === 'number' && timestamp > 0) {
        oldestMessageTimestamp = timestamp;
        console.log('[Chat View Init] Initial oldestMessageTimestamp set to:', oldestMessageTimestamp);
    } else {
        console.warn('[Chat View Init] Attempted to set invalid oldestMessageTimestamp:', timestamp);
        oldestMessageTimestamp = null; // Сбрасываем, если некорректно
    }
};

/**
 * Устанавливает флаг наличия более старых сообщений и обновляет видимость кнопки.
 * @param {boolean} hasMore - true, если есть еще сообщения, иначе false.
 */
window.updateHasMoreMessages = (hasMore) => {
    hasMoreMessages = hasMore === true; // Приводим к boolean
    console.log('[Chat View Init] Initial hasMoreMessages set to:', hasMoreMessages);
    const messageList = document.getElementById('messageList');
    const loadMoreBtn = messageList?.querySelector('#loadMoreMessagesBtnInstance');
    if (loadMoreBtn) {
        loadMoreBtn.classList.toggle('hidden', !hasMoreMessages);
    }
};

/**
 * Добавляет элемент сообщения в контейнер чата.
 * Корректно обрабатывает классы 'own'/'other' и 'read', а также галочки.
 * @param {object} message - Объект сообщения (должен содержать id, text, timestamp, isOwnMessage, isReadByRecipient, timestampFormatted).
 * @param {HTMLElement} container - DOM-элемент контейнера сообщений (#messageList).
 * @param {boolean} [prepend=false] - Добавить в начало (true) или в конец (false).
 */
const appendMessage = (message, container, prepend = false) => {
    if (!message || !container || typeof message.text === 'undefined') {
        console.warn("appendMessage: Invalid message or container.", { message, container });
        return;
    }
    const bubble = document.createElement('div');
    const isOwn = message.isOwnMessage === true;
    // Определяем прочитано ли оно ПОЛУЧАТЕЛЕМ (для галочек)
    const isReadByRecipient = isOwn && message.isReadByRecipient === true;

    bubble.className = `message-bubble ${isOwn ? 'own' : 'other'} ${isReadByRecipient ? 'read' : ''}`;
    bubble.dataset.timestamp = message.timestamp || Date.now();
    bubble.dataset.messageId = message.id || '';

    const textEl = document.createElement('div');
    textEl.className = 'message-text';
    textEl.textContent = message.text;

    const metaEl = document.createElement('div');
    metaEl.className = 'message-meta';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    
    // Проверяем валидность timestamp и форматируем время
    let timeText = '--:--';
    if (message.timestamp) {
        const date = new Date(message.timestamp);
        if (!isNaN(date.getTime())) {
            try {
                timeText = date.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit'
                });
            } catch (e) {
                console.warn('Error formatting time:', e);
            }
        }
    }
    timeSpan.textContent = timeText;
    
    metaEl.appendChild(timeSpan);

    // Добавляем галочки только для СВОИХ сообщений
    if (isOwn) {
        const ticksSpan = document.createElement('span');
        ticksSpan.className = 'message-status-ticks';
        // Ставим двойную галочку, если isReadByRecipient=true
        ticksSpan.innerHTML = `<i class="fas ${isReadByRecipient ? 'fa-check-double' : 'fa-check'}"></i>`;
        metaEl.appendChild(ticksSpan);
    }

    bubble.appendChild(textEl);
    bubble.appendChild(metaEl);

    if (prepend) {
        const loadMoreBtn = container.querySelector('.load-more-btn');
        if (loadMoreBtn) {
            container.insertBefore(bubble, loadMoreBtn.nextSibling);
        } else {
            container.prepend(bubble);
        }
        if (message.timestamp && typeof message.timestamp === 'number' && (!oldestMessageTimestamp || message.timestamp < oldestMessageTimestamp)) {
            oldestMessageTimestamp = message.timestamp;
            console.log("Updated oldestMessageTimestamp (prepend):", oldestMessageTimestamp);
        }
    } else {
        container.appendChild(bubble);
    }
};


/**
 * Прокручивает контейнер сообщений вниз.
 * @param {HTMLElement} element - Контейнер сообщений.
 * @param {boolean} [smooth=false] - Использовать плавную прокрутку.
 */
const scrollToBottom = (element, smooth = false) => {
    if (!element) return;
    if (smooth) {
        element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    } else {
        requestAnimationFrame(() => {
            element.scrollTop = element.scrollHeight;
        });
    }
};

/**
 * Функция открытия чата. Загружает данные чата и сообщения через API.
 * Доступна глобально как window.openChat.
 * @param {string} chatId - ID чата для открытия.
 */
window.openChat = async (chatId) => {
    const messageList = document.getElementById('messageList');
    const chatPlaceholder = document.getElementById('chatPlaceholder');
    const chatView = document.getElementById('chatView');
    const chatViewHeaderName = document.getElementById('chatViewHeaderName');
    const chatViewSubjectLink = document.getElementById('chatViewSubjectLink');
    const messageInputForm = document.getElementById('messageInputForm');
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    const loadMoreBtnTemplate = document.getElementById('loadMoreMessagesBtn');

    if (!messageList || !chatPlaceholder || !chatView || !chatViewHeaderName || !messageInputForm || !sendMessageBtn || !loadMoreBtnTemplate) {
        console.error("Ключевые элементы UI чата не найдены!");
        return;
    }

    if (isLoadingMessages || currentChatId === chatId) {
        console.log(`Chat ${chatId} is already open or loading.`);
        return;
    }
    console.log(`[openChat] Opening chat: ${chatId}`);
    currentChatId = chatId;
    hasMoreMessages = true;
    oldestMessageTimestamp = null;

    // Обновление UI списка чатов
    document.querySelectorAll('.chat-list-item.active').forEach(el => el.classList.remove('active'));
    const chatListItem = document.querySelector(`.chat-list-item[data-chat-id="${chatId}"]`);
    if (chatListItem) {
        chatListItem.classList.add('active');
        // Сбрасываем стиль 'unread' и скрываем бейдж при открытии
        chatListItem.classList.remove('unread');
        const badge = chatListItem.querySelector('.unread-badge');
        if (badge) {
            badge.textContent = '0';
            badge.style.display = 'none';
            badge.classList.remove('animate-pulse');
        }
    }

    // Подготовка основной области чата
    chatPlaceholder.style.display = 'none';
    chatView.classList.remove('hidden');
    messageList.innerHTML = '';

    isLoadingMessages = true;
    try {
        // Отправляем событие о прочтении на сервер ПЕРЕД загрузкой деталей чата
        if (socket) {
            socket.emit('mark_chat_read', chatId);
            console.log(`[openChat] Sent mark_chat_read event for chat ${chatId}`);
        }

        // Сразу обновляем UI для лучшего UX
        const chatListItem = document.querySelector(`.chat-list-item[data-chat-id="${chatId}"]`);
        if (chatListItem) {
            chatListItem.classList.remove('unread');
            const badge = chatListItem.querySelector('.unread-badge');
            if (badge) {
                badge.style.display = 'none';
                badge.classList.remove('pulse');
            }
        }

        // Загрузка данных чата через API
        console.log(`[openChat] Fetching details from /api/chats/${chatId}/details`);
        const response = await fetch(`/api/chats/${chatId}/details`);
        if (!response.ok) { throw new Error(`Ошибка загрузки данных чата: ${response.statusText}`); }
        const chatDetails = await response.json();
        if (!chatDetails.success) { throw new Error(chatDetails.error || 'Ошибка в данных чата.'); }
        console.log("[openChat] Received chat details via API:", chatDetails);

        // Обновляем заголовок и тему чата
        if (chatViewHeaderName) chatViewHeaderName.textContent = chatDetails.otherParticipantName || 'Чат';
        if (chatViewSubjectLink) {
            if (chatDetails.subjectLink && chatDetails.chatSubject) {
                chatViewSubjectLink.href = chatDetails.subjectLink;
                chatViewSubjectLink.textContent = chatDetails.chatSubject;
                chatViewSubjectLink.style.display = 'inline';
            } else {
                chatViewSubjectLink.style.display = 'none';
            }
        }

        // Отображаем сообщения из JSON
        const messages = chatDetails.messages || [];
        const actualLoadMoreBtnInstance = messageList.querySelector('#loadMoreMessagesBtnInstance');

        if (messages.length === 0) {
            hasMoreMessages = false;
            if (actualLoadMoreBtnInstance) actualLoadMoreBtnInstance.classList.add('hidden');
            const noMsgP = document.createElement('p');
            noMsgP.textContent = "Нет сообщений в этом чате.";
            noMsgP.style.cssText = 'text-align: center; color: var(--text-secondary); padding: 20px;';
            messageList.appendChild(noMsgP);
        } else {
            // Устанавливаем oldest timestamp для пагинации
            // Сообщения приходят [старые, ..., новые], берем timestamp первого
            oldestMessageTimestamp = messages[0]?.timestamp || null;
            console.log("[openChat] Initial oldestMessageTimestamp from API:", oldestMessageTimestamp);
            messages.forEach(msg => appendMessage(msg, messageList)); // Добавляем в конец

            // Определяем, есть ли еще сообщения для загрузки
            const initialLoadLimit = chatDetails.limit || 50; // Лимит, с которым пришли сообщения
            if (messages.length < initialLoadLimit) {
                hasMoreMessages = false;
                if (actualLoadMoreBtnInstance) actualLoadMoreBtnInstance.classList.add('hidden');
                console.log("[openChat] No more messages initially.");
            } else {
                hasMoreMessages = true;
                if (actualLoadMoreBtnInstance) actualLoadMoreBtnInstance.classList.remove('hidden');
                 console.log("[openChat] Potentially more messages available.");
            }
        }
        scrollToBottom(messageList, false); // Прокрутка в самый низ

        // Отправляем событие о прочтении на сервер (он сам обновит счетчики и уведомит других)
        if (socket) {
            socket.emit('mark_chat_read', chatId);
            console.log(`Sent mark_chat_read event for chat ${chatId} upon opening.`);
        }

        // Помечаем чат как прочитанный
        markChatAsRead(chatId);

    } catch (error) {
        console.error('Error opening chat:', error);
        if (chatPlaceholder) chatPlaceholder.style.display = 'flex'; // Показываем плейсхолдер
        if (chatView) chatView.classList.add('hidden'); // Скрываем вид чата
        // Можно показать сообщение об ошибке пользователю
        showToastNotification({ text: `Не удалось загрузить чат: ${error.message}`, senderName: 'Ошибка', type: 'error' });
    } finally {
        isLoadingMessages = false;
    }
};

/**
 * Обрабатывает входящее сообщение от Socket.IO.
 * @param {string} chatId - ID чата.
 * @param {object} message - Объект сообщения.
 */
const handleIncomingMessage = (chatId, message) => {
    const chatListElement = document.getElementById('chatList');
    const messageList = document.getElementById('messageList'); // Контейнер сообщений активного чата

    // 1. Обновление списка чатов (Sidebar)
    const chatListItem = document.querySelector(`.chat-list-item[data-chat-id="${chatId}"]`);
    if (chatListItem) {
        const lastMessageEl = chatListItem.querySelector('.chat-last-message');
        const timestampEl = chatListItem.querySelector('.chat-timestamp');

        // Обновляем последнее сообщение и время
        if (lastMessageEl && message.text) {
            const snippet = message.text.length > 35 ? message.text.substring(0, 32) + '...' : message.text;
            lastMessageEl.innerHTML = ''; // Очищаем
            if(message.isOwnMessage) {
                const selfPrefix = document.createElement('span'); 
                selfPrefix.className = 'self-prefix'; 
                selfPrefix.textContent = 'Вы: ';
                lastMessageEl.appendChild(selfPrefix);
            }
            lastMessageEl.appendChild(document.createTextNode(snippet));
        }
        if (timestampEl && message.timestamp) {
            const date = new Date(message.timestamp);
            if (!isNaN(date.getTime())) {
                timestampEl.textContent = date.toLocaleTimeString('ru-RU', { 
                    hour: '2-digit',
                    minute: '2-digit'
                });
            } else {
                timestampEl.textContent = '--:--';
            }
        }

        // Перемещаем элемент чата наверх списка
        if (chatListElement && chatListItem.parentNode === chatListElement) {
            const noChatsMsg = chatListElement.querySelector('.no-chats-message');
            if (noChatsMsg) noChatsMsg.remove();
            chatListElement.prepend(chatListItem);
        }

        // Обновление бейджа непрочитанных для НЕАКТИВНОГО чата
        if (chatId !== currentChatId && !message.isOwnMessage) {
            chatListItem.classList.add('unread'); // Добавляем класс для подсветки
            let badge = chatListItem.querySelector('.unread-badge');
            const metaContainer = chatListItem.querySelector('.chat-meta');

            if (!badge && metaContainer) {
                badge = document.createElement('span');
                badge.className = 'unread-badge';
                badge.id = `unread-badge-${chatId}`;
                metaContainer.appendChild(badge);
            }

            if (badge) {
                const currentCount = parseInt(badge.textContent) || 0;
                const newCount = currentCount + 1;
                badge.textContent = newCount > 9 ? '9+' : newCount;
                badge.style.display = 'inline-block';
                badge.classList.add('animate-pulse');
                setTimeout(() => badge.classList.remove('animate-pulse'), 1500);
            }
        }
    }

    // 2. Добавление сообщения в ОТКРЫТЫЙ чат
    if (chatId === currentChatId && messageList) {
        const isNearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 150;
        appendMessage(message, messageList, false);

        if (isNearBottom || message.isOwnMessage) {
            scrollToBottom(messageList, true);
        }

        // Отправка события о прочтении, если это ВХОДЯЩЕЕ сообщение в АКТИВНОМ чате
        if (socket && !message.isOwnMessage) {
            socket.emit('mark_chat_read', chatId);
            console.log(`Sent mark_chat_read for incoming message in active chat ${chatId}`);
        }
    } else if (!message.isOwnMessage) {
        // 3. Показ всплывающего уведомления для НЕАКТИВНОГО чата
        showToastNotification({
            id: message.id,
            chatId: chatId,
            senderName: message.senderName || 'Новое сообщение',
            text: message.text || ''
        });
    }
};


/**
 * Загружает предыдущую порцию сообщений для текущего чата.
 */
const loadMoreMessages = async () => {
    const messageList = document.getElementById('messageList');
    const loadMoreMessagesBtn = messageList?.querySelector('#loadMoreMessagesBtnInstance');
    if (!loadMoreMessagesBtn) return; // Кнопки нет - выходим

    const buttonText = loadMoreMessagesBtn.querySelector('.button-text');
    const spinner = loadMoreMessagesBtn.querySelector('.button-spinner');

    if (!currentChatId || isLoadingMessages || !hasMoreMessages || !messageList) {
        console.log("Conditions not met for loading more messages.");
        if (loadMoreMessagesBtn) loadMoreMessagesBtn.classList.add('hidden'); // Скрываем кнопку на всякий случай
        return;
    }

    isLoadingMessages = true;
    loadMoreMessagesBtn.disabled = true;
    if (buttonText) buttonText.textContent = ''; // Очищаем текст кнопки
    if (spinner) spinner.style.display = 'inline-block'; // Показываем спиннер

    try {
        console.log(`Loading older messages for chat ${currentChatId}, before timestamp: ${oldestMessageTimestamp}`);
        const url = `/api/chats/${currentChatId}/messages/history?limit=30&beforeTimestamp=${oldestMessageTimestamp || ''}`; // Увеличил лимит до 30
        const response = await fetch(url);
        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Не удалось загрузить историю сообщений.');
        }

        if (result.messages && result.messages.length > 0) {
            const scrollHeightBefore = messageList.scrollHeight;
            const scrollTopBefore = messageList.scrollTop;

            // Сообщения приходят [старые, ..., новые], добавляем их в НАЧАЛО списка
            result.messages.forEach(msg => appendMessage(msg, messageList, true));

            // Восстанавливаем позицию прокрутки ОТНОСИТЕЛЬНО СТАРЫХ СООБЩЕНИЙ
            requestAnimationFrame(() => {
                messageList.scrollTop = scrollTopBefore + (messageList.scrollHeight - scrollHeightBefore);
            });

            // Обновляем oldestMessageTimestamp на основе самого старого из ПОЛУЧЕННЫХ
            // (они уже отсортированы старые->новые в ответе API, если getChatMessages работает правильно)
             oldestMessageTimestamp = result.messages[0]?.timestamp || oldestMessageTimestamp; // Берем timestamp первого (самого старого)
             console.log("Updated oldestMessageTimestamp after loading more:", oldestMessageTimestamp);


            hasMoreMessages = result.hasMore !== false; // hasMore приходит от API
            console.log("Messages loaded. Has more:", hasMoreMessages);
            if (!hasMoreMessages) { loadMoreMessagesBtn.classList.add('hidden'); }

        } else {
            hasMoreMessages = false;
            loadMoreMessagesBtn.classList.add('hidden');
            console.log("No more messages to load for this chat.");
        }

    } catch (error) {
        console.error("Error loading more messages:", error);
        if (buttonText) buttonText.textContent = 'Ошибка';
        if (spinner) spinner.style.display = 'none';
        // Оставляем кнопку видимой с ошибкой, чтобы пользователь мог попробовать еще раз
        loadMoreMessagesBtn.disabled = false; // Разблокируем кнопку при ошибке
    } finally {
        isLoadingMessages = false;
        // Обновляем состояние кнопки, только если загрузка не завершена
        if (hasMoreMessages && loadMoreMessagesBtn && buttonText && spinner) {
            loadMoreMessagesBtn.disabled = false;
            buttonText.textContent = 'Загрузить еще';
            spinner.style.display = 'none';
        }
    }
};

// --- Функции всплывающих уведомлений ---

/**
 * Создает и показывает всплывающее уведомление о новом сообщении.
 * @param {object} messageData - Данные сообщения (id, chatId, senderName, text, type?).
 */
function showToastNotification(messageData) {
    const container = document.getElementById('toast-notification-container');
    if (!container || !messageData) return;

    const toastId = `toast-${messageData.id || Date.now()}`;
    const existingToast = document.getElementById(toastId);
    if (existingToast) existingToast.remove(); // Убираем дубликат, если есть

    const toastDiv = document.createElement('div');
    toastDiv.className = `toast-notification ${messageData.type || 'info'}`; // Добавляем тип для стилизации
    toastDiv.id = toastId;

    // Переход в чат по клику на сам тост (кроме кнопок)
    toastDiv.onclick = (e) => {
         if (!e.target.closest('button') && messageData.chatId) {
             window.location.href = `/chats/${messageData.chatId}`;
             hideToast(toastDiv);
         }
    };

    let iconClass = 'fa-comment-dots'; // Иконка по умолчанию
    let borderColor = 'var(--primary-accent, #0d6efd)'; // Цвет полоски
    if (messageData.type === 'error') { iconClass = 'fa-exclamation-circle'; borderColor = 'var(--danger-color, #dc3545)'; }
    else if (messageData.type === 'warning') { iconClass = 'fa-exclamation-triangle'; borderColor = 'var(--warning-color, #ffc107)'; }
    else if (messageData.type === 'success') { iconClass = 'fa-check-circle'; borderColor = 'var(--success-color, #198754)'; }

    toastDiv.style.borderLeftColor = borderColor; // Устанавливаем цвет полоски

    toastDiv.innerHTML = `
        <div class="toast-icon" style="color: ${borderColor};"><i class="fas ${iconClass}"></i></div>
        <div class="toast-content">
            <h5 class="toast-title">${messageData.senderName || 'Уведомление'}</h5>
            <p class="toast-message">${messageData.text || ''}</p>
            ${messageData.chatId ? `
            <div class="toast-actions">
                <button class="btn-toast-read" data-chat-id="${messageData.chatId}">Прочитано</button>
                <button class="btn-toast-open" data-chat-id="${messageData.chatId}">Перейти</button>
            </div>` : ''}
        </div>
    `;

    // Обработчики кнопок (только если они есть)
    if (messageData.chatId) {
        const readButton = toastDiv.querySelector('.btn-toast-read');
        const openButton = toastDiv.querySelector('.btn-toast-open');
        if (readButton) { readButton.addEventListener('click', (e) => { e.stopPropagation(); markChatAsRead(messageData.chatId); hideToast(toastDiv); }); }
        if (openButton) { openButton.addEventListener('click', (e) => { e.stopPropagation(); window.location.href = `/chats/${messageData.chatId}`; hideToast(toastDiv); }); }
    }

    container.prepend(toastDiv); // Новые уведомления сверху
    requestAnimationFrame(() => { toastDiv.classList.add('show'); });

    // Воспроизведение звука (только для сообщений чата, не для ошибок)
    if (messageData.chatId && messageData.type !== 'error') {
        try { new Audio('/sounds/new_message.mp3').play().catch(e => console.warn("Toast audio playback failed:", e)); } catch (e) {}
    }

    // Автоскрытие через 7 секунд
    setTimeout(() => { hideToast(toastDiv); }, 7000);
}

/**
 * Прячет и удаляет всплывающее уведомление.
 * @param {HTMLElement} toastElement - DOM-элемент уведомления.
 */
function hideToast(toastElement) {
    if (!toastElement || !toastElement.parentNode) return;
    toastElement.classList.remove('show');
    toastElement.classList.add('hide');
    // Удаляем из DOM после завершения анимации
    setTimeout(() => {
        if (toastElement.parentNode) {
            toastElement.parentNode.removeChild(toastElement);
        }
    }, 500); // Должно совпадать с transition duration в CSS
}

/**
 * Отправляет событие на сервер для пометки чата прочитанным.
 * @param {string} chatId - ID чата.
 */
function markChatAsRead(chatId) {
    if (socket && chatId) {
        socket.emit('mark_chat_read', chatId);
        console.log(`Sent mark_chat_read event for chat ${chatId} from toast`);
        // Обновление UI списка чатов (скрытие бейджа) произойдет через событие от сервера
    }
}


// --- Глобальная функция обновления счетчика в хедере ---
window.updateHeaderChatBadge = (totalUnreadCount) => {
    const tenantBadge = document.getElementById('tenantChatsBadge');
    const companyBadge = document.getElementById('companyChatsBadge');

    // Определяем, какой бейдж сейчас видим (или должен быть видим)
    // Предполагаем, что EJS рендерит только один из них
    const targetBadge = tenantBadge || companyBadge; // Находим первый существующий

    console.log(`[updateHeaderChatBadge] Called with count: ${totalUnreadCount}. Target badge: ${targetBadge ? targetBadge.id : 'Not Found'}`);

    if (targetBadge) {
        const count = parseInt(totalUnreadCount);
        if (isNaN(count) || count < 0) {
            console.warn("[updateHeaderChatBadge] Invalid count received:", totalUnreadCount);
            targetBadge.style.display = 'none';
            targetBadge.classList.remove('updated');
            return;
        }
        if (count > 0) {
            targetBadge.textContent = count > 9 ? '9+' : count;
            targetBadge.style.display = 'inline-block'; // Показываем бейдж
            // Анимация обновления
            targetBadge.classList.remove('updated'); // Сначала убираем класс
            void targetBadge.offsetWidth; // Форсируем reflow
            targetBadge.classList.add('updated'); // Добавляем класс для анимации
        } else {
            targetBadge.style.display = 'none'; // Скрываем, если счетчик 0
            targetBadge.classList.remove('updated');
        }
        console.log(`[updateHeaderChatBadge] Badge ${targetBadge.id} updated. Text: ${targetBadge.textContent}, Display: ${targetBadge.style.display}`);
    } else {
        console.warn("[updateHeaderChatBadge] Target header badge element not found.");
    }
};


// --- Инициализация при загрузке DOM ---
document.addEventListener('DOMContentLoaded', () => {
    const messageInputForm = document.getElementById('messageInputForm');
    const messageTextarea = document.getElementById('messageTextarea');
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    const messageList = document.getElementById('messageList'); // Для view страницы
    const chatList = document.getElementById('chatList'); // Для списка чатов

    // --- Инициализация Socket.IO ---
    if (typeof io !== 'undefined') {
        // Используем глобальный сокет, если он уже существует
        if (window.socket) {
            socket = window.socket;
            console.log('[Chat Socket.IO] Using existing socket connection');
        } else {
            socket = io({ reconnectionAttempts: 5, reconnectionDelay: 3000 });
            window.socket = socket; // Сохраняем в глобальной области
            console.log('[Chat Socket.IO] Created new socket connection');
        }

        socket.on('connect', () => {
            console.log('[Chat Socket.IO] Connected, ID:', socket.id);
            // Регистрируем пользователя после подключения (если пользователь есть в сессии)
            const currentUsername = document.body.dataset.currentUser;
            if (currentUsername) {
                socket.emit('register_user', currentUsername);
            }
        });
        socket.on('disconnect', (reason) => console.warn('[Chat Socket.IO] Disconnected:', reason));
        socket.on('connect_error', (err) => console.error('[Chat Socket.IO] Connection Error:', err.message));

        // Обработчик нового сообщения
        socket.on('new_message', (data) => {
            console.log('[Socket.IO] Received new_message:', data);
            if (data && data.chatId) {
                // Если чат открыт, добавляем сообщение
                if (currentChatId === data.chatId) {
                    appendMessage(data.message, messageList);
                    scrollToBottom(messageList, true);
                } else {
                    // Обновляем счетчик непрочитанных в списке чатов
                    const chatItem = document.querySelector(`.chat-item[data-chat-id="${data.chatId}"]`);
                    if (chatItem) {
                        const unreadBadge = chatItem.querySelector('.unread-badge');
                        if (unreadBadge) {
                            const currentCount = parseInt(unreadBadge.textContent) || 0;
                            unreadBadge.textContent = currentCount + 1;
                            unreadBadge.style.display = 'inline-block';
                        }
                    }
                }
            }
        });

        // Обработчик статуса прочтения (ГАЛОЧКИ)
        socket.on('messages_read_up_to', (data) => {
            console.log('[Socket.IO] Received messages_read_up_to:', data);
            const { chatId, readerId, readUpToTimestamp } = data;
            // Обновляем галочки только если этот чат ОТКРЫТ
            if (chatId === currentChatId && readUpToTimestamp && messageList) {
                console.log(`Updating ticks in chat ${chatId} up to ${readUpToTimestamp}`);
                const outgoingMessages = messageList.querySelectorAll('.message-bubble.own:not(.read)'); // Ищем только свои НЕПРОЧИТАННЫЕ
                outgoingMessages.forEach(bubble => {
                    const messageTimestamp = parseInt(bubble.dataset.timestamp || '0');
                    // Обновляем, если сообщение было отправлено ДО или В МОМЕНТ времени прочтения
                    if (messageTimestamp <= readUpToTimestamp) {
                        const ticksIcon = bubble.querySelector('.message-status-ticks i');
                        // Меняем иконку на двойную галочку и добавляем класс 'read'
                        if (ticksIcon && !ticksIcon.classList.contains('fa-check-double')) {
                            ticksIcon.classList.remove('fa-check');
                            ticksIcon.classList.add('fa-check-double');
                            bubble.classList.add('read'); // Добавляем класс к bubble для стилизации
                            console.debug(`Tick updated for message timestamp ${messageTimestamp}`);
                        }
                    }
                });
            }
        });

        // Обработчики событий Socket.IO для непрочитанных сообщений
        socket.on('chat_list_unread_update', ({ chatId, unreadCount, timestamp }) => {
            console.log(`[Chat] Received chat_list_unread_update for chat ${chatId}: ${unreadCount}`);
            
            // Обновляем бейдж в списке чатов
            const chatListItem = document.querySelector(`[data-chat-id="${chatId}"]`);
            if (chatListItem) {
                const badge = chatListItem.querySelector('.unread-badge');
                if (badge) {
                    if (unreadCount > 0) {
                        badge.textContent = unreadCount;
                        badge.classList.remove('hidden');
                        // Добавляем анимацию для нового сообщения
                        badge.classList.add('pulse');
                        setTimeout(() => badge.classList.remove('pulse'), 1000);
                    } else {
                        badge.classList.add('hidden');
                    }
                }
            }
        });

        socket.on('header_unread_update', ({ totalUnreadCount, timestamp }) => {
            console.log(`[Chat] Received header_unread_update: ${totalUnreadCount}`);
            
            // Обновляем бейдж в хедере
            const headerBadge = document.getElementById('header-chat-badge');
            if (headerBadge) {
                if (totalUnreadCount > 0) {
                    headerBadge.textContent = totalUnreadCount;
                    headerBadge.classList.remove('hidden');
                    // Добавляем анимацию
                    headerBadge.classList.add('pulse');
                    setTimeout(() => headerBadge.classList.remove('pulse'), 1000);
                } else {
                    headerBadge.classList.add('hidden');
                }
            }
        });

    } else {
        console.error('Socket.IO library (socket.io.js) not loaded!');
    }

    // --- Обработчики формы отправки сообщения ---
    if (messageInputForm && messageTextarea && sendMessageBtn) {
        const sendMessage = async () => {
            const chatId = currentChatId || messageInputForm.dataset.chatId;
            const text = messageTextarea.value.trim();
            
            console.log('[SendMessage] Attempting to send message:', { chatId, text });
            
            if (!chatId) {
                console.error('[SendMessage] No chat ID available');
                showToastNotification({ text: 'Ошибка: ID чата не найден', type: 'error' });
                return;
            }
            
            if (!text) {
                console.log('[SendMessage] Empty message, ignoring');
                return;
            }
            
            if (sendMessageBtn.disabled) {
                console.log('[SendMessage] Button is disabled, ignoring');
                return;
            }

            const sendButtonSpinner = sendMessageBtn.querySelector('.button-spinner');
            const sendButtonIcon = sendMessageBtn.querySelector('i:not(.button-spinner)');

            // Блокируем кнопку и показываем спиннер
            sendMessageBtn.disabled = true;
            if (sendButtonIcon) sendButtonIcon.style.display = 'none';
            if (sendButtonSpinner) sendButtonSpinner.style.display = 'inline-block';

            try {
                console.log(`[SendMessage] Sending message to chat ${chatId}`);
                const response = await fetch(`/chats/${chatId}/messages`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify({ text: text })
                });

                const result = await response.json();
                
                if (!response.ok) {
                    throw new Error(result.error || `HTTP error! status: ${response.status}`);
                }
                
                if (!result.success) {
                    throw new Error(result.error || 'Неизвестная ошибка при отправке');
                }

                console.log('[SendMessage] Message sent successfully:', result);

                // Очищаем поле ввода
                messageTextarea.value = '';
                
                // Сбрасываем высоту textarea
                const baseHeight = 42;
                messageTextarea.style.height = `${baseHeight}px`;
                
                // Возвращаем фокус
                messageTextarea.focus();

                // Автоматическое обновление чата после отправки
                if (result.message) {
                    const messageList = document.getElementById('messageList');
                    if (messageList) {
                        appendMessage(result.message, messageList);
                        scrollToBottom(messageList, true);
                    }
                }

                // Обновляем список чатов
                updateChatList();

            } catch (error) {
                console.error('[SendMessage] Error:', error);
                showToastNotification({
                    text: `Не удалось отправить сообщение: ${error.message}`,
                    type: 'error'
                });
            } finally {
                // Разблокируем кнопку и скрываем спиннер
                sendMessageBtn.disabled = false;
                if (sendButtonIcon) sendButtonIcon.style.display = 'inline-block';
                if (sendButtonSpinner) sendButtonSpinner.style.display = 'none';
            }
        };

        // Привязываем обработчики событий
        messageInputForm.addEventListener('submit', (e) => {
            e.preventDefault();
            console.log('[SendMessage] Form submitted');
            sendMessage();
        });

        messageTextarea.addEventListener('input', () => {
            const hasText = messageTextarea.value.trim().length > 0;
            sendMessageBtn.disabled = !hasText;
            console.log('[SendMessage] Button state updated:', { disabled: !hasText });
        });

        messageTextarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                console.log('[SendMessage] Enter pressed');
                sendMessage();
            }
        });

        // Изначально кнопка отправки выключена
        sendMessageBtn.disabled = true;
    }

    // --- Обработчик кнопки "Загрузить еще" (для страницы /chats) ---
     if (chatList && messageList) { // Убедимся, что мы на странице /chats
         messageList.addEventListener('click', (event) => {
             const loadButton = event.target.closest('#loadMoreMessagesBtnInstance');
             if (loadButton) {
                 loadMoreMessages(); // Вызываем функцию загрузки
             }
         });
     }

    // --- Инициализация открытия чата по URL (если мы на /chats/:chatId) ---
    const pathParts = window.location.pathname.split('/');
    const isChatViewPage = pathParts.length >= 3 && pathParts[1] === 'chats' && pathParts[2];

    if (isChatViewPage) {
        // Мы на странице отдельного чата (/chats/:chatId)
        // Скрипт инициализации пагинации и прокрутки для этой страницы
        currentChatId = pathParts[2]; // Устанавливаем текущий ID чата
        const messageListElement = document.getElementById('messageList');
        if (messageListElement) {
            messageListElement.scrollTop = messageListElement.scrollHeight; // Скролл вниз
            const firstMessageBubble = messageListElement.querySelector('.message-bubble:first-child');
             if (firstMessageBubble && typeof window.setOldestMessageTimestamp === 'function') {
                 window.setOldestMessageTimestamp(parseInt(firstMessageBubble.dataset.timestamp || '0'));
             } else {
                 // Если сообщений нет или timestamp не найден, отключаем пагинацию
                  if (typeof window.updateHasMoreMessages === 'function') window.updateHasMoreMessages(false);
             }
             // Проверяем, нужно ли изначально скрыть кнопку "Загрузить еще"
             const initialMessagesCount = messageListElement.querySelectorAll('.message-bubble').length;
             const loadLimit = 50; // Должно совпадать с лимитом в API
             if (initialMessagesCount < loadLimit && typeof window.updateHasMoreMessages === 'function') {
                  window.updateHasMoreMessages(false);
             } else if (typeof window.updateHasMoreMessages === 'function') {
                  window.updateHasMoreMessages(true); // Предполагаем, что есть еще
             }
        }
        // Отправляем mark_chat_read при загрузке страницы чата
        if (socket && currentChatId) {
            socket.emit('mark_chat_read', currentChatId);
            console.log(`Sent mark_chat_read for chat ${currentChatId} on page load.`);
        }

    } else if (window.location.pathname === '/chats') {
        // Мы на странице списка чатов (/chats)
        // Инициализация открытия чата по URL-хешу (если есть)
        const hashChatId = window.location.hash.substring(1); // Получаем ID из #chat-123
        if (hashChatId && hashChatId.startsWith('chat-')) {
            const chatIdToOpen = hashChatId.substring(5);
            setTimeout(() => {
                if (typeof window.openChat === 'function') {
                    window.openChat(chatIdToOpen);
                }
            }, 150); // Небольшая задержка для рендеринга
        }
    }

    // Функция обновления списка чатов
    async function updateChatList() {
        try {
            const response = await fetch('/chats');
            if (response.ok) {
                const chats = await response.json();
                const chatList = document.querySelector('.chat-list');
                if (chatList) {
                    chatList.innerHTML = chats.map(chat => `
                        <div class="chat-item ${chat.id === currentChatId ? 'active' : ''}" data-chat-id="${chat.id}">
                            <div class="chat-avatar">
                                <img src="${chat.avatar || '/images/default-avatar.png'}" alt="${chat.name}">
                                ${chat.unreadCount > 0 ? `<span class="unread-badge">${chat.unreadCount > 9 ? '9+' : chat.unreadCount}</span>` : ''}
                            </div>
                            <div class="chat-info">
                                <div class="chat-name">${chat.name}</div>
                                <div class="chat-last-message">${chat.lastMessageText || ''}</div>
                            </div>
                            <div class="chat-time">${formatTime(chat.lastMessageTimestamp)}</div>
                        </div>
                    `).join('');
                }
            }
        } catch (error) {
            console.error('Error updating chat list:', error);
        }
    }

    // Обновляем список чатов при загрузке и после каждого сообщения
    document.addEventListener('DOMContentLoaded', updateChatList);
    socket.on('new_message', updateChatList);

    console.log("[Chat.js] DOM Loaded. Event listeners and Socket.IO initialized.");

    // Запрашиваем начальные значения при загрузке
    if (socket && socket.connected) {
        console.log('[Socket.IO] Requesting initial unread counts');
        socket.emit('get_initial_unread_counts');
    }

}); // End DOMContentLoaded