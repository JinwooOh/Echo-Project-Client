const statusText = document.getElementById("statusText");
const emojiText = document.getElementById("emojiText");
const textContent = document.getElementById("textContent");
const batteryFill = document.getElementById("batteryFill");
const batteryText = document.getElementById("batteryText");
const led = document.getElementById("led");
const ledText = document.getElementById("ledText");
const btn = document.getElementById("btn");
const btnText = document.getElementById("btnText");
const dim = document.getElementById("dim");

let scrollTop = 0;
let scrollSpeed = 0;
let maxScroll = 0;
let lastText = "";
let isPressed = false;

function rgb565ToRgb(color) {
  const r = (color >> 11) & 0x1f;
  const g = (color >> 5) & 0x3f;
  const b = color & 0x1f;
  return [
    Math.round((r * 255) / 31),
    Math.round((g * 255) / 63),
    Math.round((b * 255) / 31),
  ];
}

function normalizeColor(value) {
  if (typeof value === "number") {
    const rgb = rgb565ToRgb(value);
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }
  if (typeof value === "string" && value.length > 0) {
    return value.startsWith("#") ? value : `#${value}`;
  }
  return "#44f28a";
}

function updateText(text) {
  const nextText = text || "";
  if (nextText !== lastText) {
    textContent.textContent = nextText;
    lastText = nextText;
  }
  maxScroll = Math.max(0, textContent.offsetHeight - document.querySelector(".text-viewport").offsetHeight);
}

function animateScroll() {
  if (scrollSpeed > 0 && scrollTop < maxScroll) {
    scrollTop = Math.min(maxScroll, scrollTop + scrollSpeed * 0.05);
  }
  textContent.style.transform = `translateY(${-scrollTop}px)`;
  requestAnimationFrame(animateScroll);
}

let ws = null;
let reconnectTimer = null;

function applyState(data) {
  if (!data || !data.ready) return;
  statusText.textContent = data.status || "";
  emojiText.textContent = data.emoji || "";
  updateText(data.text || "");
  scrollSpeed = Math.max(0, parseInt(data.scroll_speed || 0, 10));
  const ledColor = normalizeColor(data.RGB);
  led.style.background = ledColor;
  led.style.boxShadow = `0 0 24px ${ledColor}`;
  ledText.textContent = ledColor;
  const batteryLevel = typeof data.battery_level === "number" ? data.battery_level : null;
  if (batteryLevel === null) {
    batteryText.textContent = "--%";
    batteryFill.style.width = "0%";
  } else {
    batteryText.textContent = `${batteryLevel}%`;
    batteryFill.style.width = `${Math.min(100, Math.max(0, batteryLevel))}%`;
  }
  batteryFill.style.background = normalizeColor(data.battery_color);
  dim.style.opacity = Math.max(0, Math.min(1, (100 - (data.brightness ?? 100)) / 100)).toFixed(2);
}

function connectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${protocol}://${window.location.host}/ws`;
  ws = new WebSocket(url);
  ws.addEventListener("message", (event) => {
    let message = null;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "state") {
      applyState(message.payload);
    }
  });
  ws.addEventListener("close", () => {
    reconnectTimer = setTimeout(connectWebSocket, 1000);
  });
  ws.addEventListener("error", () => {
    ws.close();
  });
}

function sendButton(action) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "button", action }));
}

connectWebSocket();
requestAnimationFrame(animateScroll);

function setPressed(value) {
  isPressed = value;
  btnText.textContent = isPressed ? "pressed" : "released";
}

btn.addEventListener("mousedown", () => {
  setPressed(true);
  sendButton("press");
});
btn.addEventListener("mouseup", () => {
  if (!isPressed) return;
  setPressed(false);
  sendButton("release");
});
btn.addEventListener("mouseleave", () => {
  if (isPressed) {
    setPressed(false);
    sendButton("release");
  }
});
window.addEventListener("mouseup", () => {
  if (isPressed) {
    setPressed(false);
    sendButton("release");
  }
});
btn.addEventListener("touchstart", (e) => {
  e.preventDefault();
  setPressed(true);
  sendButton("press");
});
btn.addEventListener("touchend", (e) => {
  e.preventDefault();
  if (isPressed) {
    setPressed(false);
    sendButton("release");
  }
});
window.addEventListener("touchend", () => {
  if (isPressed) {
    setPressed(false);
    sendButton("release");
  }
});
