const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Minimum delay between frame captures (50ms = up to 20 FPS)
const MIN_FRAME_INTERVAL_MS = 50;

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

const sessions = new Map();

io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  let session = {
    browser: null,
    page: null,
    loopTimeoutId: null,
    initialUrl: null,
    initialDomain: null,
    isCapturing: false,
    isActive: true
  };

  sessions.set(socket.id, session);

  // Helper to send frame update
  const sendFrame = async () => {
    if (!session.page || session.page.isClosed() || session.isCapturing) return;
    session.isCapturing = true;

    try {
      const screenshotBuffer = await session.page.screenshot({
        type: 'jpeg',
        quality: 50, // Slightly reduced quality for faster encoding/transmission
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

  // High-frequency frame loop with minimum 50ms floor
  const startFrameLoop = async () => {
    if (!session.isActive || !session.page || session.page.isClosed()) return;

    const startTime = Date.now();
    await sendFrame();
    const elapsedTime = Date.now() - startTime;

    // Calculate delay needed to honor the 50ms threshold
    const waitTime = Math.max(0, MIN_FRAME_INTERVAL_MS - elapsedTime);

    if (session.isActive) {
      session.loopTimeoutId = setTimeout(startFrameLoop, waitTime);
    }
  };

  // Start navigation session
  socket.on('start_session', async ({ targetUrl }) => {
    try {
      let formattedUrl = targetUrl;
      if (!/^https?:\/\//i.test(formattedUrl)) {
        formattedUrl = 'https://' + formattedUrl;
      }

      session.initialUrl = formattedUrl;
      session.initialDomain = getHostname(formattedUrl);

      // Stop existing loop and close browser if re-navigating
      if (session.loopTimeoutId) clearTimeout(session.loopTimeoutId);
      if (session.browser) {
        await session.browser.close();
      }

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

      // Handle popup tabs
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

          if (!isSameDomain(newUrl, session.initialUrl)) {
            socket.emit('external_navigation', { url: newUrl });
            try {
              await session.page.goBack();
            } catch (e) {}
          } else {
            socket.emit('url_changed', { url: newUrl });
          }
        }
      });

      await session.page.goto(formattedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // Kick off continuous capture loop
      startFrameLoop();

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
      } catch (err) {
        console.error(`[Scroll Error] ${err.message}`);
      }
    }
  });

  // Clean up resources on disconnect
  socket.on('disconnect', async () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
    session.isActive = false;
    if (session.loopTimeoutId) clearTimeout(session.loopTimeoutId);
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