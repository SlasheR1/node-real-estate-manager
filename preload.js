// preload.js
const { contextBridge, ipcRenderer } = require('electron');

console.log("Preload script loaded");

// Безопасно предоставляем только нужные методы ipcRenderer процессу рендеринга
contextBridge.exposeInMainWorld(
  'electronUpdater', // Название объекта, который будет доступен в window (window.electronUpdater)
  {
    // Функция для отправки сообщения из рендера в main (например, 'install-update')
    send: (channel, data) => {
      let validChannels = ['install-update', 'quit-app']; // Список разрешенных каналов для отправки
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, data);
      } else {
        console.error(`Preload: Invalid send channel detected: ${channel}`);
      }
    },
    // Функция для получения сообщений из main в рендер
    on: (channel, func) => {
      let validChannels = [
        'update-status',
        'update-available',
        'update-progress',
        'update-ready',
        'update-error'
      ]; // Список разрешенных каналов для получения
      if (validChannels.includes(channel)) {
        // Осторожно предоставляем ipcRenderer, создавая нового слушателя каждый раз
        const listener = (event, ...args) => func(...args);
        ipcRenderer.on(channel, listener);
        // Возвращаем функцию, которая позволит удалить именно этого слушателя
        return () => ipcRenderer.removeListener(channel, listener);
      } else {
        console.error(`Preload: Invalid receive channel detected: ${channel}`);
        return () => {}; // Возвращаем пустую функцию для согласованности
      }
    },
    // Явно добавим функцию для удаления слушателя, если она будет нужна в header.ejs
    removeListener: (channel, listener) => {
      let validChannels = ['update-status', 'update-available', 'update-progress', 'update-ready', 'update-error'];
      if (validChannels.includes(channel) && typeof listener === 'function') {
          try {
              ipcRenderer.removeListener(channel, listener);
          } catch (error) {
              console.error(`Preload: Error removing listener for channel ${channel}:`, error);
          }
      } else {
           console.warn(`Preload: Attempted to remove listener for invalid channel or non-function listener: ${channel}`);
      }
   }
  }
);