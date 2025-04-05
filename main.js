// main.js
const { app, BrowserWindow, dialog, ipcMain } = require('electron'); // Добавили dialog и ipcMain
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
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
            "default-src 'self';",
            " script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://api-maps.yandex.ru https://yandex.st https://yastatic.net https://core-renderer-tiles.maps.yandex.net;",
            " style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://yastatic.net;",
            " font-src 'self' data: https://cdnjs.cloudflare.com;",
            " img-src 'self' data: blob: https://*.maps.yandex.net https://yandex.st https://favicon.yandex.net;",
            " connect-src 'self' ws://localhost:* wss://localhost:* https://*.maps.yandex.net https://api-maps.yandex.ru https://yandex.ru redis://*;", // Добавил redis://* на всякий случай, если он нужен для connect-src
            " frame-src 'self' https://api-maps.yandex.ru;",
            " worker-src 'self' blob:;",
            " object-src 'none';"
        ].join(' ')
      }
    })
  })

  console.log('Loading URL: http://localhost:3000/');
  mainWindow.loadURL('http://localhost:3000/');

  // mainWindow.webContents.openDevTools();

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
  log.info(`[IPC Send] Channel: ${channel}, Data: ${JSON.stringify(data) || '<no data>'}`);
  if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
    try {
        mainWindow.webContents.send(channel, data);
    } catch (error) {
        log.error(`[IPC Send] Error sending to webContents: ${error.message}`);
    }
  } else {
    log.warn(`[IPC Send] Cannot send on channel ${channel}, mainWindow is not available or destroyed.`);
  }
}

autoUpdater.on('checking-for-update', () => {
  sendStatusToWindow('update-status', 'Проверка обновлений...');
});

autoUpdater.on('update-available', (info) => {
  log.info('[AutoUpdater Event] Update available.', info);
  sendStatusToWindow('update-available', info); // Отправляем инфо об обновлении
  sendStatusToWindow('update-status', `Найдена версия ${info.version}. Загрузка...`); // Обновляем статус
});

autoUpdater.on('update-not-available', (info) => {
  log.info('[AutoUpdater Event] Update not available.', info);
  sendStatusToWindow('update-status', 'Установлена последняя версия.');
  // Скрываем сообщение через 5 секунд
  setTimeout(() => sendStatusToWindow('update-status', ''), 5000);
});

autoUpdater.on('error', (err) => {
  log.error('[AutoUpdater Event] Error: ', err);
  sendStatusToWindow('update-error', `Ошибка обновления: ${err.message || 'Неизвестная ошибка'}`);
});

autoUpdater.on('download-progress', (progressObj) => {
  let percent = progressObj.percent.toFixed(2);
  log.info(`[AutoUpdater Event] Download progress: ${percent}%`);
  sendStatusToWindow('update-progress', percent); // Отправляем процент
  sendStatusToWindow('update-status', `Загрузка: ${percent}%`); // Обновляем и статус
});

autoUpdater.on('update-downloaded', (info) => {
  log.info('[AutoUpdater Event] Update downloaded.', info);
  // Отправляем сигнал, что обновление готово
  sendStatusToWindow('update-ready', info);
  // Обновляем статус в последний раз
  sendStatusToWindow('update-status', `Версия ${info.version} загружена. Готово к установке.`);
});

// --- Слушатель IPC от окна для старта установки ---
ipcMain.on('install-update', (event) => {
  log.info('[IPC Receive] Received "install-update" signal from renderer.');
  try {
    // Выходим и ЗАПУСКАЕМ установщик (НЕ в тихом режиме)
    // Второй параметр `isForceRunAfter` = true, чтобы приложение запустилось после установки
    log.info('[AutoUpdater] Calling quitAndInstall(isSilent=false, isForceRunAfter=true)');
    autoUpdater.quitAndInstall(false, true);
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

contextBridge.exposeInMainWorld(
  'electronUpdater',
  {
    send: (channel, data) => {
      let validChannels = ['install-update'];
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, data);
      } else {
         console.error('Preload: Invalid send channel:', channel);
      }
    },
    on: (channel, func) => {
      let validChannels = ['update-status', 'update-available', 'update-progress', 'update-ready', 'update-error'];
      if (validChannels.includes(channel)) {
        const listener = (event, ...args) => func(...args);
        ipcRenderer.on(channel, listener);
        // Возвращаем функцию для отписки (если понадобится)
        return () => ipcRenderer.removeListener(channel, listener);
      } else {
         console.error('Preload: Invalid receive channel:', channel);
         return () => {}; // Возвращаем пустую функцию отписки
      }
    }
    // Можно явно добавить removeListener, если нужно больше контроля
    // removeListener: (channel, listener) => {
    //    let validChannels = ['update-status', 'update-available', 'update-progress', 'update-ready', 'update-error'];
    //    if (validChannels.includes(channel) && typeof listener === 'function') {
    //      ipcRenderer.removeListener(channel, listener);
    //    }
    // }
  }
);
    `);
    console.log("Создан файл preload.js");
  }
} catch(err) {
  console.error('Ошибка создания preload.js:', err);
}