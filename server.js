const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const path = require('path');
const { spawn } = require('child_process');

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
    ffmpeg: null,
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

    if (session.ffmpeg) {
      try {
        session.ffmpeg.stdin.end();
        session.ffmpeg.kill('SIGKILL');
      } catch (e) {}
      session.ffmpeg = null;
    }

    if (session.browser) {
      try {
        await session.browser.close();
      } catch (e) {}
      session.browser = null;
    }
  };

  // Start navigation and video streaming session
  socket.on('start_session', async ({ targetUrl }) => {
    try {
      let formattedUrl = targetUrl;
      if (!/^https?:\/\//i.test(formattedUrl)) {
        formattedUrl = 'https://' + formattedUrl;
      }

      session.initialUrl = formattedUrl;
      session.initialDomain = getHostname(formattedUrl);

      await cleanupSession();

      // Launch headless browser
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

      // Spawn FFmpeg to convert incoming frames into VP8 WebM live video stream
      session.ffmpeg = spawn('ffmpeg', [
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-r', '20',
        '-i', '-',
        '-f', 'webm',
        '-vcodec', 'vp8',
        '-b:v', '1M',
        '-g', '10',
        '-deadline', 'realtime',
        '-cpu-used', '8',
        '-an',
        '-'
      ]);

      session.ffmpeg.stdout.on('data', (chunk) => {
        socket.emit('video_chunk', chunk);
      });

      // Attach CDP session for direct screen output capture
      session.cdpSession = await session.page.target().createCDPSession();
      await session.cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 45,
        everyNthFrame: 1
      });

      session.cdpSession.on('Page.screencastFrame', async (frame) => {
        try {
          if (session.ffmpeg && !session.ffmpeg.killed && session.ffmpeg.stdin.writable) {
            const buffer = Buffer.from(frame.data, 'base64');
            session.ffmpeg.stdin.write(buffer);
          }
          await session.cdpSession.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
        } catch (err) {}
      });

      socket.emit('stream_started');

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