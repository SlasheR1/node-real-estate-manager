// main.js
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');

// --- Настройка логов ---
const logDirectory = 'C:\\logs'; // Убедитесь, что этот путь существует или может быть создан
const logFilePath = path.join(logDirectory, `real-estate-manager-main.log`);
try {
    if (!fs.existsSync(logDirectory)) { fs.mkdirSync(logDirectory, { recursive: true }); }
    log.transports.file.resolvePathFn = () => logFilePath; // Используем resolvePathFn
    console.log(`[Logger] Log file path set to: ${logFilePath}`);
    log.info(`[Logger] Application starting... Log path: ${logFilePath}`);
} catch (err) {
    console.error(`[Logger] CRITICAL ERROR: Failed to set up log directory "${logDirectory}". Logging to default path.`, err);
    log.error(`[Logger] Failed to set up custom log path. Using default. Error: ${err.message}`);
}
log.transports.file.level = 'info';
log.transports.console.level = 'info';
Object.assign(console, log.functions);
// Используем новый API для отлова ошибок
const mainErrorHandler = log.errorHandler;
mainErrorHandler.startCatching({
  showDialog: process.env.NODE_ENV !== 'development',
  onError({ createIssue, error, processType, versions }) {
    dialog.showMessageBox({
        title: 'Непредвиденная ошибка',
        message: `Произошла ошибка в процессе: ${processType}`,
        detail: error.message,
        type: 'error',
        buttons: ['Закрыть', 'Создать отчет об ошибке'],
    }).then((result) => {
        if (result.response === 1) {
            createIssue('https://github.com/ваше_имя/ваш_репозиторий/issues/new', {
                title: `Electron Error [${versions.app}]`,
                body: `\`\`\`${error.stack}\n\`\`\`\n` +
                      `OS: ${versions.os}\n` +
                      `Electron: ${versions.electron}`,
             });
        }
    });
  }
});


let mainWindow;
// Убираем глобальную переменную expressApp, она больше не нужна здесь

// --- НАСТРОЙКА AutoUpdater ---
autoUpdater.logger = log; // Используем electron-log
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = true; // Автоматически скачивать обновления
autoUpdater.autoInstallOnAppQuit = false; // НЕ устанавливать при выходе

// --- Функция проверки обновлений ---
function checkForUpdates() {
  if (process.env.NODE_ENV === 'development') {
    log.info('[AutoUpdater] Development mode detected, skipping update check.');
    return;
  }
  log.info('[AutoUpdater] Initializing update check...');
  try {
    // Запускаем проверку. Если autoDownload = true, начнется скачивание, если есть обновление.
    autoUpdater.checkForUpdates().catch(err => {
        log.error('[AutoUpdater] Error in checkForUpdates():', err.message || err);
    });
  } catch (error) {
      log.error('[AutoUpdater] Failed to initiate checkForUpdates:', error);
  }
}

// --- ИНИЦИАЛИЗАЦИЯ И ЗАПУСК СЕРВЕРА ---
async function initializeAndStartServer() {
    return new Promise(async (resolve, reject) => {
        try {
            // Требуем модуль сервера. Теперь он экспортирует объект с функцией startServer.
            const serverModule = require('./server.js');
            log.info('Модуль server.js загружен.');
            // Вызываем функцию запуска сервера и ждем её завершения (она возвращает Promise).
            await serverModule.startServer(3000); // Используем порт 3000
            log.info('Функция startServer в server.js успешно завершена (сервер слушает порт).');
            resolve(true); // Сервер запущен успешно
        } catch (err) {
            log.error('Ошибка при инициализации или запуске Express сервера:', err);
            reject(err); // Передаем ошибку для обработки в whenReady
        }
    });
}

// --- СОЗДАНИЕ ОКНА ELECTRON ---
function createWindow () {
  log.info('Creating main browser window...');
  mainWindow = new BrowserWindow({
    width: 1280, // Рекомендуется сделать немного больше для комфорта
    height: 800,
    minWidth: 940, // Минимальная ширина
    minHeight: 600, // Минимальная высота
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, // Важно для безопасности
      contextIsolation: true, // Важно для безопасности
      // Разрешаем встроенные DevTools в режиме разработки
      devTools: process.env.NODE_ENV === 'development'
    }
  });

  // --- Content Security Policy (CSP) ---
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
            // Более строгие и точные правила
            "default-src 'self';", // Разрешает загрузку только с того же источника (localhost:3000)
             "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://api-maps.yandex.ru https://yandex.st https://yastatic.net https://core-renderer-tiles.maps.yandex.net;", // Скрипты: self, inline (нужно для некоторых библиотек, но менее безопасно), CDN, Yandex Maps
             "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://yastatic.net;", // Стили: self, inline, CDN, Yandex
             "font-src 'self' data: https://cdnjs.cloudflare.com;", // Шрифты: self, data URI (для Font Awesome), CDN
             "img-src 'self' data: blob: https://*.maps.yandex.net https://yandex.st https://favicon.yandex.net;", // Картинки: self, data URI, blob (для worker'ов), Yandex Maps
             "connect-src 'self' ws://localhost:* wss://localhost:* https://*.maps.yandex.net https://api-maps.yandex.ru https://yandex.ru redis://*;", // Соединения: self, WebSocket, Yandex Maps, Redis (если он используется напрямую из клиента, что маловероятно)
             "frame-src 'self' https://api-maps.yandex.ru;", // Фреймы: self, Yandex Maps API
             "worker-src 'self' blob:;", // Worker'ы: self, blob
             "object-src 'none';" // Запрещаем <object>, <embed>, <applet>
        ].join(' ')
      }
    })
  })

  // --- Загрузка URL приложения ---
  const appUrl = 'http://localhost:3000/';
  log.info(`Loading URL: ${appUrl}`);
  mainWindow.loadURL(appUrl);

  // Открываем DevTools только в режиме разработки
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // --- Обработчики событий окна ---
  mainWindow.on('closed', function () {
    log.info('Main window closed.');
    mainWindow = null; // Важно для сборщика мусора
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // Игнорируем ошибки загрузки не основного фрейма (например, API)
      if (isMainFrame && validatedURL === appUrl) {
         log.error(`Failed to load main frame URL: ${validatedURL}. Error: ${errorCode} (${errorDescription})`);
          // Показываем диалоговое окно пользователю
          if (!mainWindow.isDestroyed()) {
             dialog.showErrorBox('Ошибка загрузки', `Не удалось загрузить основную страницу приложения (${validatedURL}).\nКод ошибки: ${errorCode}\n\nУбедитесь, что внутренний сервер запущен и порт 3000 не занят. Проверьте логи.`);
          }
         // Можно попробовать перезагрузить через некоторое время или закрыть приложение
         // setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); }, 5000);
      } else if (isMainFrame) {
          log.error(`Failed to load main frame URL (unexpected): ${validatedURL}. Error: ${errorCode} (${errorDescription})`);
      } else {
         log.warn(`Failed to load resource: ${validatedURL}. Error: ${errorCode} (${errorDescription})`);
      }
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
     log.error(`Render process gone. Reason: ${details.reason}, Exit code: ${details.exitCode}`);
     // Показываем ошибку и предлагаем перезапустить
      if (!mainWindow.isDestroyed()) {
          dialog.showMessageBox(mainWindow, {
              title: 'Ошибка рендеринга',
              message: 'Произошла критическая ошибка в процессе отображения окна.',
              detail: `Причина: ${details.reason}. Код выхода: ${details.exitCode}`,
              type: 'error',
              buttons: ['Перезагрузить окно', 'Закрыть приложение']
          }).then(result => {
              if (result.response === 0) {
                  mainWindow.reload();
              } else {
                  app.quit();
              }
          });
      }
  });

  mainWindow.on('unresponsive', () => {
     log.warn('Main window is unresponsive.');
     // Предлагаем подождать или перезагрузить
      dialog.showMessageBox(mainWindow, {
          title: 'Окно не отвечает',
          message: 'Приложение перестало отвечать.',
          type: 'warning',
          buttons: ['Подождать', 'Перезагрузить окно']
      }).then(result => {
          if (result.response === 1) {
              mainWindow.reload();
          }
      });
  });
}

// === ОБРАБОТКА СОБЫТИЙ ПРИЛОЖЕНИЯ ===
app.whenReady().then(async () => { // <-- Делаем обработчик async
    log.info('Electron app is ready.');

    try {
        // Сначала ждем запуска сервера
        await initializeAndStartServer();
        log.info('Server started successfully, proceeding to create window.');

        // Теперь создаем окно
        createWindow();

        // Запускаем проверку обновлений ПОСЛЕ создания окна
        log.info('[AppReady] Scheduling update check...');
        // Запускаем немедленно и потом по таймеру, если нужно
        checkForUpdates();
        // setInterval(checkForUpdates, 60 * 60 * 1000); // Например, проверять каждый час

        app.on('activate', function () {
            log.info('App activated.');
            // Если нет окон, создаем новое (важно для macOS)
            if (BrowserWindow.getAllWindows().length === 0) {
                log.info('No windows open, creating a new one.');
                // Перед созданием окна на activate убедимся, что сервер еще жив (хотя если он упал, приложение бы вылетело)
                // Можно добавить проверку доступности localhost:3000, но пока упростим
                createWindow();
            }
        });

    } catch (serverError) {
        // Если сервер не запустился при старте приложения
        log.error('Express server failed to start during app ready. Shutting down Electron app.', serverError);
        dialog.showErrorBox('Критическая ошибка запуска', `Не удалось запустить внутренний веб-сервер: ${serverError.message}. Приложение будет закрыто.`);
        app.quit(); // Выход из приложения
    }
});

app.on('window-all-closed', function () {
  log.info('All windows closed.');
  // На macOS стандартное поведение - оставлять приложение активным
  if (process.platform !== 'darwin') {
    log.info('Quitting app (not macOS).');
    app.quit();
  }
});

app.on('quit', () => {
    log.info('Application quit event received.');
    // Здесь можно выполнить очистку перед выходом, если нужно
});

// --- ОБРАБОТЧИКИ СОБЫТИЙ AutoUpdater для IPC ---
function sendStatusToWindow(channel, data) {
  const dataString = typeof data === 'object' ? JSON.stringify(data).substring(0, 150) + '...' : String(data); // Преобразуем в строку
  log.info(`[IPC Send -> Renderer] Channel: ${channel}, Data: ${dataString || '<no data>'}`);
  if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send(channel, data); }
    catch (error) { log.error(`[IPC Send -> Renderer] ERROR Sending on ${channel}: ${error.message}`); }
  } else { log.warn(`[IPC Send -> Renderer] FAILED Sending on ${channel}. Reason: mainWindow not available or destroyed.`); }
}

autoUpdater.on('checking-for-update', () => {
  log.info('[AutoUpdater Event] === CHECKING ===');
  sendStatusToWindow('update-status', 'Проверка обновлений...');
});
autoUpdater.on('update-available', (info) => {
  log.info('[AutoUpdater Event] === AVAILABLE ===', info);
  sendStatusToWindow('update-available', info);
});
autoUpdater.on('update-not-available', (info) => {
  log.info('[AutoUpdater Event] === NOT AVAILABLE ===', info);
  sendStatusToWindow('update-status', 'Установлена последняя версия.');
  setTimeout(() => sendStatusToWindow('update-status', ''), 5000); // Убираем сообщение через 5 сек
});
autoUpdater.on('error', (err) => {
  log.error('[AutoUpdater Event] === ERROR ===', err);
  sendStatusToWindow('update-error', `Ошибка обновления: ${err.message || 'Неизвестная ошибка'}`);
});
autoUpdater.on('download-progress', (progressObj) => {
  let percent = progressObj.percent.toFixed(2);
  // Логируем реже, чтобы не засорять лог
  if (Math.round(progressObj.percent) % 10 === 0 || progressObj.percent > 98 || progressObj.percent < 2) {
      log.info(`[AutoUpdater Event] === PROGRESS === ${percent}% (${(progressObj.bytesPerSecond / 1024).toFixed(1)} KB/s)`);
  }
  sendStatusToWindow('update-progress', percent);
});
autoUpdater.on('update-downloaded', (info) => {
  log.info('[AutoUpdater Event] === DOWNLOADED ===', info);
  sendStatusToWindow('update-ready', info); // Отправляем сигнал готовности
});

// --- Слушатель IPC от окна для старта установки ---
ipcMain.on('install-update', (event) => {
  log.info('[IPC Receive <- Renderer] === INSTALL SIGNAL RECEIVED ===');
  if (!mainWindow || mainWindow.isDestroyed()) {
      log.error('[IPC Receive <- Renderer] Cannot quit and install, mainWindow is destroyed.');
      return;
  }
  try {
    log.info('[AutoUpdater] Calling quitAndInstall(isSilent=false, isForceRunAfter=true)');
    // isSilent=false - показывать процесс установки NSIS
    // isForceRunAfter=true - запустить приложение после установки
    autoUpdater.quitAndInstall(false, true);
  } catch (e) {
      log.error('[AutoUpdater] Error calling quitAndInstall:', e);
      sendStatusToWindow('update-error', `Ошибка запуска установки: ${e.message}`);
  }
});
// --------------------------------------------

// --- Создание preload.js (если его нет) ---
const preloadPath = path.join(__dirname, 'preload.js');
try {
  if (!fs.existsSync(preloadPath)) {
    fs.writeFileSync(preloadPath, `
// preload.js
const { contextBridge, ipcRenderer } = require('electron');
console.log("Preload script loaded");
contextBridge.exposeInMainWorld('electronUpdater', {
    send: (channel, data) => { let validChannels = ['install-update']; if (validChannels.includes(channel)) { ipcRenderer.send(channel, data); } else { console.error('Preload: Invalid send channel:', channel); } },
    on: (channel, func) => { let validChannels = ['update-status', 'update-available', 'update-progress', 'update-ready', 'update-error']; if (validChannels.includes(channel)) { const listener = (event, ...args) => func(...args); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); } else { console.error('Preload: Invalid receive channel:', channel); return () => {}; } },
    removeListener: (channel, listener) => { let validChannels = ['update-status', 'update-available', 'update-progress', 'update-ready', 'update-error']; if (validChannels.includes(channel) && typeof listener === 'function') { try { ipcRenderer.removeListener(channel, listener); } catch (error) { console.error('Preload: Error removing listener:', error); } } else { console.warn('Preload: Invalid remove listener args'); } }
});
    `);
    log.info("Создан файл preload.js");
  }
} catch(err) {
  log.error('Ошибка создания preload.js:', err);
}