import fs from "fs";
import path from "path";
import http from "http";
import Koa from "koa";
import Router from "@koa/router";
import serve from "koa-static";
import { WebSocketServer, WebSocket, RawData } from "ws";
import type { Status } from "./display";

type ButtonHandler = () => void;

interface WebDisplayOptions {
  host: string;
  port: number;
  onButtonPress: ButtonHandler;
  onButtonRelease: ButtonHandler;
}

export class WebDisplayServer {
  private currentStatus: Status | null = null;
  private host: string;
  private port: number;
  private onButtonPress: ButtonHandler;
  private onButtonRelease: ButtonHandler;
  private server: http.Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private wsClients = new Set<WebSocket>();

  constructor(options: WebDisplayOptions) {
    this.host = options.host;
    this.port = options.port;
    this.onButtonPress = options.onButtonPress;
    this.onButtonRelease = options.onButtonRelease;
    const app = new Koa();
    const router = new Router();
    const staticRoot = path.resolve(__dirname, "../../web/whisplay-display");
    router.get("/", (ctx) => {
      ctx.set("Cache-Control", "no-store");
      ctx.type = "text/html";
      ctx.body = fs.createReadStream(path.join(staticRoot, "index.html"));
    });
    app.use(router.routes());
    app.use(router.allowedMethods());
    app.use(serve(staticRoot));
    this.server = http.createServer(app.callback());
    this.wsServer = new WebSocketServer({ server: this.server, path: "/ws" });
    this.wsServer.on("connection", (socket) => {
      this.wsClients.add(socket);
      if (this.currentStatus) {
        socket.send(
          JSON.stringify({ type: "state", payload: this.buildStatePayload() })
        );
      }
      socket.on("message", (message) => this.handleWsMessage(socket, message));
      socket.on("close", () => this.wsClients.delete(socket));
      socket.on("error", () => this.wsClients.delete(socket));
    });
    this.server.listen(this.port, this.host, () => {
      console.log(
        `[WebDisplay] Simulator at http://${this.host}:${this.port}`
      );
    });
  }

  updateStatus(status: Status): void {
    this.currentStatus = { ...status };
    this.broadcastState();
  }

  close(): void {
    this.wsServer?.close();
    this.wsServer = null;
    this.wsClients.clear();
    this.server?.close();
    this.server = null;
  }

  private buildStatePayload(): object {
    if (!this.currentStatus) return { ready: false };
    return {
      ready: true,
      status: this.currentStatus.status,
      emoji: this.currentStatus.emoji,
      text: this.currentStatus.text,
      scroll_speed: this.currentStatus.scroll_speed,
      brightness: this.currentStatus.brightness,
      RGB: this.currentStatus.RGB,
      battery_color: this.currentStatus.battery_color,
      battery_level: this.currentStatus.battery_level,
      network_connected: this.currentStatus.network_connected,
      rag_icon_visible: this.currentStatus.rag_icon_visible,
      image_icon_visible: this.currentStatus.image_icon_visible,
    };
  }

  private broadcastState(): void {
    if (!this.currentStatus || this.wsClients.size === 0) return;
    const payload = JSON.stringify({
      type: "state",
      payload: this.buildStatePayload(),
    });
    for (const client of this.wsClients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  private handleWsMessage(socket: WebSocket, message: RawData): void {
    let data: { type?: string; action?: string };
    try {
      data = JSON.parse(message.toString());
    } catch {
      return;
    }
    if (data?.type === "button") {
      const action = String(data.action || "");
      if (action === "press") this.onButtonPress();
      else if (action === "release") this.onButtonRelease();
      return;
    }
    if (data?.type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
    }
  }
}
