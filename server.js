const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

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
    cdpSession: null,
    initialUrl: null,
    initialDomain: null
  };

  sessions.set(socket.id, session);

  const cleanupSession = async () => {
    if (session.cdpSession) {
      try {
        await session.cdpSession.send('Page.stopScreencast');
      } catch (e) {}
      session.cdpSession = null;
    }

    if (session.browser) {
      try {
        await session.browser.close();
      } catch (e) {}
      session.browser = null;
    }
  };

  socket.on('start_session', async ({ targetUrl }) => {
    try {
      let formattedUrl = targetUrl;
      if (!/^https?:\/\//i.test(formattedUrl)) {
        formattedUrl = 'https://' + formattedUrl;
      }

      session.initialUrl = formattedUrl;
      session.initialDomain = getHostname(formattedUrl);

      await cleanupSession();

      session.browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-extensions-with-background-pages',
          '--disable-extensions',
          '--disable-ipc-flooding-protection',
          '--disable-renderer-backgrounding',
          '--force-color-profile=srgb',
          '--mute-audio',
          '--no-first-run'
        ]
      });

      session.page = await session.browser.newPage();
      await session.page.setViewport({ width: 1024, height: 640 });

      // Handle popups
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

      // Handle domain navigation
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

      // Attach CDP screencast session for low-latency hardware stream
      session.cdpSession = await session.page.target().createCDPSession();
      await session.cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 55,
        maxWidth: 1024,
        maxHeight: 640,
        everyNthFrame: 1
      });

      session.cdpSession.on('Page.screencastFrame', async (frame) => {
        try {
          socket.emit('frame_update', {
            base64Image: frame.data,
            url: session.page.url()
          });

          // Acknowledge frame to receive the next frame immediately
          await session.cdpSession.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
        } catch (err) {}
      });

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
    await cleanupSession();
    sessions.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});