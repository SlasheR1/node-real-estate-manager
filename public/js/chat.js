// public/js/chat.js (Финальная версия с глобальным сокетом и разделением логики)

// --- Глобальные переменные состояния чата ---
window.currentChatId = null; // ID текущего открытого чата (теперь в window)
let isLoadingMessages = false; // Флаг, идет ли загрузка старых сообщений
let hasMoreMessages = true; // Флаг, есть ли еще сообщения для загрузки в текущем чате
let oldestMessageTimestamp = null; // Timestamp самого старого загруженного сообщения в текущем чате
const currentUsername = document.querySelector('.main-header')?.dataset.currentUser || null; // Получаем username текущего пользователя

// --- Инициализация глобального сокета (используем из header.ejs) ---
const socket = window.socket || null;
if (socket) {
    console.log('[Chat.js] Используется существующий глобальный сокет:', socket.id);
} else {
    console.warn('[Chat.js] Глобальный сокет (window.socket) не найден. Функциональность чата будет ограничена.');
}

// --- Вспомогательные функции ---

/**
 * Создает и добавляет DOM-элемент сообщения в указанный контейнер.
 * @param {object} message - Объект сообщения (id, text, timestamp, senderId, isReadByRecipient, timestampFormatted).
 * @param {HTMLElement} container - DOM-элемент контейнера сообщений (#messageList).
 * @param {boolean} [prepend=false] - Добавить в начало (true) или в конец (false).
 */
const appendMessage = (message, container, prepend = false) => {
    if (!message || !container || typeof message.text === 'undefined') {
        console.warn("appendMessage: Невалидные данные сообщения или контейнер.", { message, container });
        return;
    }
    if (message.id && container.querySelector(`.message-bubble[data-message-id="${message.id}"]`)) {
        console.log(`[appendMessage] Сообщение с ID ${message.id} уже существует, пропускаем.`);
        return;
    }

    // Определяем, наше ли это сообщение, СРАВНИВАЯ С ГЛОБАЛЬНЫМ username
    const isOwn = message.senderId === currentUsername;
    // Проверяем, прочитано ли ОНО получателем (актуально только для isOwn = true)
    // Флаг isReadByRecipient приходит от сервера (из getChatMessages или готовится на лету при emit)
    const isReadByRecipient = isOwn && message.isReadByRecipient === true;

    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${isOwn ? 'own' : 'other'} ${isReadByRecipient ? 'read' : ''}`;
    bubble.dataset.timestamp = message.timestamp || Date.now();
    if (message.id) { bubble.dataset.messageId = message.id; }

    const textEl = document.createElement('div');
    textEl.className = 'message-text';
    textEl.textContent = message.text;

    const metaEl = document.createElement('div');
    metaEl.className = 'message-meta';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    timeSpan.textContent = message.timestampFormatted || '--:--';
    metaEl.appendChild(timeSpan);

    if (isOwn) {
        const ticksSpan = document.createElement('span');
        ticksSpan.className = 'message-status-ticks';
        // Используем isReadByRecipient для определения иконки
        ticksSpan.innerHTML = `<i class="fas ${isReadByRecipient ? 'fa-check-double' : 'fa-check'}"></i>`;
        metaEl.appendChild(ticksSpan);
    }

    bubble.appendChild(textEl);
    bubble.appendChild(metaEl);

    if (prepend) {
        const loadMoreBtn = container.querySelector('#loadMoreMessagesBtn');
        if (loadMoreBtn) {
            container.insertBefore(bubble, loadMoreBtn.nextSibling);
        } else {
            container.prepend(bubble);
        }
        if (message.timestamp && typeof message.timestamp === 'number' && (!oldestMessageTimestamp || message.timestamp < oldestMessageTimestamp)) {
            oldestMessageTimestamp = message.timestamp;
            console.log("[appendMessage Prepend] Обновлен oldestMessageTimestamp:", oldestMessageTimestamp);
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
        requestAnimationFrame(() => { element.scrollTop = element.scrollHeight; });
    }
};

/**
 * Обновляет состояние кнопки "Загрузить еще".
 * @param {boolean} show - Показать (true) или скрыть (false).
 * @param {boolean} [loading=false] - Показать спиннер (true) или текст (false).
 * @param {string} [text='Загрузить еще'] - Текст кнопки.
 */
const updateLoadMoreButton = (show, loading = false, text = 'Загрузить еще') => {
    const loadMoreBtn = document.getElementById('loadMoreMessagesBtn');
    if (!loadMoreBtn) return;
    loadMoreBtn.classList.toggle('hidden', !show);
    loadMoreBtn.disabled = loading;
    const buttonTextEl = loadMoreBtn.querySelector('.button-text');
    const spinnerEl = loadMoreBtn.querySelector('.button-spinner');
    if (buttonTextEl) buttonTextEl.textContent = loading ? '' : text;
    if (spinnerEl) spinnerEl.style.display = loading ? 'inline-block' : 'none';
};

// --- Функции для управления состоянием чата ---
window.setOldestMessageTimestamp = (timestamp) => {
    if (typeof timestamp === 'number' && timestamp > 0) {
        oldestMessageTimestamp = timestamp;
        console.log('[Chat State] Установлен oldestMessageTimestamp:', oldestMessageTimestamp);
    } else {
        console.warn('[Chat State] Попытка установить невалидный oldestMessageTimestamp:', timestamp);
        oldestMessageTimestamp = null;
    }
};
window.updateHasMoreMessages = (hasMore) => {
    hasMoreMessages = hasMore === true;
    console.log('[Chat State] Установлен hasMoreMessages:', hasMoreMessages);
    // Обновляем кнопку ТОЛЬКО если она есть на странице (вдруг вызовется не со страницы чата)
    const loadMoreBtn = document.getElementById('loadMoreMessagesBtn');
    if(loadMoreBtn) {
        updateLoadMoreButton(hasMoreMessages, false);
    }
};

// --- Основная логика чата ---

/**
 * Функция открытия чата. Загружает данные чата и сообщения через API.
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
    const chatListElement = document.getElementById('chatList');

    if (!messageList || !chatPlaceholder || !chatView || !chatViewHeaderName || !messageInputForm || !sendMessageBtn || !chatListElement) {
        console.error("[openChat] Ключевые элементы UI чата не найдены!");
        return;
    }
    if (isLoadingMessages) { console.log(`[openChat] Загрузка уже идет.`); return; }
    if (window.currentChatId === chatId && !chatView.classList.contains('hidden')) { console.log(`[openChat] Чат ${chatId} уже открыт.`); return; }

    console.log(`[openChat] Открытие чата: ${chatId}`);
    window.currentChatId = chatId; // Обновляем глобальную переменную
    hasMoreMessages = true;
    oldestMessageTimestamp = null;
    isLoadingMessages = true;

    // Обновление UI списка чатов
    chatListElement.querySelectorAll('.chat-list-item.active').forEach(el => el.classList.remove('active'));
    const chatListItem = chatListElement.querySelector(`.chat-list-item[data-chat-id="${chatId}"]`);
    if (chatListItem) {
        chatListItem.classList.add('active');
        chatListItem.classList.remove('unread'); // Убираем стиль непрочитанного
        const badge = chatListItem.querySelector('.unread-badge');
        if (badge) badge.style.display = 'none'; // Скрываем бейдж
        // Прокрутка к активному элементу (опционально)
        // chatListItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Подготовка основной области чата
    chatPlaceholder.style.display = 'none';
    chatView.classList.remove('hidden');
    messageList.innerHTML = ''; // Очищаем
    const loadMoreBtnHTML = `<button id="loadMoreMessagesBtn" class="btn btn-secondary btn-small load-more-btn hidden"> <i class="fas fa-spinner fa-spin button-spinner" style="display: none;"></i> <span class="button-text">Загрузить еще</span> </button>`;
    messageList.insertAdjacentHTML('afterbegin', loadMoreBtnHTML);
    updateLoadMoreButton(false);
    messageInputForm.dataset.chatId = chatId;

    try {
        // Отправка события о прочтении на сервер
        if (socket) {
            socket.emit('mark_chat_read', chatId);
            console.log(`[openChat] Отправлено событие mark_chat_read для чата ${chatId}`);
        } else { console.warn("[openChat] Сокет не инициализирован."); }

        // Загрузка данных чата
        const response = await fetch(`/api/chats/${chatId}/details`);
        if (!response.ok) { throw new Error(`Ошибка загрузки: ${response.status} ${response.statusText}`); }
        const chatDetails = await response.json();
        if (!chatDetails.success) { throw new Error(chatDetails.error || 'Ошибка данных чата.'); }
        console.log("[openChat] Получены детали чата:", chatDetails);

        // Обновляем UI
        if (chatViewHeaderName) chatViewHeaderName.textContent = chatDetails.otherParticipantName || 'Чат';
        if (chatViewSubjectLink) { /* ... логика subjectLink ... */
            if (chatDetails.subjectLink && chatDetails.chatSubject) { chatViewSubjectLink.href = chatDetails.subjectLink; chatViewSubjectLink.textContent = chatDetails.chatSubject; chatViewSubjectLink.style.display = 'inline'; }
            else { chatViewSubjectLink.style.display = 'none'; }
        }

        // Отображаем сообщения
        const messages = chatDetails.messages || [];
        if (messages.length === 0) {
            window.updateHasMoreMessages(false);
            const noMsgP = document.createElement('p'); noMsgP.textContent = "Нет сообщений."; noMsgP.style.cssText = 'text-align: center; color: var(--text-secondary); padding: 20px;';
            const loadBtn = messageList.querySelector('#loadMoreMessagesBtn'); if (loadBtn) messageList.insertBefore(noMsgP, loadBtn.nextSibling); else messageList.appendChild(noMsgP);
        } else {
            window.setOldestMessageTimestamp(messages[0]?.timestamp || null);
            messages.forEach(msg => appendMessage(msg, messageList, false));
            const initialLoadLimit = chatDetails.limit || 50;
            window.updateHasMoreMessages(messages.length >= initialLoadLimit);
        }
        scrollToBottom(messageList, false);
        const textarea = document.getElementById('messageTextarea'); if(textarea) textarea.focus();

    } catch (error) {
        console.error('[openChat] Ошибка:', error);
        window.currentChatId = null; // Сбрасываем ID
        if (chatPlaceholder) chatPlaceholder.style.display = 'flex';
        if (chatView) chatView.classList.add('hidden');
        if (typeof window.showToastNotification === 'function') {
             window.showToastNotification({ text: `Не удалось загрузить чат: ${error.message}`, senderName: 'Ошибка', type: 'error' });
        } else { alert(`Не удалось загрузить чат: ${error.message}`); }
    } finally {
        isLoadingMessages = false;
    }
};

/**
 * Загружает предыдущую порцию сообщений для текущего чата.
 */
const loadMoreMessages = async () => {
    const messageList = document.getElementById('messageList');
    if (!window.currentChatId || isLoadingMessages || !hasMoreMessages || !messageList) {
        console.log("[loadMoreMessages] Условия не выполнены.");
        updateLoadMoreButton(false); return;
    }
    isLoadingMessages = true; updateLoadMoreButton(true, true);
    try {
        const beforeTsParam = (typeof oldestMessageTimestamp === 'number' && oldestMessageTimestamp > 0) ? oldestMessageTimestamp : '';
        const limit = 30; const url = `/chats/${window.currentChatId}/messages/history?limit=${limit}&beforeTimestamp=${beforeTsParam}`;
        console.log(`[loadMoreMessages] Запрос: ${url}`);
        const response = await fetch(url); const result = await response.json();
        if (!response.ok || !result.success) { throw new Error(result.error || 'Не удалось загрузить историю.'); }
        if (result.messages && result.messages.length > 0) {
            const scrollHeightBefore = messageList.scrollHeight; const scrollTopBefore = messageList.scrollTop;
            result.messages.forEach(msg => appendMessage(msg, messageList, true));
            requestAnimationFrame(() => { messageList.scrollTop = scrollTopBefore + (messageList.scrollHeight - scrollHeightBefore); });
            window.setOldestMessageTimestamp(result.messages[0]?.timestamp || oldestMessageTimestamp);
            window.updateHasMoreMessages(result.hasMore === true); // Обновляем флаг и кнопку
            console.log("[loadMoreMessages] Загружено. Есть еще:", hasMoreMessages);
        } else { window.updateHasMoreMessages(false); console.log("[loadMoreMessages] Больше нет сообщений."); }
    } catch (error) {
        console.error("[loadMoreMessages] Ошибка:", error);
        updateLoadMoreButton(true, false, 'Ошибка загрузки');
        setTimeout(() => { if (hasMoreMessages) updateLoadMoreButton(true, false); else updateLoadMoreButton(false); }, 3000);
    } finally { isLoadingMessages = false; if (hasMoreMessages && !isLoadingMessages) updateLoadMoreButton(true, false); }
};

/**
 * Обрабатывает входящее сообщение от Socket.IO. (Вызывается из header.ejs)
 * Обновляет сайдбар и добавляет сообщение в открытый чат.
 * @param {object} data - Данные события { chatId, message: {...} }.
 */
window.handleIncomingMessage = (data) => {
    if (!data || !data.chatId || !data.message) { console.warn('[handleIncomingMessage] Невалидные данные:', data); return; }
    const { chatId, message } = data;
    console.log(`[handleIncomingMessage] Обработка сообщения для чата ${chatId}`);
    const chatListElement = document.getElementById('chatList');
    const messageList = document.getElementById('messageList'); // Контейнер сообщений

    // 1. Обновление списка чатов (Sidebar)
    const chatListItem = chatListElement ? chatListElement.querySelector(`.chat-list-item[data-chat-id="${chatId}"]`) : null;
    if (chatListItem) {
        const lastMessageEl = chatListItem.querySelector('.chat-last-message');
        const timestampEl = chatListItem.querySelector('.chat-timestamp');
        if (lastMessageEl && message.text) {
            const snippet = message.text.length > 35 ? message.text.substring(0, 32) + '...' : message.text;
            lastMessageEl.innerHTML = '';
             // Используем currentUsername для определения префикса "Вы:"
             if (message.senderId === currentUsername) {
                 const selfPrefix = document.createElement('span'); selfPrefix.className = 'self-prefix'; selfPrefix.textContent = 'Вы: ';
                 lastMessageEl.appendChild(selfPrefix);
             }
            lastMessageEl.appendChild(document.createTextNode(snippet));
        }
        if (timestampEl && message.timestamp) { timestampEl.textContent = message.timestampFormatted || '--:--'; }
        if (chatListElement && chatListItem.parentNode === chatListElement) {
            const noChatsMsg = chatListElement.querySelector('.no-chats-message');
            if (noChatsMsg) noChatsMsg.remove();
            chatListElement.prepend(chatListItem);
        }
        // Бейдж обновляется через 'chat_list_unread_update'
    } else if (chatListElement) {
         // TODO: Добавить логику создания нового элемента чата в списке, если его нет
         console.warn(`[handleIncomingMessage] Чат ${chatId} не найден в списке. Требуется динамическое добавление.`);
    }

    // 2. Добавление сообщения в ОТКРЫТЫЙ чат
    if (chatId === window.currentChatId && messageList) {
        console.log(`[handleIncomingMessage] Добавление сообщения в открытый чат ${chatId}`);
        const isNearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 150;
        // В appendMessage isOwnMessage определится сравнением message.senderId с currentUsername
        appendMessage(message, messageList, false);
        if (isNearBottom || message.senderId === currentUsername) { scrollToBottom(messageList, true); }

        // Отправка события о прочтении (если сообщение не наше)
        if (socket && message.senderId !== currentUsername) {
            socket.emit('mark_chat_read', chatId);
            console.log(`[handleIncomingMessage] Отправлено mark_chat_read для входящего сообщения в активном чате ${chatId}`);
        }
    } else {
         console.log(`[handleIncomingMessage] Сообщение для чата ${chatId}, но открыт чат ${window.currentChatId}. В DOM не добавляем.`);
    }
};

/**
 * Обрабатывает событие прочтения сообщений от другого пользователя. (Вызывается из header.ejs)
 * Обновляет галочки у отправленных сообщений в ОТКРЫТОМ чате.
 * @param {object} data - Данные события { chatId, readerId, readUpToTimestamp }.
 */
window.handleMessagesRead = (data) => {
     const { chatId, readerId, readUpToTimestamp } = data;
     if (chatId === window.currentChatId && readUpToTimestamp && typeof readUpToTimestamp === 'number') {
         const messageList = document.getElementById('messageList');
         if (!messageList) return;
         console.log(`[handleMessagesRead] Обновление галочек в чате ${chatId} до ${readUpToTimestamp}`);
         const outgoingMessages = messageList.querySelectorAll('.message-bubble.own:not(.read)');
         outgoingMessages.forEach(bubble => {
             const messageTimestamp = parseInt(bubble.dataset.timestamp || '0');
             if (messageTimestamp <= readUpToTimestamp) {
                 const ticksIcon = bubble.querySelector('.message-status-ticks i');
                 if (ticksIcon && !ticksIcon.classList.contains('fa-check-double')) {
                      ticksIcon.classList.remove('fa-check'); ticksIcon.classList.add('fa-check-double'); bubble.classList.add('read');
                 }
             }
         });
     } else {
         // console.debug(`[handleMessagesRead] Событие прочтения для неактивного чата ${chatId} проигнорировано.`);
     }
};

/**
 * Отправляет сообщение на сервер.
 */
const sendMessage = async () => {
    const messageInputForm = document.getElementById('messageInputForm');
    const messageTextarea = document.getElementById('messageTextarea');
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    if (!messageInputForm || !messageTextarea || !sendMessageBtn) { console.error("[sendMessage] Элементы формы не найдены."); return; }
    const chatId = messageInputForm.dataset.chatId; // Используем data-атрибут
    const text = messageTextarea.value.trim();
    if (!chatId || !text || sendMessageBtn.disabled) { console.log("[sendMessage] Условия отправки не выполнены."); return; }

    const sendButtonSpinner = sendMessageBtn.querySelector('.button-spinner');
    const sendButtonIcon = sendMessageBtn.querySelector('i:not(.button-spinner)');
    sendMessageBtn.disabled = true; if (sendButtonIcon) sendButtonIcon.style.display = 'none'; if (sendButtonSpinner) sendButtonSpinner.style.display = 'inline-block';

    try {
        console.log(`[sendMessage] Отправка сообщения в чат ${chatId}`);
        const response = await fetch(`/chats/${chatId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ text }) });
        const result = await response.json();
        if (!response.ok || !result.success) { throw new Error(result.error || `Ошибка сервера: ${response.status}`); }
        console.log('[sendMessage] Сообщение успешно отправлено API:', result);
        messageTextarea.value = ''; messageTextarea.style.height = 'auto'; messageTextarea.style.height = `${messageTextarea.scrollHeight}px`;
    } catch (error) {
        console.error('[sendMessage] Ошибка отправки:', error);
        if (typeof window.showToastNotification === 'function') { window.showToastNotification({ text: `Не удалось отправить: ${error.message}`, type: 'error' }); }
        else { alert(`Не удалось отправить: ${error.message}`); }
    } finally {
        // Разблокируем кнопку, ТОЛЬКО если поле ввода пустое
        if (messageTextarea.value.trim() === '') { sendMessageBtn.disabled = true; }
        else { sendMessageBtn.disabled = false; }
        if (sendButtonIcon) sendButtonIcon.style.display = 'inline-block'; if (sendButtonSpinner) sendButtonSpinner.style.display = 'none';
    }
};

// --- Инициализация при загрузке DOM ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("[Chat.js] DOMContentLoaded. Инициализация обработчиков.");
    const messageInputForm = document.getElementById('messageInputForm');
    const messageTextarea = document.getElementById('messageTextarea');
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    const messageList = document.getElementById('messageList');
    // --- Обработчики формы отправки ---
    if (messageInputForm && messageTextarea && sendMessageBtn) {
        messageInputForm.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
        messageTextarea.addEventListener('input', () => { const hasText = messageTextarea.value.trim().length > 0; sendMessageBtn.disabled = !hasText; const maxHeight=120; messageTextarea.style.height='auto'; messageTextarea.style.height=`${Math.min(messageTextarea.scrollHeight,maxHeight)}px`; });
        messageTextarea.addEventListener('keydown', (e) => { if (e.key==='Enter' && !e.shiftKey && !sendMessageBtn.disabled) { e.preventDefault(); sendMessage(); } });
        sendMessageBtn.disabled = true; // Кнопка выключена изначально
    }
    // --- Обработчик кнопки "Загрузить еще" ---
    if (messageList) { messageList.addEventListener('click', (event) => { const loadButton = event.target.closest('#loadMoreMessagesBtn'); if (loadButton && !loadButton.disabled) { loadMoreMessages(); } }); }
    // --- Инициализация открытия чата по URL (только на /chats) ---
    if (window.location.pathname === '/chats') { const hash = window.location.hash; if (hash && hash.startsWith('#chat-')) { const chatIdToOpen = hash.substring(6); if (chatIdToOpen) { console.log(`[Chat.js Init] Найден хеш: ${chatIdToOpen}. Открытие...`); setTimeout(() => { if (typeof window.openChat === 'function') window.openChat(chatIdToOpen); else console.error("[Chat.js Init] window.openChat не найдена!"); }, 150); } } }
    // --- Инициализация для страницы /chats/:chatId ---
    const pathParts = window.location.pathname.split('/'); const isChatViewPage = pathParts.length >= 3 && pathParts[1] === 'chats' && pathParts[2];
    if (isChatViewPage) { const loadedChatId = pathParts[2]; console.log(`[Chat.js Init] На странице чата: ${loadedChatId}`); window.currentChatId = loadedChatId; if (messageList) { scrollToBottom(messageList, false); const loadMoreBtn = document.getElementById('loadMoreMessagesBtn'); hasMoreMessages = loadMoreBtn && !loadMoreBtn.classList.contains('hidden'); console.log(`[Chat.js Init] Initial hasMoreMessages on chat-view: ${hasMoreMessages}`); } const textarea = document.getElementById('messageTextarea'); if(textarea) textarea.focus(); }
}); // --- Конец DOMContentLoaded ---

// --- Подписка на события Socket.IO (только если сокет существует) ---
if (socket) {
    // 'new_message' и 'messages_read_up_to' обрабатываются в header.ejs -> window.handle...
    // 'total_unread_update' обрабатывается в header.ejs -> window.updateHeaderChatBadge

    // Обработка обновления счетчика для КОНКРЕТНОГО чата в списке
    socket.on('chat_list_unread_update', ({ chatId, unreadCount }) => {
        console.log(`[Socket.IO Chat.js] Получено chat_list_unread_update для ${chatId}: ${unreadCount}`);
        const chatListItem = document.querySelector(`.chat-list-item[data-chat-id="${chatId}"]`);
        if (chatListItem) {
            const badge = chatListItem.querySelector('.unread-badge');
            const metaContainer = chatListItem.querySelector('.chat-meta');
            if (unreadCount > 0) {
                 chatListItem.classList.add('unread');
                 let targetBadge = badge;
                 if (!targetBadge && metaContainer) { const newB = document.createElement('span'); newB.className = 'unread-badge'; newB.id = `unread-badge-${chatId}`; metaContainer.appendChild(newB); targetBadge = newB; }
                 if (targetBadge) { targetBadge.textContent = unreadCount > 9 ? '9+' : unreadCount; targetBadge.style.display = 'inline-block'; targetBadge.classList.add('pulse'); setTimeout(() => targetBadge.classList.remove('pulse'), 1500); }
            } else {
                 chatListItem.classList.remove('unread');
                 if (badge) { badge.style.display = 'none'; }
            }
        }
    });
} else {
    console.warn("[Chat.js] Socket.IO не инициализирован. Подписка на 'chat_list_unread_update' не выполнена.");
}