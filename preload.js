const { contextBridge, ipcRenderer } = require('electron');

const validSendChannels = [
  'set-pet-image', 'set-animation', 'set-size', 'set-speed',
  'set-bg-color', 'set-mood', 'toggle-clickthrough', 'set-position-lock', 'set-ground-shadow', 'set-autostart',
  'open-settings', 'move-pet', 'pet-context-menu', 'reset-position',
  'hide-pet', 'show-pet', 'minimize-pet', 'quit',
  'begin-drag', 'end-drag', 'set-mouse-over-pet', 'set-position', 'rope-style',
  'set-rope-length', 'set-physics'
];

const validReceiveChannels = [
  'pet-image', 'animation', 'size', 'speed',
  'bg-color', 'mood', 'interaction', 'clickthrough', 'window-motion',
  'rope-style', 'rope-length', 'physics', 'visibility', 'position-lock', 'ground-shadow', 'autostart'
];

const validInvokeChannels = [
  'get-path', 'get-supported-formats', 'read-image-as-dataurl', 'get-clickthrough', 'get-position-lock', 'get-ground-shadow', 'get-autostart', 'get-physics'
];

contextBridge.exposeInMainWorld('api', {
  send: (channel, data) => {
    if (validSendChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  on: (channel, fn) => {
    if (validReceiveChannels.includes(channel)) {
      ipcRenderer.on(channel, (_, data) => fn(data));
    }
  },
  invoke: async (channel, ...args) => {
    if (validInvokeChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
  },
  once: (channel, fn) => {
    if (validReceiveChannels.includes(channel)) {
      ipcRenderer.once(channel, (_, data) => fn(data));
    }
  }
});
