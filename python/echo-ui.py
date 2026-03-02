"""Echo display UI - minimal version of chatbot-ui for Music Agent."""
from PIL import Image, ImageDraw, ImageFont
import os
import time
import socket
import json
import sys
import threading
import signal

from whisplay import WhisplayBoard
from camera import CameraThread
from utils import ColorUtils, ImageUtils, TextUtils

# Optional status icons - Echo may run without them
try:
    STATUS_ICON_DIR = os.path.join(os.path.dirname(__file__), "status-bar-icon")
    if STATUS_ICON_DIR not in sys.path:
        sys.path.append(STATUS_ICON_DIR)
    from battery_icon import BatteryStatusIcon
    from network_icon import NetworkStatusIcon
    from rag_icon import RagStatusIcon
    from image_icon import ImageStatusIcon
    HAS_STATUS_ICONS = True
except ImportError:
    HAS_STATUS_ICONS = False
    BatteryStatusIcon = None
    NetworkStatusIcon = None
    RagStatusIcon = None
    ImageStatusIcon = None

status_font_size = 20
emoji_font_size = 40
battery_font_size = 13

current_status = "Echo"
current_emoji = "🎵"
current_text = "Hold to sing"
current_battery_level = 100
current_battery_color = ColorUtils.get_rgb255_from_any("#55FF00")
current_scroll_top = 0
DEFAULT_SCROLL_SPEED = 0.25
MAX_SCROLL_SPEED = 0.5
current_scroll_speed = DEFAULT_SCROLL_SPEED
current_scroll_sync_char_end = None
current_scroll_sync_duration_ms = None
current_scroll_sync_target_top = None
current_scroll_sync_speed = None
current_scroll_sync_hold_until = 0.0
current_transaction_id = None
current_image_path = ""
current_image = None
current_network_connected = None
current_rag_icon_visible = False
current_image_icon_visible = False
camera_mode = False
camera_capture_image_path = ""
camera_thread = None
clients = {}
status_icon_factories = []


def register_status_icon_factory(factory, priority=100):
    status_icon_factories.append({"priority": priority, "factory": factory})


class RenderThread(threading.Thread):
    def __init__(self, whisplay, font_path, fps=30):
        super().__init__()
        self.whisplay = whisplay
        self.font_path = font_path
        self.fps = fps
        self.render_init_screen(whisplay)
        time.sleep(1)
        self.running = True
        self.main_text_font = ImageFont.truetype(self.font_path, 20)
        m = self.main_text_font.getmetrics()
        self.main_text_line_height = m[0] + m[1]
        self.text_cache_image = None
        self.current_render_text = ""

    def render_init_screen(self, whisplay):
        logo_path = os.path.join(os.path.dirname(__file__), "img", "logo.png")
        if os.path.exists(logo_path):
            logo_image = Image.open(logo_path).convert("RGBA")
            logo_image = logo_image.resize((whisplay.LCD_WIDTH, whisplay.LCD_HEIGHT), Image.LANCZOS)
            rgb565_data = ImageUtils.image_to_rgb565(logo_image, whisplay.LCD_WIDTH, whisplay.LCD_HEIGHT)
            whisplay.set_backlight(100)
            whisplay.draw_image(0, 0, whisplay.LCD_WIDTH, whisplay.LCD_HEIGHT, rgb565_data)

    def render_frame(self, status, emoji, text, scroll_top, battery_level, battery_color):
        global current_scroll_speed, current_image_path, current_image, camera_mode
        if camera_mode:
            return
        if current_image_path not in [None, ""]:
            if current_image is not None:
                rgb565_data = ImageUtils.image_to_rgb565(current_image, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT)
                self.whisplay.draw_image(0, 0, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT, rgb565_data)
            elif os.path.exists(current_image_path):
                try:
                    image = Image.open(current_image_path).convert("RGBA")
                    img_w, img_h = image.size
                    screen_ratio = self.whisplay.LCD_WIDTH / self.whisplay.LCD_HEIGHT
                    img_ratio = img_w / img_h
                    if img_ratio > screen_ratio:
                        new_w = int(img_h * screen_ratio)
                        left = (img_w - new_w) // 2
                        image = image.crop((left, 0, left + new_w, img_h))
                    else:
                        new_h = int(img_w / screen_ratio)
                        top = (img_h - new_h) // 2
                        image = image.crop((0, top, img_w, top + new_h))
                    image = image.resize((self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT), Image.LANCZOS)
                    current_image = image
                    rgb565_data = ImageUtils.image_to_rgb565(image, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT)
                    self.whisplay.draw_image(0, 0, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT, rgb565_data)
                except Exception as e:
                    print(f"[Render] Failed to load image: {e}")
        else:
            current_image = None
            header_height = 98
            image = Image.new("RGBA", (self.whisplay.LCD_WIDTH, header_height), (0, 0, 0, 255))
            draw = ImageDraw.Draw(image)
            self.render_header(image, draw, status, emoji, battery_level, battery_color)
            self.whisplay.draw_image(0, 0, self.whisplay.LCD_WIDTH, header_height, ImageUtils.image_to_rgb565(image, self.whisplay.LCD_WIDTH, header_height))
            text_area_height = self.whisplay.LCD_HEIGHT - header_height
            text_bg_image = Image.new("RGBA", (self.whisplay.LCD_WIDTH, text_area_height), (0, 0, 0, 255))
            text_draw = ImageDraw.Draw(text_bg_image)
            self.render_main_text(text_bg_image, text_area_height, text_draw, text, current_scroll_speed)
            self.whisplay.draw_image(0, header_height, self.whisplay.LCD_WIDTH, text_area_height, ImageUtils.image_to_rgb565(text_bg_image, self.whisplay.LCD_WIDTH, text_area_height))

    def compute_scroll_target_from_char_end(self, lines, line_height, area_height, char_end):
        if char_end is None or char_end <= 0:
            return 0
        total_chars = 0
        target_line = 0
        for i, line in enumerate(lines):
            total_chars += len(line)
            if total_chars >= char_end:
                target_line = i
                break
            if i < len(lines) - 1:
                total_chars += 1
        target_top = target_line * line_height - (area_height // 2)
        return max(0, target_top)

    def render_main_text(self, main_text_image, area_height, draw, text, scroll_speed=2):
        global current_scroll_top, current_scroll_sync_char_end
        global current_scroll_sync_duration_ms, current_scroll_sync_target_top
        global current_scroll_sync_speed, current_scroll_sync_hold_until
        if not text:
            return
        font = ImageFont.truetype(self.font_path, 20)
        lines = TextUtils.wrap_text(draw, text, font, self.whisplay.LCD_WIDTH - 20)
        line_height = self.main_text_line_height
        max_scroll_top = max(0, (len(lines) + 1) * line_height - area_height)
        if current_scroll_sync_char_end is not None and current_scroll_sync_duration_ms is not None:
            target_top = self.compute_scroll_target_from_char_end(lines, line_height, area_height, current_scroll_sync_char_end)
            target_top = min(max_scroll_top, max(current_scroll_top, target_top))
            duration_ms = max(1, current_scroll_sync_duration_ms)
            frames = max(1, int(duration_ms * self.fps / 1000))
            current_scroll_sync_target_top = target_top
            current_scroll_sync_speed = (target_top - current_scroll_top) / frames
            current_scroll_sync_char_end = None
            current_scroll_sync_duration_ms = None
        display_lines = []
        render_y = 0
        fin_show_lines = False
        for i, line in enumerate(lines):
            if (i + 1) * line_height >= current_scroll_top and i * line_height - current_scroll_top <= area_height:
                display_lines.append(line)
                fin_show_lines = True
            elif not fin_show_lines:
                render_y += line_height
        render_text = "".join(display_lines)
        if self.current_render_text != render_text:
            self.current_render_text = render_text
            show_text_image = Image.new("RGBA", (self.whisplay.LCD_WIDTH, render_y + len(display_lines) * line_height), (0, 0, 0, 255))
            show_text_draw = ImageDraw.Draw(show_text_image)
            ry = 0
            for line in display_lines:
                TextUtils.draw_mixed_text(show_text_draw, show_text_image, line, font, (10, ry))
                ry += line_height
            self.text_cache_image = show_text_image
        if self.text_cache_image:
            main_text_image.paste(self.text_cache_image, (0, -int(current_scroll_top)), self.text_cache_image)
        if current_scroll_sync_speed is not None and current_scroll_sync_target_top is not None:
            remaining = current_scroll_sync_target_top - current_scroll_top
            if abs(remaining) <= abs(current_scroll_sync_speed):
                current_scroll_top = current_scroll_sync_target_top
                current_scroll_sync_speed = None
                current_scroll_sync_target_top = None
            else:
                current_scroll_top += current_scroll_sync_speed
        elif scroll_speed > 0 and current_scroll_top < max_scroll_top and time.time() >= current_scroll_sync_hold_until:
            current_scroll_top += scroll_speed
        if current_scroll_top > max_scroll_top:
            current_scroll_top = max_scroll_top

    def render_header(self, image, draw, status, emoji, battery_level, battery_color):
        global current_status, current_emoji, current_battery_level, current_battery_color
        status_font = ImageFont.truetype(self.font_path, status_font_size)
        emoji_font = ImageFont.truetype(self.font_path, emoji_font_size)
        battery_font = ImageFont.truetype(self.font_path, battery_font_size)
        image_width = self.whisplay.LCD_WIDTH
        corner = getattr(self.whisplay, "CornerHeight", 0)
        TextUtils.draw_mixed_text(draw, image, current_status, status_font, (corner, 0))
        emoji_bbox = emoji_font.getbbox(current_emoji)
        emoji_w = emoji_bbox[2] - emoji_bbox[0]
        TextUtils.draw_mixed_text(draw, image, current_emoji, emoji_font, ((image_width - emoji_w) // 2, status_font_size + 8))
        status_icon_context = {
            "battery_level": battery_level,
            "battery_color": battery_color,
            "battery_font": battery_font,
            "status_font_size": status_font_size,
            "network_connected": current_network_connected,
            "rag_icon_visible": current_rag_icon_visible,
            "image_icon_visible": current_image_icon_visible,
        }
        status_icons = self.build_status_icons(status_icon_context)
        self.render_status_icons(draw, status_icons, image_width)

    def build_status_icons(self, context):
        icons = []
        if not HAS_STATUS_ICONS:
            return icons
        battery_level = context.get("battery_level")
        battery_color = context.get("battery_color")
        battery_font = context.get("battery_font")
        status_font_size = context.get("status_font_size")
        if battery_level is not None and BatteryStatusIcon:
            icons.append(BatteryStatusIcon(battery_level, battery_color, battery_font, status_font_size))
        if context.get("network_connected") and NetworkStatusIcon:
            icons.append(NetworkStatusIcon(status_font_size))
        if context.get("image_icon_visible") and ImageStatusIcon:
            icons.append(ImageStatusIcon(status_font_size))
        if context.get("rag_icon_visible") and RagStatusIcon:
            icons.append(RagStatusIcon(status_font_size))
        for item in sorted(status_icon_factories, key=lambda e: e["priority"]):
            icon_list = item["factory"](context)
            if icon_list:
                icons.extend(icon_list)
        return icons

    def render_status_icons(self, draw, icons, image_width):
        if not icons:
            return
        right_margin = 10
        icon_gap = 8
        cursor_x = image_width - right_margin
        for icon in icons:
            icon_width, _ = icon.measure()
            icon_x = cursor_x - icon_width
            icon_y = icon.get_top_y()
            icon.render(draw, icon_x, icon_y)
            cursor_x = icon_x - icon_gap

    def run(self):
        frame_interval = 1 / self.fps
        while self.running:
            self.render_frame(current_status, current_emoji, current_text, current_scroll_top, current_battery_level, current_battery_color)
            time.sleep(frame_interval)

    def stop(self):
        self.running = False


def update_display_data(status=None, emoji=None, text=None, scroll_speed=None, scroll_sync=None,
                       battery_level=None, battery_color=None, image_path=None,
                       network_connected=None, rag_icon_visible=None, image_icon_visible=None, transaction_id=None):
    global current_status, current_emoji, current_text, current_battery_level
    global current_battery_color, current_scroll_top, current_scroll_speed, current_image_path
    global current_scroll_sync_char_end, current_scroll_sync_duration_ms
    global current_scroll_sync_target_top, current_scroll_sync_speed
    global current_scroll_sync_hold_until
    global current_network_connected, current_rag_icon_visible, current_image_icon_visible, current_transaction_id

    next_text = text
    if text is not None:
        previous_text = current_text or ""
        incoming_text = text or ""
        same_transaction = (transaction_id is not None and current_transaction_id is not None and transaction_id == current_transaction_id)
        regressive_update = (len(incoming_text) > 0 and len(incoming_text) < len(previous_text) and previous_text.startswith(incoming_text))
        if same_transaction and regressive_update:
            next_text = previous_text
        elif transaction_id is not None and current_transaction_id is not None and transaction_id != current_transaction_id:
            current_scroll_top = 0
            current_scroll_sync_char_end = None
            current_scroll_sync_duration_ms = None
            current_scroll_sync_target_top = None
            current_scroll_sync_speed = None
            TextUtils.clean_line_image_cache()
        elif not incoming_text.startswith(previous_text) and not previous_text.startswith(incoming_text):
            current_scroll_top = 0
            current_scroll_sync_char_end = None
            current_scroll_sync_duration_ms = None
            current_scroll_sync_target_top = None
            current_scroll_sync_speed = None
            TextUtils.clean_line_image_cache()
    if scroll_sync is not None:
        try:
            char_end = scroll_sync.get("char_end")
            duration_ms = scroll_sync.get("duration_ms")
            if char_end is not None and duration_ms is not None:
                current_scroll_sync_char_end = int(char_end)
                current_scroll_sync_duration_ms = int(duration_ms)
                hold_seconds = max(0.3, (current_scroll_sync_duration_ms / 1000.0) + 0.2)
                current_scroll_sync_hold_until = max(current_scroll_sync_hold_until, time.time() + hold_seconds)
        except Exception as e:
            print(f"[Display] Invalid scroll_sync: {e}")
    if scroll_speed is not None:
        try:
            current_scroll_speed = min(MAX_SCROLL_SPEED, max(0.0, float(scroll_speed)))
        except (TypeError, ValueError):
            pass
    if network_connected is not None:
        current_network_connected = network_connected
    if rag_icon_visible is not None:
        current_rag_icon_visible = rag_icon_visible
    if image_icon_visible is not None:
        current_image_icon_visible = image_icon_visible
    if transaction_id is not None:
        current_transaction_id = transaction_id
    if status is not None:
        current_status = status
    if emoji is not None:
        current_emoji = emoji
    if text is not None:
        current_text = next_text
    if battery_level is not None:
        current_battery_level = battery_level
    if battery_color is not None:
        current_battery_color = battery_color
    if image_path is not None:
        current_image_path = image_path


def send_to_all_clients(message):
    message_json = json.dumps(message).encode("utf-8") + b"\n"
    for addr, client_socket in list(clients.items()):
        try:
            client_socket.sendall(message_json)
        except Exception as e:
            print(f"[Server] Failed to send to {addr}: {e}")


def on_button_pressed():
    print("[Server] Button pressed")
    send_to_all_clients({"event": "button_pressed"})


def on_button_release():
    print("[Server] Button released")
    send_to_all_clients({"event": "button_released"})


def handle_client(client_socket, addr, whisplay):
    global camera_capture_image_path, camera_mode, camera_thread
    print(f"[Socket] Client {addr} connected")
    clients[addr] = client_socket
    try:
        buffer = ""
        while True:
            data = client_socket.recv(4096).decode("utf-8")
            if not data:
                break
            buffer += data
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                if not line.strip():
                    continue
                try:
                    content = json.loads(line)
                    transaction_id = content.get("transaction_id")
                    status = content.get("status")
                    emoji = content.get("emoji")
                    text = content.get("text")
                    rgbled = content.get("RGB")
                    brightness = content.get("brightness")
                    scroll_speed = content.get("scroll_speed")
                    scroll_sync = content.get("scroll_sync")
                    battery_level = content.get("battery_level")
                    battery_color = content.get("battery_color")
                    image_path = content.get("image")
                    network_connected = content.get("network_connected")
                    rag_icon_visible = content.get("rag_icon_visible")
                    image_icon_visible = content.get("image_icon_visible")
                    capture_image_path = content.get("capture_image_path")
                    set_camera_mode = content.get("camera_mode")

                    if rgbled:
                        rgb255_tuple = ColorUtils.get_rgb255_from_any(rgbled)
                        whisplay.set_rgb_fade(*rgb255_tuple, duration_ms=500)
                    if battery_color:
                        battery_tuple = ColorUtils.get_rgb255_from_any(battery_color)
                    else:
                        battery_tuple = (0, 0, 0)
                    if brightness:
                        whisplay.set_backlight(brightness)
                    if capture_image_path is not None:
                        camera_capture_image_path = capture_image_path
                    if set_camera_mode is not None:
                        if set_camera_mode:
                            camera_mode = True
                            camera_thread = CameraThread(whisplay, camera_capture_image_path)
                            camera_thread.start()
                        else:
                            if camera_thread is not None:
                                camera_thread.stop()
                                camera_thread = None
                            camera_mode = False

                    if (text is not None) or (status is not None) or (emoji is not None) or \
                       (battery_level is not None) or (battery_color is not None) or \
                       (image_path is not None) or (network_connected is not None) or \
                       (rag_icon_visible is not None) or (image_icon_visible is not None) or (scroll_sync is not None):
                        update_display_data(status=status, emoji=emoji, text=text, scroll_speed=scroll_speed,
                                            scroll_sync=scroll_sync, battery_level=battery_level, battery_color=battery_tuple,
                                            image_path=image_path, network_connected=network_connected,
                                            rag_icon_visible=rag_icon_visible, image_icon_visible=image_icon_visible,
                                            transaction_id=transaction_id)

                    client_socket.send(b"OK\n")
                except json.JSONDecodeError:
                    client_socket.send(b"ERROR: invalid JSON\n")
                except Exception as e:
                    print(f"[Socket] Error: {e}")
                    client_socket.send(f"ERROR: {e}\n".encode("utf-8"))
    except Exception as e:
        print(f"[Socket] Connection error: {e}")
    finally:
        print(f"[Socket] Client {addr} disconnected")
        clients.pop(addr, None)
        client_socket.close()


def start_socket_server(render_thread, host="0.0.0.0", port=12345):
    whisplay.on_button_press(on_button_pressed)
    whisplay.on_button_release(on_button_release)
    server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server_socket.bind((host, port))
    server_socket.listen(5)
    print(f"[Socket] Listening on {host}:{port} ...")
    try:
        while True:
            client_socket, addr = server_socket.accept()
            client_thread = threading.Thread(target=handle_client, args=(client_socket, addr, whisplay))
            client_thread.daemon = True
            client_thread.start()
    except KeyboardInterrupt:
        print("[Socket] Server stopped")
    finally:
        render_thread.stop()
        server_socket.close()


if __name__ == "__main__":
    whisplay = WhisplayBoard()
    print(f"[LCD] Initialization finished: {whisplay.LCD_WIDTH}x{whisplay.LCD_HEIGHT}")
    custom_font_path = os.getenv("CUSTOM_FONT_PATH")
    font_path = custom_font_path or os.path.join(os.path.dirname(__file__), "NotoSansSC-Bold.ttf")
    if not os.path.exists(font_path):
        font_path = "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc"
    if not os.path.exists(font_path):
        font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    if not os.path.exists(font_path):
        print("[Echo] Warning: No font found, using default")
        font_path = "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"
    render_thread = RenderThread(whisplay, font_path, fps=30)
    render_thread.start()
    start_socket_server(render_thread, host="0.0.0.0", port=12345)

    def cleanup_and_exit(signum, frame):
        print("[System] Exiting...")
        render_thread.stop()
        whisplay.cleanup()
        sys.exit(0)

    signal.signal(signal.SIGTERM, cleanup_and_exit)
    signal.signal(signal.SIGINT, cleanup_and_exit)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        cleanup_and_exit(None, None)
