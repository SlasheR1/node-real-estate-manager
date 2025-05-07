// main.js
// main.js
const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater'); // Импорт electron-updater

// Настройка логов
const logDirectory = 'C:\\logs';
const logFilePath = path.join(logDirectory, `real-estate-manager-main.log`);
try {
    if (!fs.existsSync(logDirectory)) { fs.mkdirSync(logDirectory, { recursive: true }); }
    log.transports.file.resolvePath = () => logFilePath;
    console.log(`[Logger] Log file path set to: ${logFilePath}`);
    log.info(`[Logger] Application starting... Log path: ${logFilePath}`);
} catch (err) {
    console.error(`[Logger] CRITICAL ERROR: Failed to set up log directory "${logDirectory}". Logging to default path.`, err);
    log.error(`[Logger] Failed to set up custom log path. Using default. Error: ${err.message}`);
}
log.transports.file.level = 'info';
log.transports.console.level = 'info';
Object.assign(console, log.functions);
log.catchErrors({ showDialog: process.env.NODE_ENV !== 'development' });

let mainWindow;
let expressApp;

// --- НАСТРОЙКА AutoUpdater ---
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info'; // Логи апдейтера тоже пишем в файл
autoUpdater.autoDownload = true; // Скачиваем обновление автоматически в фоне
autoUpdater.autoInstallOnAppQuit = false; // НЕ устанавливаем автоматически при выходе
// -----------------------------

// --- Функция проверки обновлений (ИЗМЕНЕНА) ---
function checkForUpdates() {
  if (process.env.NODE_ENV === 'development') {
    log.info('[AutoUpdater] Development mode detected, skipping update check.');
    return;
  }
  log.info('[AutoUpdater] Initializing update check...');
  try {
    // Просто проверяем наличие, не скачиваем и не уведомляем системно
    // Скачивание начнется само, если найдет, т.к. autoDownload = true
    autoUpdater.checkForUpdates().catch(err => {
        log.error('[AutoUpdater] Error in checkForUpdates():', err.message || err);
    });
  } catch (error) {
      log.error('[AutoUpdater] Failed to initiate checkForUpdates:', error);
  }
}
// ----------------------------------

function initializeExpress() {
  try {
      expressApp = require('./server.js');
      console.log('Express app initialized and server started from main.js');
  } catch(err) {
      console.error('Failed to initialize Express app:', err);
      expressApp = null; // Установим в null при ошибке
      // app.quit(); // Пока не выходим, может быть полезно видеть ошибку
  }
}

function createWindow () {
  console.log('Creating main browser window...');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      // Указываем preload.js
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  // Обработчик заголовков CSP
    // Обработчик заголовков CSP
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          // Убедитесь, что используется именно 'Content-Security-Policy', а не 'content-security-policy'
          'Content-Security-Policy': [
              "default-src 'self';",
              // Добавляем 'unsafe-eval' временно для диагностики карты, если ошибка ReferenceError сохранится
              // В продакшене лучше избегать 'unsafe-eval'
              "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://api-maps.yandex.ru https://yandex.st https://yastatic.net https://core-renderer-tiles.maps.yandex.net;", // 'unsafe-eval' может понадобиться API
              "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://yastatic.net;",
              "font-src 'self' data: https://cdnjs.cloudflare.com;",
              // *** ИЗМЕНЕНИЕ ЗДЕСЬ: Добавлен https://api-maps.yandex.ru ***
              "img-src 'self' data: blob: https://*.maps.yandex.net https://yandex.st https://favicon.yandex.net https://api-maps.yandex.ru;",
              // *** КОНЕЦ ИЗМЕНЕНИЯ ***
              "connect-src 'self' ws://localhost:* wss://localhost:* https://*.maps.yandex.net https://api-maps.yandex.ru https://yandex.ru redis://*;",
              "frame-src 'self' https://api-maps.yandex.ru;",
              "worker-src 'self' blob:;",
              "object-src 'none';"
          ].join(' ') // Убедитесь, что здесь пробел, а не точка с запятой
        }
      })
    })

  console.log('Loading URL: http://localhost:3000/');
  mainWindow.loadURL('http://localhost:3000/');

  //mainWindow.webContents.openDevTools();

  mainWindow.on('closed', function () {
    console.log('Main window closed.');
    mainWindow = null;
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error(`Failed to load URL: ${validatedURL}. Error: ${errorCode}, ${errorDescription}`);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
     console.error(`Render process gone. Reason: ${details.reason}, Exit code: ${details.exitCode}`);
  });

  mainWindow.on('unresponsive', () => {
     console.warn('Main window is unresponsive.');
  });
}

// === Обработка событий приложения ===
app.whenReady().then(() => {
  log.info('Electron app is ready.');
  initializeExpress();

  if (!expressApp) {
    log.error('Express app did not initialize correctly. Shutting down Electron app.');
    dialog.showErrorBox('Критическая ошибка', 'Не удалось запустить внутренний веб-сервер. Приложение будет закрыто.');
    app.quit();
    return;
  }
  Menu.setApplicationMenu(null);

  createWindow();

  // Запуск проверки обновлений после создания окна
  log.info('[AppReady] Scheduling update check...');
  setTimeout(checkForUpdates, 5000); // Проверяем через 5 секунд

  app.on('activate', function () {
    log.info('App activated.');
    if (BrowserWindow.getAllWindows().length === 0) {
        log.info('No windows open, creating a new one.');
        createWindow();
    }
  });
});

app.on('window-all-closed', function () {
  log.info('All windows closed.');
  if (process.platform !== 'darwin') {
    log.info('Quitting app (not macOS).');
    app.quit();
  }
});

app.on('quit', () => {
    log.info('Application quit event received.');
});

// --- ОБРАБОТЧИКИ СОБЫТИЙ AutoUpdater для IPC ---

// Функция для безопасной отправки сообщений в окно
function sendStatusToWindow(channel, data) {
  const dataString = typeof data === 'object' ? JSON.stringify(data).substring(0, 150) + '...' : data;
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
  // Убрали дублирующий статус отсюда
});

autoUpdater.on('update-not-available', (info) => {
  log.info('[AutoUpdater Event] === NOT AVAILABLE ===', info);
  sendStatusToWindow('update-status', 'Установлена последняя версия.');
  setTimeout(() => sendStatusToWindow('update-status', ''), 5000);
});

autoUpdater.on('error', (err) => {
  log.error('[AutoUpdater Event] === ERROR ===', err);
  sendStatusToWindow('update-error', `Ошибка обновления: ${err.message || 'Неизвестная ошибка'}`);
});

autoUpdater.on('download-progress', (progressObj) => {
  let percent = progressObj.percent.toFixed(2);
  if (Math.round(progressObj.percent) % 10 === 0 || progressObj.percent > 98) { log.info(`[AutoUpdater Event] === PROGRESS === ${percent}%`); }
  sendStatusToWindow('update-progress', percent);
  // Убрали дублирующий статус отсюда
});

autoUpdater.on('update-downloaded', (info) => {
  log.info('[AutoUpdater Event] === DOWNLOADED ===', info);
  // Отправляем ТОЛЬКО сигнал готовности. Статус больше не нужен.
  sendStatusToWindow('update-ready', info);
  // --- УБРАНА СТРОКА: sendStatusToWindow('update-status', ...) ---
});

// --- Слушатель IPC от окна для старта установки ---
ipcMain.on('install-update', (event) => {
  log.info('[IPC Receive <- Renderer] === INSTALL SIGNAL RECEIVED ===');
  if (!mainWindow || mainWindow.isDestroyed()) { log.error('[IPC Receive <- Renderer] Cannot quit and install, mainWindow is destroyed.'); return; }
  try {
    log.info('[AutoUpdater] Calling quitAndInstall(isSilent=false, isForceRunAfter=true)');
    autoUpdater.quitAndInstall(false, true); // Установка НЕ тихая
  } catch (e) {
      log.error('[AutoUpdater] Error calling quitAndInstall:', e);
      sendStatusToWindow('update-error', `Ошибка запуска установки: ${e.message}`);
  }
});
// --------------------------------------------

// Создание preload.js (если его нет)
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
    console.log("Создан файл preload.js");
  }
} catch(err) {
  console.error('Ошибка создания preload.js:', err);
}