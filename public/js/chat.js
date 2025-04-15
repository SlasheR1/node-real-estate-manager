// public/js/chat.js (Полная версия)

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
    // Ищем кнопку загрузки внутри messageList, если она существует
    const messageList = document.getElementById('messageList');
    const loadMoreBtn = messageList?.querySelector('#loadMoreMessagesBtnInstance'); // Ищем клон по ID
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
    const isRead = isOwn && message.isReadByRecipient === true;

    bubble.className = `message-bubble ${isOwn ? 'own' : 'other'} ${isRead ? 'read' : ''}`;
    bubble.dataset.timestamp = message.timestamp || Date.now();
    bubble.dataset.messageId = message.id || '';

    const textEl = document.createElement('div');
    textEl.className = 'message-text';
    textEl.textContent = message.text;

    const metaEl = document.createElement('div');
    metaEl.className = 'message-meta';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    timeSpan.textContent = message.timestampFormatted || new Date(message.timestamp || Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    metaEl.appendChild(timeSpan);

    if (isOwn) {
        const ticksSpan = document.createElement('span');
        ticksSpan.className = 'message-status-ticks';
        ticksSpan.innerHTML = `<i class="fas ${isRead ? 'fa-check-double' : 'fa-check'}"></i>`;
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
    const loadMoreBtnTemplate = document.getElementById('loadMoreMessagesBtn'); // Шаблон кнопки

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
        const badge = chatListItem.querySelector('.unread-badge');
        if (badge) {
            badge.style.display = 'none';
            badge.style.animation = 'none';
        }
    }

    // Подготовка основной области чата
    chatPlaceholder.style.display = 'none';
    chatView.classList.remove('hidden');
    messageList.innerHTML = ''; // Очищаем
    // Клонируем кнопку "Загрузить еще" из шаблона и добавляем в messageList
    const clonedLoadBtn = loadMoreBtnTemplate.cloneNode(true);
    clonedLoadBtn.id = 'loadMoreMessagesBtnInstance'; // Уникальный ID для клона
    clonedLoadBtn.classList.add('hidden');
    clonedLoadBtn.disabled = false;
    clonedLoadBtn.querySelector('.button-text').textContent = 'Загрузить еще';
    clonedLoadBtn.querySelector('.button-spinner').style.display = 'none';
    clonedLoadBtn.addEventListener('click', loadMoreMessages); // Привязываем обработчик
    messageList.appendChild(clonedLoadBtn);

    messageInputForm.dataset.chatId = chatId;
    sendMessageBtn.disabled = false;

    isLoadingMessages = true;
    try {
        // Загрузка данных чата через API
        console.log(`[openChat] Fetching details from /api/chats/${chatId}/details`);
        const response = await fetch(`/api/chats/${chatId}/details`);
        if (!response.ok) { throw new Error(`Ошибка загрузки данных: ${response.statusText}`); }
        const chatDetails = await response.json();
        if (!chatDetails.success) { throw new Error(chatDetails.error || 'Ошибка загрузки данных чата.'); }
        console.log("[openChat] Received chat details via API:", chatDetails);

        // Обновляем заголовок и тему
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
            noMsgP.style.textAlign = 'center'; noMsgP.style.color = 'var(--text-secondary)'; noMsgP.style.padding = '20px';
            messageList.appendChild(noMsgP);
        } else {
            oldestMessageTimestamp = messages[0]?.timestamp || null;
            console.log("[openChat] Initial oldestMessageTimestamp from API:", oldestMessageTimestamp);
            messages.forEach(msg => appendMessage(msg, messageList));

            const initialLoadLimit = chatDetails.limit || 50;
            if (messages.length < initialLoadLimit) {
                hasMoreMessages = false;
                if (actualLoadMoreBtnInstance) actualLoadMoreBtnInstance.classList.add('hidden');
            } else {
                if (actualLoadMoreBtnInstance) actualLoadMoreBtnInstance.classList.remove('hidden');
            }
        }
        scrollToBottom(messageList, false);

        // Отправляем событие о прочтении на сервер
        if (socket) {
            socket.emit('mark_chat_read', chatId);
            console.log(`Sent mark_chat_read event for chat ${chatId}`);
        }

    } catch (error) {
        console.error('Error opening chat:', error);
        if (chatPlaceholder) chatPlaceholder.style.display = 'flex';
        if (chatView) chatView.classList.add('hidden');
        alert(`Не удалось загрузить чат: ${error.message}`);
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
    const messageList = document.getElementById('messageList');

    // 1. Обновление списка чатов
    const chatListItem = document.querySelector(`.chat-list-item[data-chat-id="${chatId}"]`);
    if (chatListItem) {
        const lastMessageEl = chatListItem.querySelector('.chat-last-message');
        const timestampEl = chatListItem.querySelector('.chat-timestamp');
        if (lastMessageEl) {
            const snippet = message.text.length > 40 ? message.text.substring(0, 37) + '...' : message.text;
            lastMessageEl.textContent = ''; // Очищаем
            if(message.isOwnMessage) {
                const selfPrefix = document.createElement('span'); selfPrefix.className = 'self-prefix'; selfPrefix.textContent = 'Вы: ';
                lastMessageEl.appendChild(selfPrefix);
            }
            lastMessageEl.appendChild(document.createTextNode(snippet));
        }
        if (timestampEl && message.timestamp) {
            timestampEl.textContent = new Date(message.timestamp).toLocaleString('ru-RU', { timeStyle: 'short' });
        }
        if (chatListElement && chatListItem.parentNode === chatListElement) {
            chatListElement.prepend(chatListItem); // Наверх
        }
        // Обновление бейджа непрочитанных
        if (chatId !== currentChatId && !message.isOwnMessage) {
            chatListItem.classList.add('unread');
            let badge = chatListItem.querySelector('.unread-badge');
            if (!badge) {
                 badge = document.createElement('span'); badge.className = 'unread-badge'; badge.id = `unread-badge-${chatId}`;
                 chatListItem.querySelector('.chat-meta')?.appendChild(badge);
            }
            const currentCount = parseInt(badge.textContent) || 0; const newCount = currentCount + 1;
            badge.textContent = newCount > 9 ? '9+' : newCount; badge.style.display = 'inline-block';
            badge.classList.add('animate-pulse');
            setTimeout(() => badge.classList.remove('animate-pulse'), 1500);
            // Обновляем общий счетчик в хедере через событие (если есть)
             // window.updateHeaderChatBadge?.(1); // Вызываем функцию обновления хедера
        }
    } else { console.warn(`Chat item for ${chatId} not found. Reloading list might be needed.`); }

    // 2. Добавление сообщения в активный чат
    if (chatId === currentChatId && messageList) {
        const isNearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 150;
        appendMessage(message, messageList, false);
        if (isNearBottom || message.isOwnMessage) { scrollToBottom(messageList, true); }
        // Отправка mark_chat_read для входящего сообщения в активном чате
        if (socket && !message.isOwnMessage) {
            socket.emit('mark_chat_read', chatId);
            console.log(`Sent mark_chat_read for incoming message in active chat ${chatId}`);
        }
    } else if (!message.isOwnMessage) {
        // Показ всплывающего уведомления и звук для неактивного чата
        showToastNotification({
            id: message.id, chatId: chatId, senderName: message.senderName, text: message.text
        });
    }
};

/**
 * Загружает предыдущую порцию сообщений для текущего чата.
 */
const loadMoreMessages = async () => {
    const messageList = document.getElementById('messageList');
    const loadMoreMessagesBtn = messageList?.querySelector('#loadMoreMessagesBtnInstance');
    const buttonText = loadMoreMessagesBtn?.querySelector('.button-text');
    const spinner = loadMoreMessagesBtn?.querySelector('.button-spinner');

    if (!currentChatId || isLoadingMessages || !hasMoreMessages || !loadMoreMessagesBtn || !messageList) {
        console.log("Conditions not met for loading more messages.");
        return;
    }

    isLoadingMessages = true;
    loadMoreMessagesBtn.disabled = true;
    if (buttonText) buttonText.textContent = '';
    if (spinner) spinner.style.display = 'inline-block';

    try {
        console.log("Loading older messages, before timestamp:", oldestMessageTimestamp);
        // Используем API маршрут для загрузки истории
        const url = `/api/chats/${currentChatId}/messages/history?limit=20&beforeTimestamp=${oldestMessageTimestamp || ''}`;
        const response = await fetch(url);
        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Не удалось загрузить историю сообщений.');
        }

        if (result.messages && result.messages.length > 0) {
            const scrollHeightBefore = messageList.scrollHeight;
            const scrollTopBefore = messageList.scrollTop;

            // Сообщения приходят старые-сверху, добавляем их в начало списка
            result.messages.forEach(msg => appendMessage(msg, messageList, true));

            // Восстанавливаем позицию прокрутки
            requestAnimationFrame(() => {
                messageList.scrollTop = scrollTopBefore + (messageList.scrollHeight - scrollHeightBefore);
            });

            hasMoreMessages = result.hasMore !== false;
            console.log("Messages loaded. Has more:", hasMoreMessages);
            if (!hasMoreMessages) { loadMoreMessagesBtn.classList.add('hidden'); }
        } else {
            hasMoreMessages = false;
            loadMoreMessagesBtn.classList.add('hidden');
            console.log("No more messages to load.");
        }

    } catch (error) {
        console.error("Error loading more messages:", error);
        if (buttonText) buttonText.textContent = 'Ошибка';
        if (spinner) spinner.style.display = 'none';
    } finally {
        isLoadingMessages = false;
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
 * @param {object} messageData - Данные сообщения (id, chatId, senderName, text).
 */
function showToastNotification(messageData) {
    const container = document.getElementById('toast-notification-container');
    if (!container || !messageData || !messageData.chatId) return;

    const toastId = `toast-${messageData.id || Date.now()}`;
    const existingToast = document.getElementById(toastId);
    if (existingToast) existingToast.remove();

    const toastDiv = document.createElement('div');
    toastDiv.className = 'toast-notification';
    toastDiv.id = toastId;
    toastDiv.onclick = (e) => {
         if (!e.target.closest('button')) {
             window.location.href = `/chats/${messageData.chatId}`;
             hideToast(toastDiv);
         }
    };

    toastDiv.innerHTML = `
        <div class="toast-icon"><i class="fas fa-comment-dots"></i></div>
        <div class="toast-content">
            <h5 class="toast-title">${messageData.senderName || 'Новое сообщение'}</h5>
            <p class="toast-message">${messageData.text || ''}</p>
            <div class="toast-actions">
                <button class="btn-toast-read" data-chat-id="${messageData.chatId}">Прочитано</button>
                <button class="btn-toast-open" data-chat-id="${messageData.chatId}">Перейти в чат</button>
            </div>
        </div>
    `;

    const readButton = toastDiv.querySelector('.btn-toast-read');
    const openButton = toastDiv.querySelector('.btn-toast-open');

    if (readButton) {
        readButton.addEventListener('click', (e) => { e.stopPropagation(); markChatAsRead(messageData.chatId); hideToast(toastDiv); });
    }
    if (openButton) {
        openButton.addEventListener('click', (e) => { e.stopPropagation(); window.location.href = `/chats/${messageData.chatId}`; hideToast(toastDiv); });
    }

    container.prepend(toastDiv);
    requestAnimationFrame(() => { toastDiv.classList.add('show'); });

    try { new Audio('/sounds/new_message.mp3').play().catch(e => console.warn("Toast audio playback failed:", e)); } catch (e) {}
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
    setTimeout(() => {
        if (toastElement.parentNode) {
            toastElement.parentNode.removeChild(toastElement);
        }
    }, 500);
}

/**
 * Отправляет событие на сервер для пометки чата прочитанным.
 * @param {string} chatId - ID чата.
 */
function markChatAsRead(chatId) {
    if (socket && chatId) {
        socket.emit('mark_chat_read', chatId);
        console.log(`Sent mark_chat_read event for chat ${chatId} from toast`);
        const chatListItem = document.querySelector(`.chat-list-item[data-chat-id="${chatId}"]`);
        if (chatListItem) {
            chatListItem.classList.remove('unread');
            const badge = chatListItem.querySelector('.unread-badge');
            if (badge) badge.style.display = 'none';
            // Обновляем общий счетчик в хедере (запросом актуального значения)
            // window.updateHeaderChatBadge?.(-1); // Неправильно, нужен полный пересчет
            // Запрос актуального значения инициируется в обработчике 'mark_chat_read' на сервере
        }
    }
}

// --- Инициализация при загрузке DOM ---
document.addEventListener('DOMContentLoaded', () => {
    const messageInputForm = document.getElementById('messageInputForm');
    const messageTextarea = document.getElementById('messageTextarea');
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    const messageList = document.getElementById('messageList');

    // --- Инициализация Socket.IO ---
    if (typeof io !== 'undefined') {
        socket = io({ reconnectionAttempts: 5, reconnectionDelay: 3000 });
        socket.on('connect', () => console.log('[Chat Socket.IO] Connected, ID:', socket.id));
        socket.on('disconnect', (reason) => console.warn('[Chat Socket.IO] Disconnected:', reason));
        socket.on('connect_error', (err) => console.error('[Chat Socket.IO] Connection Error:', err.message));

        socket.on('new_message', (data) => {
            console.log('[Chat Socket.IO] Received new_message:', data);
            if (data.chatId && data.message) { handleIncomingMessage(data.chatId, data.message); }
            else { console.error('Invalid new_message data format'); }
        });

        socket.on('unread_count_update', (data) => {
            console.log('[Chat Socket.IO] Received unread_count_update:', data);
            if (data.chatId && typeof data.unreadCount === 'number') {
                const badge = document.getElementById(`unread-badge-${data.chatId}`);
                const listItem = document.querySelector(`.chat-list-item[data-chat-id="${data.chatId}"]`);
                if (badge) {
                    if (data.unreadCount > 0) { badge.textContent = data.unreadCount > 9 ? '9+' : data.unreadCount; badge.style.display = 'inline-block'; listItem?.classList.add('unread'); }
                    else { badge.style.display = 'none'; listItem?.classList.remove('unread'); }
                } else if (data.unreadCount > 0 && listItem) { const newBadge = document.createElement('span'); newBadge.className = 'unread-badge'; newBadge.id = `unread-badge-${data.chatId}`; newBadge.textContent = data.unreadCount > 9 ? '9+' : data.unreadCount; listItem.querySelector('.chat-meta')?.appendChild(newBadge); listItem.classList.add('unread'); }
                else if (data.unreadCount <= 0 && listItem) { listItem?.classList.remove('unread'); }
            }
        });

        // Обработчик ОБЩЕГО СЧЕТЧИКА
        socket.on('total_unread_update', (data) => {
            console.log('[Chat Socket.IO] Received total_unread_update:', data);
            if (typeof data.totalUnreadCount === 'number') {
                window.updateHeaderChatBadge(data.totalUnreadCount); // Обновляем хедер
            }
       });

        // Обработчик статуса прочтения (ГАЛОЧКИ)
        socket.on('messages_read_up_to', (data) => {
            console.log('[Socket.IO] Received messages_read_up_to:', data);
            const { chatId, readerId, readUpToTimestamp } = data;
            if (chatId === currentChatId && readUpToTimestamp && messageList) {
                console.log(`Updating ticks in chat ${chatId} up to ${readUpToTimestamp}`);
                const outgoingMessages = messageList.querySelectorAll('.message-bubble.own:not(.read)');
                outgoingMessages.forEach(bubble => {
                    const messageTimestamp = parseInt(bubble.dataset.timestamp || '0');
                    if (messageTimestamp <= readUpToTimestamp) {
                        const ticksIcon = bubble.querySelector('.message-status-ticks i');
                        if (ticksIcon && ticksIcon.classList.contains('fa-check')) {
                            ticksIcon.classList.remove('fa-check');
                            ticksIcon.classList.add('fa-check-double');
                            bubble.classList.add('read');
                            console.debug(`Tick updated for message timestamp ${messageTimestamp}`);
                        }
                    }
                });
            }
        });

    } else { console.error('Socket.IO library not loaded!'); }

    // --- Обработчики формы отправки ---
    if (messageInputForm && messageTextarea && sendMessageBtn) {
        const sendMessage = async () => {
            const chatId = messageInputForm.dataset.chatId;
            const text = messageTextarea.value.trim();
            if (!chatId || !text || sendMessageBtn.disabled) return;

            const sendButtonSpinner = sendMessageBtn.querySelector('.button-spinner');
            const sendButtonIcon = sendMessageBtn.querySelector('i:not(.button-spinner)');

            sendMessageBtn.disabled = true;
            if (sendButtonIcon) sendButtonIcon.style.display = 'none';
            if (sendButtonSpinner) sendButtonSpinner.style.display = 'inline-block';

            try {
                const response = await fetch(`/chats/${chatId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ text: text }) });
                const result = await response.json();
                if (!response.ok || !result.success) { throw new Error(result.error || `Ошибка отправки: ${response.statusText}`); }
                if (result.sentMessage && messageList) {
                    appendMessage(result.sentMessage, messageList);
                    scrollToBottom(messageList);
                }
                messageTextarea.value = '';
                const baseHeight = 42; // Или другая базовая высота вашего textarea
                messageTextarea.style.height = `${baseHeight}px`;
                messageTextarea.focus();
            } catch (error) {
                 console.error('Error sending message:', error);
                 showToastNotification({ text: `Не удалось отправить сообщение: ${error.message}`, senderName: 'Ошибка' }); // Используем тост для ошибки
            } finally {
                sendMessageBtn.disabled = false;
                if (sendButtonIcon) sendButtonIcon.style.display = 'inline-block';
                if (sendButtonSpinner) sendButtonSpinner.style.display = 'none';
            }
        };

        messageInputForm.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
        messageTextarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
             setTimeout(() => { // Auto-resize textarea
                 const el = e.target; const baseHeight = 42; el.style.height = 'auto';
                 const newHeight = Math.max(baseHeight, el.scrollHeight); const maxHeight = 120;
                 el.style.height = `${Math.min(newHeight, maxHeight)}px`;
             }, 0);
        });
    }

    // --- Обработчик кнопки "Загрузить еще" ---
     if (messageList) {
         messageList.addEventListener('click', (event) => {
             const loadButton = event.target.closest('#loadMoreMessagesBtnInstance');
             if (loadButton) { loadMoreMessages(); }
         });
     }

    // --- Инициализация открытия чата по URL ---
    const pathParts = window.location.pathname.split('/');
    if (pathParts.length >= 3 && pathParts[1] === 'chats' && pathParts[2]) {
        const chatIdFromUrl = pathParts[2];
        setTimeout(() => { window.openChat(chatIdFromUrl); }, 150);
    }

    // --- Глобальная функция обновления счетчика в хедере ---
    window.updateHeaderChatBadge = (totalUnreadCount) => {
        const tenantBadge = document.getElementById('tenantChatsBadge');
        const companyBadge = document.getElementById('companyChatsBadge');
        const targetBadge = tenantBadge?.offsetParent !== null ? tenantBadge : (companyBadge?.offsetParent !== null ? companyBadge : null);

        console.log(`[updateHeaderChatBadge] Called with count: ${totalUnreadCount}. Target badge found:`, targetBadge);

        if (targetBadge) {
            const count = parseInt(totalUnreadCount);
            if (isNaN(count) || count < 0) {
                console.warn("[updateHeaderChatBadge] Invalid count received:", totalUnreadCount);
                targetBadge.style.display = 'none'; targetBadge.classList.remove('updated'); return;
            }
            if (count > 0) {
                targetBadge.textContent = count > 9 ? '9+' : count;
                targetBadge.style.display = 'inline-block';
                targetBadge.classList.remove('updated'); void targetBadge.offsetWidth; targetBadge.classList.add('updated');
            } else {
                targetBadge.style.display = 'none'; targetBadge.classList.remove('updated');
            }
            console.log(`[updateHeaderChatBadge] Badge ${targetBadge.id} updated. Text: ${targetBadge.textContent}, Display: ${targetBadge.style.display}`);
        } else { console.warn("[updateHeaderChatBadge] Target header badge element not found or not visible."); }
    };

    // Инициализация общего счетчика при загрузке (сервер пришлет актуальное значение через total_unread_update)
    // Убираем пересчет на клиенте при загрузке
    // const initialUnreadCount = document.querySelectorAll('.chat-list-item.unread').length;
    // window.updateHeaderChatBadge(initialUnreadCount);
    console.log("[Chat.js] DOM Loaded. Waiting for server counts...");

    // Добавим обработчик для кнопки "Написать владельцу" (если она на этой же странице)
    // Но лучше держать этот обработчик на той странице, где кнопка реально находится (property-details.ejs)
    /*
    document.querySelectorAll('.contact-owner-btn').forEach(button => {
        button.addEventListener('click', async (e) => {
            // ... логика открытия модального окна или запроса /chats ...
        });
    });
    */

}); // End DOMContentLoaded

// Экспортируем функции, если нужно использовать их из других скриптов (не обязательно для текущей структуры)
// export { appendMessage, scrollToBottom, openChat, handleIncomingMessage, loadMoreMessages, showToastNotification, hideToast, markChatAsRead };