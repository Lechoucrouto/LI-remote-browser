const socket = io();

const statusBadge = document.getElementById('status-badge');
const urlForm = document.getElementById('url-form');
const urlInput = document.getElementById('url-input');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const viewportContainer = document.getElementById('viewport-container');
const remoteScreen = document.getElementById('remote-screen');
const placeholderNotice = document.getElementById('placeholder-notice');

// Modal Elements
const externalModal = document.getElementById('external-modal');
const externalUrlText = document.getElementById('external-url-text');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalConfirmBtn = document.getElementById('modal-confirm-btn');

let pendingExternalUrl = null;

const SERVER_VIEWPORT_WIDTH = 1024;
const SERVER_VIEWPORT_HEIGHT = 640;

// Socket connection status UI
socket.on('connect', () => {
  statusBadge.textContent = 'Connected';
  statusBadge.className = 'status-indicator connected';
});

socket.on('disconnect', () => {
  statusBadge.textContent = 'Disconnected';
  statusBadge.className = 'status-indicator';
});

// Render incoming CDP screencast frames
socket.on('frame_update', ({ base64Image, url }) => {
  placeholderNotice.style.display = 'none';
  remoteScreen.style.display = 'block';
  remoteScreen.src = 'data:image/jpeg;base64,' + base64Image;

  if (document.activeElement !== urlInput) {
    urlInput.value = url;
  }
});

socket.on('url_changed', ({ url }) => {
  urlInput.value = url;
});

// External Domain Navigations Modal
socket.on('external_navigation', ({ url }) => {
  pendingExternalUrl = url;
  externalUrlText.textContent = url;
  externalModal.classList.remove('hidden');
});

modalCancelBtn.addEventListener('click', () => {
  pendingExternalUrl = null;
  externalModal.classList.add('hidden');
});

modalConfirmBtn.addEventListener('click', () => {
  if (pendingExternalUrl) {
    window.open(pendingExternalUrl, '_blank');
    pendingExternalUrl = null;
  }
  externalModal.classList.add('hidden');
});

// Submit target URL
urlForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const targetUrl = urlInput.value.trim();
  if (targetUrl) {
    statusBadge.textContent = 'Loading Page...';
    statusBadge.className = 'status-indicator loading';
    socket.emit('start_session', { targetUrl });
    viewportContainer.focus();
  }
});

// Fullscreen toggle logic
fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    viewportContainer.requestFullscreen().catch((err) => {
      console.error(`Error attempting to enable fullscreen: ${err.message}`);
    });
  } else {
    document.exitFullscreen();
  }
});

document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) {
    fullscreenBtn.textContent = 'Exit Fullscreen';
  } else {
    fullscreenBtn.textContent = '⛶ Fullscreen';
  }
});

// Mouse Click Event Forwarding
remoteScreen.addEventListener('click', (e) => {
  const rect = remoteScreen.getBoundingClientRect();
  
  const scaleX = SERVER_VIEWPORT_WIDTH / rect.width;
  const scaleY = SERVER_VIEWPORT_HEIGHT / rect.height;

  const clickX = Math.round((e.clientX - rect.left) * scaleX);
  const clickY = Math.round((e.clientY - rect.top) * scaleY);

  socket.emit('user_click', { x: clickX, y: clickY });
});

// Keypress Event Forwarding
viewportContainer.addEventListener('keydown', (e) => {
  if (document.activeElement === urlInput) return;

  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Backspace'].includes(e.code)) {
    e.preventDefault();
  }

  socket.emit('user_keydown', { key: e.key });
});

// Wheel Scroll Event Forwarding
remoteScreen.addEventListener('wheel', (e) => {
  e.preventDefault();
  socket.emit('user_scroll', { deltaY: e.deltaY });
}, { passive: false });