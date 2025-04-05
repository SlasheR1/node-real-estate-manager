// main.js
// --- ДОБАВЛЯЕМ dialog и ИМПОРТИРУЕМ autoUpdater ---
const { app, BrowserWindow, dialog } = require('electron'); // Добавили dialog
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater'); // Импорт electron-updater
// -----------------------------------------------

// Настройка логов (без изменений)
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

// --- НАСТРОЙКА ЛОГОВ ДЛЯ AutoUpdater ---
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info'; // Логи апдейтера тоже пишем в файл
// --------------------------------------

// --- ФУНКЦИЯ ПРОВЕРКИ ОБНОВЛЕНИЙ ---
function checkForUpdates() {
  // Не проверяем в режиме разработки, чтобы не мешать отладке
  if (process.env.NODE_ENV === 'development') {
    log.info('[AutoUpdater] Development mode detected, skipping update check.');
    return;
  }

  log.info('[AutoUpdater] Initializing update check...');
  try {
    // Самый простой метод: проверить, скачать и уведомить пользователя
    // Он сам покажет стандартное уведомление/диалог после загрузки
    autoUpdater.checkForUpdatesAndNotify().then(result => {
      // result может быть null, если обновлений нет, или содержать информацию о версии
      if (result && result.updateInfo) {
        log.info(`[AutoUpdater] Check finished. Update available: ${result.updateInfo.version}`);
      } else {
        log.info('[AutoUpdater] Check finished. No update available or already up-to-date.');
      }
    }).catch(err => {
      // Ошибки сети, доступа и т.д.
      log.error('[AutoUpdater] Error during checkForUpdatesAndNotify:', err.message || err);
    });
  } catch (error) {
      log.error('[AutoUpdater] Failed to initiate update check:', error);
  }
}
// ----------------------------------

function initializeExpress() {
  try {
      expressApp = require('./server.js');
      console.log('Express app initialized and server started from main.js');
  } catch(err) {
      console.error('Failed to initialize Express app:', err);
      app.quit(); // Выходим, если сервер не стартовал
  }
}

function createWindow () {
  console.log('Creating main browser window...');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  // Обработчик заголовков CSP (без изменений)
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({ /* ... твой CSP ... */ });
  });

  console.log('Loading URL: http://localhost:3000/');
  mainWindow.loadURL('http://localhost:3000/');

  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', function () { /* ... */ });
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => { /* ... */ });
  mainWindow.webContents.on('render-process-gone', (event, details) => { /* ... */ });
  mainWindow.on('unresponsive', () => { /* ... */ });
}

// === Обработка событий приложения ===
app.whenReady().then(() => {
  log.info('Electron app is ready.'); // Лог
  initializeExpress(); // Сначала инициализируем сервер

  // --- ДОБАВЛЕНА ПРОВЕРКА ---
  if (!expressApp) {
    log.error('Express app did not initialize correctly. Shutting down Electron app.');
    app.quit();
    return; // Прерываем дальнейшее выполнение
  }
  // --- КОНЕЦ ПРОВЕРКИ ---

  createWindow(); // Создаем окно ПОСЛЕ успешного старта сервера

  // --- ЗАПУСК ПРОВЕРКИ ОБНОВЛЕНИЙ ---
  // Вызываем после создания окна, с небольшой задержкой
  log.info('[AppReady] Scheduling update check...');
  setTimeout(checkForUpdates, 5000); // Проверяем через 5 секунд
  // ---------------------------------

  app.on('activate', function () { /* ... твой код ... */ });
});

app.on('window-all-closed', function () { /* ... твой код ... */ });
app.on('quit', () => { /* ... твой код ... */ });

// --- ОБРАБОТЧИКИ СОБЫТИЙ AutoUpdater (для логов и отладки) ---

autoUpdater.on('checking-for-update', () => {
  log.info('[AutoUpdater Event] Checking for update...');
});

autoUpdater.on('update-available', (info) => {
  // Это событие срабатывает ДО начала скачивания
  log.info('[AutoUpdater Event] Update available.', info);
  // Если хочешь ручное управление, можно здесь спросить пользователя
  // Например: mainWindow.webContents.send('update_available', info);
});

autoUpdater.on('update-not-available', (info) => {
  log.info('[AutoUpdater Event] Update not available.', info);
});

autoUpdater.on('error', (err) => {
  // Эта ошибка может быть связана с сетью, доступом к файлам и т.д.
  log.error('[AutoUpdater Event] Error in auto-updater. ' + err);
  // Можно показать диалог пользователю, но checkForUpdatesAndNotify
  // может уже показать свое стандартное сообщение об ошибке.
  // dialog.showErrorBox('Ошибка обновления', `Произошла ошибка: ${err.message}`);
});

autoUpdater.on('download-progress', (progressObj) => {
  // Логируем прогресс скачивания
  let log_message = `Downloaded ${progressObj.percent.toFixed(2)}%`;
  log_message += ` (${(progressObj.transferred / 1024 / 1024).toFixed(2)} MB / ${(progressObj.total / 1024 / 1024).toFixed(2)} MB)`;
  log_message += ` at ${(progressObj.bytesPerSecond / 1024).toFixed(2)} KB/s`;
  log.info(`[AutoUpdater Event] Download progress: ${log_message}`);

  // Можно отправлять прогресс в окно рендерера для отображения ProgressBar
  // if (mainWindow) {
  //   mainWindow.webContents.send('update-download-progress', progressObj.percent);
  // }
});

autoUpdater.on('update-downloaded', (info) => {
  // Скачивание завершено!
  log.info('[AutoUpdater Event] Update downloaded.', info);
  // Метод checkForUpdatesAndNotify() автоматически покажет диалог
  // с предложением перезапустить приложение.

  // Если бы ты использовал autoUpdater.checkForUpdates() и autoUpdater.downloadUpdate(),
  // то ЗДЕСЬ нужно было бы показать свой диалог:
  /*
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Обновление готово',
    message: `Версия ${info.version} загружена. Перезапустить приложение сейчас для установки?`,
    buttons: ['Перезапустить', 'Позже'],
    defaultId: 0, // Кнопка "Перезапустить" по умолчанию
    cancelId: 1   // Кнопка "Позже" для отмены
  }).then(({ response }) => {
    if (response === 0) {
      log.info('[AutoUpdater] User confirmed update install. Quitting and installing...');
      setImmediate(() => autoUpdater.quitAndInstall()); // Используем setImmediate для надежности
    } else {
      log.info('[AutoUpdater] User deferred the update installation.');
    }
  });
  */
});

// --- КОНЕЦ ОБРАБОТЧИКОВ AutoUpdater ---


// Создание preload.js (без изменений)
const preloadPath = path.join(__dirname, 'preload.js');
try {
  if (!fs.existsSync(preloadPath)) { /* ... */ }
} catch(err) { /* ... */ }