const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Helper to extract root domain/host for comparison
function getHostname(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname;
  } catch (e) {
    return null;
  }
}

function getBaseDomain(hostname) {
  if (!hostname) return '';
  const parts = hostname.split('.');
  if (parts.length > 2) {
    return parts.slice(-2).join('.');
  }
  return hostname;
}

function isSameDomain(url1, url2) {
  const host1 = getHostname(url1);
  const host2 = getHostname(url2);
  if (!host1 || !host2) return false;
  return getBaseDomain(host1) === getBaseDomain(host2);
}

// Active user sessions map
const sessions = new Map();

io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  let session = {
    browser: null,
    page: null,
    intervalId: null,
    initialUrl: null,
    initialDomain: null,
    isCapturing: false
  };

  sessions.set(socket.id, session);

  // Helper to send frame update
  const sendFrame = async () => {
    if (!session.page || session.page.isClosed() || session.isCapturing) return;
    session.isCapturing = true;

    try {
      const screenshotBuffer = await session.page.screenshot({
        type: 'jpeg',
        quality: 60,
        optimizeForSpeed: true
      });
      const currentUrl = session.page.url();
      socket.emit('frame_update', {
        image: screenshotBuffer.toString('base64'),
        url: currentUrl
      });
    } catch (err) {
      console.error(`[Error] Frame capture failed: ${err.message}`);
    } finally {
      session.isCapturing = false;
    }
  };

  // Start navigation session
  socket.on('start_session', async ({ targetUrl }) => {
    try {
      // Ensure scheme exists
      let formattedUrl = targetUrl;
      if (!/^https?:\/\//i.test(formattedUrl)) {
        formattedUrl = 'https://' + formattedUrl;
      }

      session.initialUrl = formattedUrl;
      session.initialDomain = getHostname(formattedUrl);

      // Close existing browser if re-navigating
      if (session.browser) {
        clearInterval(session.intervalId);
        await session.browser.close();
      }

      // Launch headless Chrome
      session.browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu'
        ]
      });

      session.page = await session.browser.newPage();
      await session.page.setViewport({ width: 1280, height: 800 });

      // Handle popup tabs (target="_blank" or window.open)
      session.browser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
          const newPage = await target.page();
          if (newPage && newPage !== session.page) {
            const newUrl = newPage.url() || target.url();
            await newPage.close();
            if (newUrl && newUrl !== 'about:blank') {
              if (!isSameDomain(newUrl, session.initialUrl)) {
                socket.emit('external_navigation', { url: newUrl });
              }
            }
          }
        }
      });

      // Handle in-page frame navigations
      session.page.on('framenavigated', async (frame) => {
        if (frame === session.page.mainFrame()) {
          const newUrl = frame.url();
          if (!newUrl || newUrl === 'about:blank') return;

          // Check if navigated to different website entirely
          if (!isSameDomain(newUrl, session.initialUrl)) {
            socket.emit('external_navigation', { url: newUrl });
            // Revert browser back to allowed session URL
            try {
              await session.page.goBack();
            } catch (e) {}
          } else {
            socket.emit('url_changed', { url: newUrl });
          }
        }
      });

      // Navigate to site
      await session.page.goto(formattedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // Start 1-second background refresh loop
      if (session.intervalId) clearInterval(session.intervalId);
      session.intervalId = setInterval(sendFrame, 1000);

      // Initial immediate frame capture
      await sendFrame();

    } catch (err) {
      console.error(`[Session Error] ${err.message}`);
      socket.emit('session_error', { message: err.message });
    }
  });

  // Forward user mouse click event
  socket.on('user_click', async ({ x, y }) => {
    if (session.page && !session.page.isClosed()) {
      try {
        await session.page.mouse.click(x, y);
        // Instant snapshot after click action
        setTimeout(sendFrame, 150);
      } catch (err) {
        console.error(`[Click Error] ${err.message}`);
      }
    }
  });

  // Forward user keyboard events
  socket.on('user_keydown', async ({ key }) => {
    if (session.page && !session.page.isClosed()) {
      try {
        await session.page.keyboard.press(key);
        // Instant snapshot after keypress
        setTimeout(sendFrame, 100);
      } catch (err) {
        console.error(`[Key Error] ${err.message}`);
      }
    }
  });

  // Forward mouse scroll
  socket.on('user_scroll', async ({ deltaY }) => {
    if (session.page && !session.page.isClosed()) {
      try {
        await session.page.mouse.wheel({ deltaY });
        setTimeout(sendFrame, 150);
      } catch (err) {
        console.error(`[Scroll Error] ${err.message}`);
      }
    }
  });

  // Clean up resources on client disconnect
  socket.on('disconnect', async () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
    if (session.intervalId) clearInterval(session.intervalId);
    if (session.browser) {
      try {
        await session.browser.close();
      } catch (err) {}
    }
    sessions.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});