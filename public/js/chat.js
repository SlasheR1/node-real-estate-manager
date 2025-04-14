// public/js/chat.js

// Глобальные переменные для состояния чата
let currentChatId = null;
let isLoadingMessages = false;
let hasMoreMessages = true;
let oldestMessageTimestamp = null;
let socket = null; // Глобальная переменная для сокета

// --- Функции для установки переменных извне (вызываются из EJS) ---
window.setOldestMessageTimestamp = (timestamp) => {
    if (typeof timestamp === 'number' && timestamp > 0) {
        oldestMessageTimestamp = timestamp;
        console.log('[Chat View Init] Initial oldestMessageTimestamp set to:', oldestMessageTimestamp);
    } else {
        console.warn('[Chat View Init] Attempted to set invalid oldestMessageTimestamp:', timestamp);
        oldestMessageTimestamp = null; // Сбрасываем, если некорректно
    }
};

window.updateHasMoreMessages = (hasMore) => {
    hasMoreMessages = hasMore === true; // Приводим к boolean
    console.log('[Chat View Init] Initial hasMoreMessages set to:', hasMoreMessages);
    const loadMoreBtn = document.getElementById('loadMoreMessagesBtn');
    if (loadMoreBtn) {
        loadMoreBtn.classList.toggle('hidden', !hasMoreMessages);
    }
};

// --- Основные функции UI ---

/**
 * Добавляет элемент сообщения в контейнер чата.
 * @param {object} message - Объект сообщения.
 * @param {HTMLElement} container - DOM-элемент контейнера сообщений.
 * @param {boolean} [prepend=false] - Добавить в начало (true) или в конец (false).
 */
// public/js/chat.js -> Заменяем ТОЛЬКО эту функцию

const appendMessage = (message, container, prepend = false) => {
    if (!message || !container || !message.text) {
        console.warn("appendMessage: Invalid message or container.", { message, container });
        return;
    }
    const bubble = document.createElement('div');
    const isOwn = message.isOwnMessage === true; // <<< Явно проверяем на tru
    // Добавляем класс 'read', если сообщение прочитано (пока всегда false)
    // TODO: Получать статус 'read' из message объекта, когда бэкенд будет его предоставлять
    const isRead = false; // Заглушка
    // <<< УБЕДИТЕСЬ, ЧТО КЛАССЫ ДОБАВЛЯЮТСЯ КОРРЕКТНО >>>
    bubble.className = `message-bubble ${isOwn ? 'own' : 'other'} ${isRead && isOwn ? 'read' : ''}`;
    // <<< КОНЕЦ ПРОВЕРКИ КЛАССОВ >>>
   
    bubble.dataset.timestamp = message.timestamp || Date.now();

    const textEl = document.createElement('div');
    textEl.className = 'message-text';
    textEl.textContent = message.text;

    const metaEl = document.createElement('div');
    metaEl.className = 'message-meta';

    // Создаем span для времени
    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    timeSpan.textContent = message.timestampFormatted || new Date(message.timestamp || Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    metaEl.appendChild(timeSpan); // Добавляем время

    // Добавляем галочки ТОЛЬКО для исходящих сообщений
    if (isOwn) { // <<< Проверяем isOwn здесь для добавления галочек >>>
        const ticksSpan = document.createElement('span');
        ticksSpan.className = 'message-status-ticks';
        ticksSpan.innerHTML = '<i class="fas fa-check"></i>'; // Пока одна
        // if (isRead) { ticksSpan.innerHTML = '<i class="fas fa-check-double"></i>'; }
        metaEl.appendChild(ticksSpan);
    }

    bubble.appendChild(textEl);
    bubble.appendChild(metaEl);

    // Логика добавления в контейнер (prepend/append) остается без изменений
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
        // Используем requestAnimationFrame для более надежной прокрутки после добавления элементов
        requestAnimationFrame(() => {
            element.scrollTop = element.scrollHeight;
        });
    }
};

/**
 * Функция открытия чата. Загружает данные чата и сообщения.
 * Доступна глобально как window.openChat.
 * @param {string} chatId - ID чата для открытия.
 */
window.openChat = async (chatId) => {
    // Получаем ссылки на DOM элементы внутри функции, чтобы они были актуальны
    const messageList = document.getElementById('messageList');
    const chatPlaceholder = document.getElementById('chatPlaceholder');
    const chatView = document.getElementById('chatView');
    const chatViewHeaderName = document.getElementById('chatViewHeaderName');
    const chatViewSubjectLink = document.getElementById('chatViewSubjectLink');
    const messageInputForm = document.getElementById('messageInputForm');
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    const loadMoreMessagesBtn = document.getElementById('loadMoreMessagesBtn');

    if (!messageList || !chatPlaceholder || !chatView || !chatViewHeaderName || !messageInputForm || !sendMessageBtn || !loadMoreMessagesBtn) {
        console.error("Chat UI elements not found!");
        return;
    }

    if (isLoadingMessages || currentChatId === chatId) return; // Не перезагружаем
    console.log(`Opening chat: ${chatId}`);
    currentChatId = chatId;
    hasMoreMessages = true; // Сброс состояния пагинации
    oldestMessageTimestamp = null;

    // --- Обновление UI списка чатов ---
    document.querySelectorAll('.chat-list-item.active').forEach(el => el.classList.remove('active'));
    const chatListItem = document.querySelector(`.chat-list-item[data-chat-id="${chatId}"]`);
    if (chatListItem) {
        chatListItem.classList.add('active');
        const badge = chatListItem.querySelector('.unread-badge');
        if (badge) {
            badge.style.display = 'none';
            badge.style.animation = 'none';
            // TODO: Обновить общий счетчик в хедере
        }
    }

    // --- Подготовка основной области чата ---
    chatPlaceholder.style.display = 'none'; // Скрываем плейсхолдер
    chatView.classList.remove('hidden');    // Показываем область чата
    messageList.innerHTML = '';             // Очищаем список сообщений
    // Добавляем кнопку "Загрузить еще" обратно (она может быть скрыта при достижении конца)
    messageList.appendChild(loadMoreMessagesBtn.cloneNode(true)); // Клонируем, чтобы обработчики не дублировались
    const actualLoadMoreBtn = messageList.querySelector('.load-more-btn'); // Находим добавленную кнопку
     if (actualLoadMoreBtn) {
         actualLoadMoreBtn.classList.add('hidden'); // Скрываем по умолчанию, пока не узнаем, есть ли еще
         actualLoadMoreBtn.disabled = false;
         actualLoadMoreBtn.querySelector('.button-text').textContent = 'Загрузить еще';
         actualLoadMoreBtn.querySelector('.button-spinner').style.display = 'none';
         // Перепривязываем обработчик
         actualLoadMoreBtn.addEventListener('click', loadMoreMessages);
     }


    messageInputForm.dataset.chatId = chatId; // Устанавливаем ID для формы
    sendMessageBtn.disabled = false; // Включаем кнопку отправки

    // --- Загрузка данных чата ---
    isLoadingMessages = true;
    try {
        const response = await fetch(`/chats/${chatId}`); // Запрос на HTML страницы чата
        if (!response.ok) {
            throw new Error(`Ошибка загрузки чата: ${response.status} ${response.statusText}`);
        }
        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Обновляем заголовок и тему
        const headerName = doc.getElementById('chatViewHeaderName')?.textContent || 'Чат';
        const subjectLinkHref = doc.querySelector('#chatViewSubjectLink')?.getAttribute('href');
        const subjectLinkText = doc.querySelector('#chatViewSubjectLink')?.textContent;

        if (chatViewHeaderName) chatViewHeaderName.textContent = headerName;
        if (chatViewSubjectLink) {
            if (subjectLinkHref && subjectLinkText) {
                chatViewSubjectLink.href = subjectLinkHref;
                chatViewSubjectLink.textContent = subjectLinkText;
                chatViewSubjectLink.style.display = 'inline';
            } else {
                chatViewSubjectLink.style.display = 'none';
            }
        }

        // Отображаем сообщения из загруженного HTML
        const messagesContainer = doc.getElementById('messageList');
        if (messagesContainer) {
             const messageBubbles = messagesContainer.querySelectorAll('.message-bubble');
             if (messageBubbles.length === 0) {
                 hasMoreMessages = false;
                 if (actualLoadMoreBtn) actualLoadMoreBtn.classList.add('hidden');
                 // Добавляем сообщение "Нет сообщений"
                  const noMsgP = document.createElement('p');
                  noMsgP.textContent = "Нет сообщений в этом чате.";
                  noMsgP.style.textAlign = 'center'; noMsgP.style.color = 'var(--text-secondary)'; noMsgP.style.padding = '20px';
                  messageList.appendChild(noMsgP);
             } else {
                 // Устанавливаем oldest timestamp по ПЕРВОМУ сообщению (старое сверху)
                 oldestMessageTimestamp = parseInt(messageBubbles[0]?.dataset?.timestamp || '0');
                 console.log("Initial oldestMessageTimestamp from parsed HTML:", oldestMessageTimestamp);
                 // Добавляем все сообщения
                 messageBubbles.forEach(bubble => messageList.appendChild(bubble.cloneNode(true)));

                 // Проверяем, нужно ли показывать кнопку "Загрузить еще"
                 const initialLoadLimit = 50; // Лимит из GET /chats/:chatId
                 if (messageBubbles.length < initialLoadLimit) {
                     hasMoreMessages = false;
                      if (actualLoadMoreBtn) actualLoadMoreBtn.classList.add('hidden');
                 } else {
                      if (actualLoadMoreBtn) actualLoadMoreBtn.classList.remove('hidden'); // Показываем кнопку
                 }
             }
             scrollToBottom(messageList, false); // Прокрутка без анимации
        } else {
             console.warn("Message list container not found in fetched HTML.");
             hasMoreMessages = false; // Не можем загрузить больше, если контейнер не найден
             if (actualLoadMoreBtn) actualLoadMoreBtn.classList.add('hidden');
        }


        // Отправляем событие о прочтении на сервер
        if (socket) {
            socket.emit('mark_messages_read', chatId);
            console.log(`Sent mark_messages_read for chat ${chatId}`);
        }

    } catch (error) {
        console.error('Error opening chat:', error);
        if (chatPlaceholder) chatPlaceholder.style.display = 'flex'; // Показываем плейсхолдер при ошибке
        if (chatView) chatView.classList.add('hidden');
        alert(`Не удалось загрузить чат: ${error.message}`);
    } finally {
        isLoadingMessages = false;
    }
};

/**
 * Обрабатывает входящее сообщение от Socket.IO.
 * Обновляет список чатов и добавляет сообщение в открытый чат.
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
            lastMessageEl.innerHTML = `${message.isOwnMessage ? '<span class="self-prefix">Вы:</span> ' : ''}${snippet}`;
        }
        if (timestampEl && message.timestamp) {
            timestampEl.textContent = new Date(message.timestamp).toLocaleString('ru-RU', { timeStyle: 'short' });
        }
        if (chatListElement && chatListItem.parentNode === chatListElement) {
            chatListElement.prepend(chatListItem); // Наверх
        }
        // Обновление бейджа
        if (chatId !== currentChatId && !message.isOwnMessage) {
            chatListItem.classList.add('unread');
            let badge = chatListItem.querySelector('.unread-badge');
            if (!badge) {
                 badge = document.createElement('span');
                 badge.className = 'unread-badge';
                 badge.id = `unread-badge-${chatId}`;
                 chatListItem.querySelector('.chat-meta')?.appendChild(badge);
            }
            const currentCount = parseInt(badge.textContent) || 0;
            const newCount = currentCount + 1;
            badge.textContent = newCount > 9 ? '9+' : newCount;
            badge.style.display = 'inline-block';
            badge.classList.add('animate-pulse');
            setTimeout(() => badge.classList.remove('animate-pulse'), 1500);
            // TODO: Обновить общий счетчик в хедере
        }
    } else {
        console.warn(`Chat item for ${chatId} not found. Reloading list might be needed.`);
        // Можно добавить логику перезагрузки списка чатов при получении сообщения для неизвестного чата
    }

    // 2. Добавление сообщения в активный чат
    if (chatId === currentChatId && messageList) {
        const isScrolledToBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 100;
        appendMessage(message, messageList, false); // Добавляем в конец
        if (isScrolledToBottom || message.isOwnMessage) {
            scrollToBottom(messageList, true);
        }
        // Отправка mark_read для входящего сообщения в активном чате
        if (socket && !message.isOwnMessage) {
            socket.emit('mark_messages_read', chatId);
            console.log(`Sent mark_messages_read for incoming message in active chat ${chatId}`);
        }
    } else if (!message.isOwnMessage) {
        // Звуковое уведомление для неактивного чата
        try { new Audio('/sounds/notification.mp3').play().catch(e => console.warn("Audio playback failed:", e)); } catch (e) {}
    }
};

/**
 * Загружает предыдущую порцию сообщений для текущего чата.
 */
const loadMoreMessages = async () => {
    const messageList = document.getElementById('messageList');
    const loadMoreMessagesBtn = messageList?.querySelector('.load-more-btn'); // Ищем кнопку внутри messageList
    const buttonText = loadMoreMessagesBtn?.querySelector('.button-text');
    const spinner = loadMoreMessagesBtn?.querySelector('.button-spinner');

    if (!currentChatId || isLoadingMessages || !hasMoreMessages || !loadMoreMessagesBtn || !messageList) {
         console.log("Conditions not met for loading more messages:", {currentChatId, isLoadingMessages, hasMoreMessages, loadMoreMessagesBtn, messageList});
        return;
    }

    isLoadingMessages = true;
    loadMoreMessagesBtn.disabled = true;
    if (buttonText) buttonText.textContent = ''; // Убираем текст
    if (spinner) spinner.style.display = 'inline-block'; // Показываем спиннер

    try {
        console.log("Loading older messages, before timestamp:", oldestMessageTimestamp);
        const url = `/chats/${currentChatId}/messages/history?limit=20&beforeTimestamp=${oldestMessageTimestamp || ''}`;
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


            hasMoreMessages = result.hasMore !== false; // Обновляем флаг
            console.log("Messages loaded. Has more:", hasMoreMessages);
            if (!hasMoreMessages) {
                loadMoreMessagesBtn.classList.add('hidden'); // Скрываем кнопку, если больше нет
            }
        } else {
            hasMoreMessages = false;
            loadMoreMessagesBtn.classList.add('hidden'); // Скрываем кнопку
            console.log("No more messages to load.");
        }

    } catch (error) {
        console.error("Error loading more messages:", error);
        if (buttonText) buttonText.textContent = 'Ошибка';
        if (spinner) spinner.style.display = 'none';
        // Оставляем кнопку видимой, но неактивной при ошибке
    } finally {
        isLoadingMessages = false;
        // Возвращаем кнопку в нормальное состояние, если ЕСТЬ еще сообщения
        if (hasMoreMessages && loadMoreMessagesBtn && buttonText && spinner) {
            loadMoreMessagesBtn.disabled = false;
            buttonText.textContent = 'Загрузить еще';
            spinner.style.display = 'none';
        }
    }
};

// --- Инициализация при загрузке DOM ---
document.addEventListener('DOMContentLoaded', () => {
    const messageInputForm = document.getElementById('messageInputForm');
    const messageTextarea = document.getElementById('messageTextarea');
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    const messageList = document.getElementById('messageList'); // Получаем здесь

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
        socket.on('unread_count_update', (data) => { /* ... (обработчик обновления счетчика) ... */
             console.log('[Chat Socket.IO] Received unread_count_update:', data);
             if (data.chatId && typeof data.unreadCount === 'number') {
                 const badge = document.getElementById(`unread-badge-${data.chatId}`); // Используем ID
                 const listItem = document.querySelector(`.chat-list-item[data-chat-id="${data.chatId}"]`);
                 if (badge) {
                     if (data.unreadCount > 0) {
                         badge.textContent = data.unreadCount > 9 ? '9+' : data.unreadCount;
                         badge.style.display = 'inline-block';
                         listItem?.classList.add('unread');
                     } else {
                         badge.style.display = 'none';
                         listItem?.classList.remove('unread');
                     }
                 } else if (data.unreadCount > 0 && listItem) { // Создаем бейдж, если его не было
                      const newBadge = document.createElement('span');
                      newBadge.className = 'unread-badge';
                      newBadge.id = `unread-badge-${data.chatId}`;
                      newBadge.textContent = data.unreadCount > 9 ? '9+' : data.unreadCount;
                      listItem.querySelector('.chat-meta')?.appendChild(newBadge);
                      listItem.classList.add('unread');
                 } else if (data.unreadCount <= 0 && listItem) {
                      listItem.classList.remove('unread'); // Убираем класс unread, если счетчик 0
                 }
                 // TODO: Обновить общий счетчик в хедере
             }
         });
        socket.on('unread_count_increment', (data) => { /* ... (обработчик инкремента счетчика) ... */
            console.log('[Chat Socket.IO] Received unread_count_increment:', data);
            if(data.chatId && data.chatId !== currentChatId) { // Только если чат не активен
                 const badge = document.getElementById(`unread-badge-${data.chatId}`);
                 const chatListItem = document.querySelector(`.chat-list-item[data-chat-id="${data.chatId}"]`);
                 if (chatListItem && !chatListItem.classList.contains('unread')) {
                     chatListItem.classList.add('unread');
                 }
                 if(badge) {
                     const currentCount = parseInt(badge.textContent) || 0;
                     const newCount = currentCount + 1;
                     badge.textContent = newCount > 9 ? '9+' : newCount;
                     badge.style.display = 'inline-block';
                     badge.classList.add('animate-pulse');
                     setTimeout(() => badge.classList.remove('animate-pulse'), 1500);
                 } else if(chatListItem) {
                      const newBadge = document.createElement('span');
                      newBadge.className = 'unread-badge animate-pulse';
                      newBadge.id = `unread-badge-${data.chatId}`;
                      newBadge.textContent = '1';
                      chatListItem.querySelector('.chat-meta')?.appendChild(newBadge);
                      setTimeout(() => newBadge.classList.remove('animate-pulse'), 1500);
                 }
                  // TODO: Увеличить общий счетчик в хедере
            }
         });

    } else {
        console.error('Socket.IO library not loaded!');
    }

    // --- Обработчики формы отправки ---
    if (messageInputForm && messageTextarea && sendMessageBtn) {
        const sendMessage = async () => {
            const chatId = messageInputForm.dataset.chatId;
            const text = messageTextarea.value.trim();
            if (!chatId || !text || sendMessageBtn.disabled) return;

            const sendButtonSpinner = sendMessageBtn.querySelector('.button-spinner');
            const sendButtonIcon = sendMessageBtn.querySelector('i:not(.button-spinner)'); // Находим основную иконку

            sendMessageBtn.disabled = true;
            if (sendButtonIcon) sendButtonIcon.style.display = 'none';
            if (sendButtonSpinner) sendButtonSpinner.style.display = 'inline-block';

            try {
                const response = await fetch(`/chats/${chatId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ text: text }) });
                const result = await response.json();
                if (!response.ok || !result.success) { throw new Error(result.error || `Ошибка отправки: ${response.statusText}`); }
                if (result.sentMessage && messageList) { // Проверяем messageList
                    appendMessage(result.sentMessage, messageList);
                    scrollToBottom(messageList);
                }
                messageTextarea.value = '';
                // Сбрасываем высоту textarea после отправки
                messageTextarea.style.height = 'auto';
                messageTextarea.style.height = `${messageTextarea.scrollHeight}px`;
                // Пересчитываем высоту еще раз на случай минимального контента
                 setTimeout(() => {
                     const baseHeight = 42; // Базовая высота из CSS
                     messageTextarea.style.height = 'auto';
                     messageTextarea.style.height = `${Math.max(baseHeight, messageTextarea.scrollHeight)}px`;
                     const maxHeight = 120; // Синхронизируем с CSS
                     messageTextarea.style.height = `${Math.min(parseInt(messageTextarea.style.height), maxHeight)}px`;
                 }, 0);

                messageTextarea.focus();
            } catch (error) { console.error('Error sending message:', error); alert(`Не удалось отправить сообщение: ${error.message}`);
            } finally {
                sendMessageBtn.disabled = false;
                if (sendButtonIcon) sendButtonIcon.style.display = 'inline-block';
                if (sendButtonSpinner) sendButtonSpinner.style.display = 'none';
            }
        };

        messageInputForm.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
        messageTextarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
             // Auto-resize textarea
             setTimeout(() => {
                 const el = e.target;
                 const baseHeight = 42; // Базовая высота из CSS
                 el.style.height = 'auto'; // Сброс для пересчета scrollHeight
                  const newHeight = Math.max(baseHeight, el.scrollHeight);
                  const maxHeight = 120; // Макс. высота из CSS
                  el.style.height = `${Math.min(newHeight, maxHeight)}px`;
             }, 0);
        });
    }

    // --- Обработчик кнопки "Загрузить еще" (привязывается к кнопке в messageList) ---
     if (messageList) {
         // Используем делегирование событий, т.к. кнопка может пересоздаваться
         messageList.addEventListener('click', (event) => {
             if (event.target && event.target.closest('.load-more-btn')) {
                 loadMoreMessages();
             }
         });
     }

    // --- Инициализация: если URL содержит ID чата, открываем его ---
    const pathParts = window.location.pathname.split('/');
    if (pathParts.length >= 3 && pathParts[1] === 'chats' && pathParts[2]) {
        const chatIdFromUrl = pathParts[2];
        // Добавляем небольшую задержку, чтобы DOM успел прорисоваться
        setTimeout(() => {
             window.openChat(chatIdFromUrl);
        }, 100); // 100ms задержка
    }

}); // End DOMContentLoaded