
const express = require("express");
const { chromium } = require("playwright");
const WebSocket = require("ws");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false
});

app.use(express.static("public"));

const PORT = 3000;
const MAX_SESSIONS = 8;
const WIDTH = 960;
const HEIGHT = 540;
const FRAME_INTERVAL = 150;

let browser;
const sessions = new Set();

wss.on("connection", async (ws) => {
  if (sessions.size >= MAX_SESSIONS) {
    ws.send(JSON.stringify({
      type: "error",
      message: "Servern är full. Försök igen senare."
    }));
    ws.close();
    return;
  }

  sessions.add(ws);

  let context;
  let page;
  let frameTimer;
  let capturing = false;
  let closed = false;

  async function cleanup() {
    if (closed) return;
    closed = true;

    clearInterval(frameTimer);
    sessions.delete(ws);

    try {
      if (context) await context.close();
    } catch {}

    console.log("Session stängd. Aktiva:", sessions.size);
  }

  try {
    context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1
    });

    page = await context.newPage();

 try {
  await page.goto("https://poki.com", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
} catch (err) {
  console.error("Poki laddningsfel:", err.message);
}

if (closed || ws.readyState !== WebSocket.OPEN) {
  await cleanup();
  return;
}
    ws.send(JSON.stringify({
      type: "ready",
      width: WIDTH,
      height: HEIGHT
    }));

    console.log("Ny session. Aktiva:", sessions.size);

    frameTimer = setInterval(async () => {
      if (
        closed ||
        capturing ||
        ws.readyState !== WebSocket.OPEN ||
        page.isClosed() ||
        ws.bufferedAmount > 1_000_000
      ) return;

      capturing = true;

      try {
        const frame = await page.screenshot({
          type: "jpeg",
          quality: 40,
          scale: "css",
          animations: "disabled"
        });

        if (!closed && ws.readyState === WebSocket.OPEN) {
          ws.send(frame, { binary: true });
        }
      } catch (err) {
        console.error("Bildfel:", err.message);
      } finally {
        capturing = false;
      }
    }, FRAME_INTERVAL);

    ws.on("message", async (data, isBinary) => {
      if (isBinary || closed || !page || page.isClosed()) return;

      try {
        const m = JSON.parse(data.toString());

        if (m.type === "navigate") {
          let url = m.url.trim();
          if (!/^https?:\/\//i.test(url)) {
            url = "https://" + url;
          }

          const parsed = new URL(url);
          if (!["http:", "https:"].includes(parsed.protocol)) return;

          await page.goto(parsed.href, {
            waitUntil: "domcontentloaded",
            timeout: 60000
          });
        }

        if (m.type === "mouse") {
          const x = Math.max(0, Math.min(WIDTH, m.x));
          const y = Math.max(0, Math.min(HEIGHT, m.y));

          if (m.move) await page.mouse.move(x, y);
          if (m.down) await page.mouse.down();
          if (m.up) await page.mouse.up();

          if (m.wheel) {
            await page.mouse.wheel(m.wheelX || 0, m.wheelY || 0);
          }
        }

        if (m.type === "key") {
          if (m.down) await page.keyboard.down(m.key);
          if (m.up) await page.keyboard.up(m.key);
        }
      } catch (err) {
        console.error("Inputfel:", err.message);
      }
    });

    ws.on("close", cleanup);
    ws.on("error", cleanup);
  } catch (err) {
    console.error("Sessionsfel:", err.message);
    await cleanup();
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
});

async function start() {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding"
    ]
  });
server.listen(process.env.PORT || 3000, "0.0.0.0", () => {
    console.log(`LiteBrowser server körs på port ${process.env.PORT || 3000}`);
    console.log(`Max samtidiga sessioner: ${MAX_SESSIONS}`);
  });
}

start().catch(console.error);
