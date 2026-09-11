from __future__ import annotations

import struct
import threading
import time
import zlib
import math
from collections import deque
from pathlib import Path
from typing import Callable

from flask import Flask, jsonify, render_template, request
from serial.tools import list_ports
from werkzeug.utils import secure_filename

from waveshare_can import CanFrame, WaveshareCANA


BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# PIC32MK bootloader CAN protocol, defined in src/middleware/boot_handler.h.
BOOT_CAN_ID_HOST = 0x0B0
BOOT_CAN_ID_CLIENT = 0x0B1
CAN_READ, CAN_WRITE, CAN_COMPARE = 0x01, 0x02, 0x03
CAN_SUCCESS = 0x01
CMD_PIC_ID, CMD_SOFTWARE_ID, CMD_STATUS = 0x01, 0x02, 0x03
CMD_APP_SIZE, CMD_JUMP, CMD_APP_ERASE, CMD_APP_CHUNK, CMD_APP_CRC = 0x04, 0x05, 0x06, 0x07, 0x08
CMD_STAY_IN_BOOT = 0x09
SUB_MAC_WORDS = (0x01, 0x02, 0x03, 0x04)
SUB_DEVICE_ID, SUB_PROJECT_ID, SUB_FIRMWARE_ID, SUB_BOOT_VERSION = 0x05, 0x01, 0x02, 0x03
SUB_BOOT_JUMP, SUB_APP_JUMP = 0x01, 0x02
STATUS_NAMES = {0x01: "Bootloader", 0x02: "Application", 0x03: "Unknown"}
DEVICE_NAMES = {
    0x08B02053: "PIC32MK1024MCM064",
    0x08B05053: "PIC32MK0512MCM064",
}
CHUNK_SIZE, FRAME_PAYLOAD_SIZE, MAX_REQUEST_ATTEMPTS = 1024, 4, 5
FORCE_PROBE_ATTEMPTS = 1000
EXPECTED_STAY_IN_BOOT_REPLY = bytes([CMD_STAY_IN_BOOT, 0, 0, CAN_SUCCESS, 0, 0, 0, 0])

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024  # The controller application area is below 1 MiB.


def blank_controller() -> dict[str, str]:
    return {
        "mac_id": "—", "device_id": "—", "device_name": "—", "project_id": "—",
        "firmware_id": "—", "boot_version": "—", "status": "—", "app_size": "—", "crc": "—",
    }


class UploadService:
    def __init__(self) -> None:
        self.adapter: WaveshareCANA | None = None
        self.port: str | None = None
        self.lock = threading.RLock()
        self.job_lock = threading.Lock()
        self.logs: deque[dict[str, str | int]] = deque(maxlen=1200)
        self.log_sequence = 0
        self.log_generation = 0
        self.status = {"connected": False, "busy": False, "phase": "Idle", "progress": 0, "message": "Disconnected"}
        self.controller = blank_controller()
        self.firmware: dict | None = None
        self.pending_ids: dict[str, float] | None = None

    def log(self, message: str, level: str = "info") -> None:
        self.log_sequence += 1
        self.logs.append({"id": self.log_sequence, "time": time.strftime("%H:%M:%S"), "message": message, "level": level})

    def connect(self, port: str, bitrate: int) -> None:
        with self.lock:
            self.disconnect()
            self.adapter = WaveshareCANA(port, bitrate)
            self.port = port
            self.status.update(connected=True, busy=False, phase="Ready", progress=0, message=f"Connected to {port}")
            self.log(f"Connected to Waveshare USB-CAN on {port} at {bitrate:,} bit/s", "success")

    def disconnect(self) -> None:
        with self.lock:
            if self.adapter:
                self.adapter.close()
            self.adapter = None
            self.port = None
            self.status.update(connected=False, busy=False, phase="Idle", progress=0, message="Disconnected")

    def _adapter(self) -> WaveshareCANA:
        if not self.adapter:
            raise RuntimeError("Connect the USB-CAN adapter first")
        return self.adapter

    @staticmethod
    def _frame(command: int, subcommand: int = 0, operation: int = 0, value: bytes = b"") -> bytes:
        return bytes([command, subcommand, operation, 0]) + value.ljust(4, b"\x00")[:4]

    def _send(self, payload: bytes, description: str) -> None:
        self._adapter().send(BOOT_CAN_ID_HOST, payload)
        self.log(f"TX 0x{BOOT_CAN_ID_HOST:03X}  {payload.hex(' ').upper()}  · {description}")

    def _wait_for(self, matches: Callable[[bytes], bool], timeout: float) -> bytes:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            frame: CanFrame | None = self._adapter().receive(max(0.01, min(0.20, deadline - time.monotonic())))
            if frame is None:
                continue
            # Keep the activity log deliberately limited to bootloader traffic.
            if frame.can_id in (BOOT_CAN_ID_HOST, BOOT_CAN_ID_CLIENT):
                self.log(f"RX 0x{frame.can_id:03X}  {frame.data.hex(' ').upper()}")
            if frame.can_id == BOOT_CAN_ID_CLIENT and matches(frame.data):
                return frame.data
        raise TimeoutError("Timed out waiting for the controller response")

    @staticmethod
    def _reply(command: int, operation: int, subcommand: int | None = None) -> Callable[[bytes], bool]:
        return lambda data: len(data) >= 4 and data[0] == command and data[2] == operation and (subcommand is None or data[1] == subcommand)

    def _request(self, payload: bytes, description: str, matches: Callable[[bytes], bool], timeout: float = 2.5) -> bytes:
        for attempt in range(1, MAX_REQUEST_ATTEMPTS + 1):
            self._send(payload, f"{description} · attempt {attempt}/{MAX_REQUEST_ATTEMPTS}")
            try:
                return self._wait_for(matches, timeout)
            except TimeoutError:
                if attempt == MAX_REQUEST_ATTEMPTS:
                    raise TimeoutError(f"No controller response after {MAX_REQUEST_ATTEMPTS} attempts: {description}")
                self.log(f"No response: {description}; retrying ({attempt}/{MAX_REQUEST_ATTEMPTS})", "warning")
        raise AssertionError("unreachable")

    @staticmethod
    def _success(reply: bytes, label: str) -> bytes:
        if reply[3] != CAN_SUCCESS:
            raise RuntimeError(f"Controller rejected: {label}")
        return reply

    def _read_controller_info(self) -> None:
        self.status.update(phase="Reading controller information", message="Reading device data over CAN")
        values: list[int] = []
        for word in SUB_MAC_WORDS:
            response = self._success(self._request(self._frame(CMD_PIC_ID, word, CAN_READ), f"Read MAC ID word {word}", self._reply(CMD_PIC_ID, CAN_READ, word)), f"MAC ID word {word}")
            values.append(int.from_bytes(response[4:8], "big"))
        self.controller["mac_id"] = "-".join(f"{value:08X}" for value in values)

        response = self._success(self._request(self._frame(CMD_PIC_ID, SUB_DEVICE_ID, CAN_READ), "Read device ID", self._reply(CMD_PIC_ID, CAN_READ, SUB_DEVICE_ID)), "device ID")
        device_id = int.from_bytes(response[4:8], "big")
        self.controller["device_id"] = f"0x{device_id:08X}"
        self.controller["device_name"] = DEVICE_NAMES.get(device_id, "Unknown PIC32 device")

        for field, subcommand, label in (
            ("project_id", SUB_PROJECT_ID, "project ID"),
            ("firmware_id", SUB_FIRMWARE_ID, "firmware ID"),
            ("boot_version", SUB_BOOT_VERSION, "boot version"),
        ):
            response = self._success(self._request(self._frame(CMD_SOFTWARE_ID, subcommand, CAN_READ), f"Read {label}", self._reply(CMD_SOFTWARE_ID, CAN_READ, subcommand)), label)
            self.controller[field] = f"{struct.unpack('<f', response[4:8])[0]:.1f}"

        response = self._success(self._request(self._frame(CMD_STATUS, 0, CAN_READ), "Read controller status", self._reply(CMD_STATUS, CAN_READ)), "controller status")
        self.controller["status"] = STATUS_NAMES.get(response[1], f"Unknown (0x{response[1]:02X})")

        response = self._success(self._request(self._frame(CMD_APP_SIZE, 0, CAN_READ), "Read application size", self._reply(CMD_APP_SIZE, CAN_READ)), "application size")
        self.controller["app_size"] = f"{int.from_bytes(response[4:8], 'big'):,} bytes"

        # A new/unprogrammed controller returns FAIL for CRC because it has no stored size.
        try:
            response = self._success(self._request(self._frame(CMD_APP_CRC, 0, CAN_READ), "Read application CRC", self._reply(CMD_APP_CRC, CAN_READ), 6.0), "application CRC")
            self.controller["crc"] = f"0x{int.from_bytes(response[4:8], 'big'):08X}"
        except RuntimeError:
            self.controller["crc"] = "Not available (no stored application)"
        self.status.update(phase="Ready", message="Controller information updated")
        self.log("Controller information read successfully", "success")

    def _boot_jump(self) -> None:
        response = self._success(self._request(self._frame(CMD_JUMP, SUB_BOOT_JUMP), "Jump to bootloader", self._reply(CMD_JUMP, 0, SUB_BOOT_JUMP), 6.0), "bootloader jump")
        response  # Keeps the successful acknowledgement explicit for traceability.
        self.log("Controller is in bootloader mode", "success")
        time.sleep(0.25)

    def _probe_bootloader(self) -> bool:
        """Keep transmitting STAY_IN_BOOT while the controller is being reset.

        The bootloader services command 0x09 during its startup window and
        replies with 09 00 00 01 00 00 00 00 when it has remained active.
        """
        self.status.update(phase="Force update", message="Probing bootloader; reset the controller if needed")
        probe = self._frame(CMD_STAY_IN_BOOT)
        for attempt in range(1, FORCE_PROBE_ATTEMPTS + 1):
            self._adapter().send(BOOT_CAN_ID_HOST, probe)
            if attempt == 1 or attempt % 50 == 0:
                self.log(f"TX 0x{BOOT_CAN_ID_HOST:03X}  {probe.hex(' ').upper()}  · Force boot probe {attempt}/{FORCE_PROBE_ATTEMPTS}")

            deadline = time.monotonic() + 0.01
            while time.monotonic() < deadline:
                frame = self._adapter().receive(max(0.001, deadline - time.monotonic()))
                if frame is None:
                    break
                if frame.can_id in (BOOT_CAN_ID_HOST, BOOT_CAN_ID_CLIENT):
                    self.log(f"RX 0x{frame.can_id:03X}  {frame.data.hex(' ').upper()}")
                if frame.can_id == BOOT_CAN_ID_CLIENT and frame.data == EXPECTED_STAY_IN_BOOT_REPLY:
                    self.log("Bootloader detected and held in update mode", "success")
                    return True
            time.sleep(0.01)
        return False

    def _validate_size(self, size: int) -> None:
        response = self._success(self._request(self._frame(CMD_APP_SIZE, 0, CAN_COMPARE, size.to_bytes(4, "big")), "Validate firmware size", self._reply(CMD_APP_SIZE, CAN_COMPARE)), "firmware size")
        response

    def _erase(self) -> None:
        response = self._success(self._request(self._frame(CMD_APP_ERASE), "Erase application flash", self._reply(CMD_APP_ERASE, 0), 20.0), "application erase")
        response

    def _send_firmware(self, image: bytes) -> None:
        chunks = (len(image) + CHUNK_SIZE - 1) // CHUNK_SIZE
        for number in range(chunks):
            chunk_index = (number % 255) + 1
            start = number * CHUNK_SIZE
            chunk = image[start:start + CHUNK_SIZE].ljust(CHUNK_SIZE, b"\xFF")
            for attempt in range(1, MAX_REQUEST_ATTEMPTS + 1):
                for offset in range(0, CHUNK_SIZE, FRAME_PAYLOAD_SIZE):
                    # Command, chunk number, write, reserved, then four binary bytes.
                    # Keep the browser log compact: one entry represents these 256 CAN frames.
                    self._adapter().send(
                        BOOT_CAN_ID_HOST,
                        self._frame(CMD_APP_CHUNK, chunk_index, CAN_WRITE, chunk[offset:offset + FRAME_PAYLOAD_SIZE]),
                    )
                    time.sleep(0.001)
                self.log(
                    f"TX 0x{BOOT_CAN_ID_HOST:03X}  256 data frames · chunk {number + 1}/{chunks} "
                    f"({min(start + CHUNK_SIZE, len(image)):,}/{len(image):,} bytes) · attempt {attempt}/{MAX_REQUEST_ATTEMPTS}"
                )
                try:
                    response = self._success(self._wait_for(self._reply(CMD_APP_CHUNK, CAN_WRITE, chunk_index), 7.0), f"chunk {number + 1}")
                    response
                    break
                except TimeoutError:
                    if attempt == MAX_REQUEST_ATTEMPTS:
                        raise TimeoutError(f"No acknowledgement for chunk {number + 1} after {MAX_REQUEST_ATTEMPTS} attempts")
                    self.log(f"No acknowledgement for chunk {number + 1}; retransmitting", "warning")
            self.status["progress"] = round((number + 1) * 100 / chunks)

    def _verify_crc(self, image: bytes) -> None:
        host_crc = zlib.crc32(image) & 0xFFFFFFFF
        response = self._success(self._request(self._frame(CMD_APP_CRC, 0, CAN_READ), "Validate application CRC", self._reply(CMD_APP_CRC, CAN_READ), 10.0), "application CRC")
        device_crc = int.from_bytes(response[4:8], "big")
        self.controller["crc"] = f"0x{device_crc:08X}"
        if device_crc != host_crc:
            raise RuntimeError(f"CRC mismatch: file 0x{host_crc:08X}, controller 0x{device_crc:08X}")
        self.log(f"CRC verified: 0x{device_crc:08X}", "success")

    def _write_size(self, size: int) -> None:
        response = self._success(self._request(self._frame(CMD_APP_SIZE, 0, CAN_WRITE, size.to_bytes(4, "big")), "Write application size", self._reply(CMD_APP_SIZE, CAN_WRITE)), "application size write")
        response
        self.controller["app_size"] = f"{size:,} bytes"

    def _write_software_ids(self) -> None:
        """Save the operator-selected IDs only after image CRC verification."""
        if self.pending_ids:
            values = self.pending_ids
        else:
            try:
                values = {
                    "project_id": float(self.controller["project_id"]),
                    "firmware_id": float(self.controller["firmware_id"]),
                }
            except (TypeError, ValueError) as error:
                raise RuntimeError("Enter valid project and firmware IDs before starting the update") from error

        self.status.update(phase="Writing software IDs", message="Saving project and firmware IDs")
        for field, subcommand, label in (
            ("project_id", SUB_PROJECT_ID, "project ID"),
            ("firmware_id", SUB_FIRMWARE_ID, "firmware ID"),
        ):
            value = values[field]
            response = self._success(
                self._request(
                    self._frame(CMD_SOFTWARE_ID, subcommand, CAN_WRITE, struct.pack("<f", value)),
                    f"Write {label}",
                    self._reply(CMD_SOFTWARE_ID, CAN_WRITE, subcommand),
                ),
                f"{label} write",
            )
            response
            self.controller[field] = f"{value:.1f}"
            self.log(f"{label.capitalize()} saved: {value:.1f}", "success")
        self.pending_ids = None

    def _app_jump(self) -> None:
        # The current bootloader calls the application's reset vector immediately
        # and therefore cannot place an ACK on CAN for this final hand-off.
        self._send(self._frame(CMD_JUMP, SUB_APP_JUMP), "Jump to application")
        self.log("Application jump requested; controller restarts before a final CAN acknowledgement", "success")

    def _upload(self) -> None:
        if not self.firmware:
            raise RuntimeError("Select a .bin firmware file first")
        image = self.firmware["path"].read_bytes()
        if not image:
            raise RuntimeError("The selected firmware file is empty")
        self._read_controller_info()
        self.status.update(phase="Entering bootloader", message="Requesting bootloader mode")
        self._boot_jump()
        self.status.update(phase="Validating image size", message="Checking application partition")
        self._validate_size(len(image))
        self.status.update(phase="Erasing application", message="Erasing controller flash")
        self._erase()
        self.status.update(phase="Uploading firmware", message="Transferring application chunks", progress=0)
        self._send_firmware(image)
        self.status.update(phase="Validating CRC", message="Comparing firmware CRC")
        self._verify_crc(image)
        self._write_software_ids()
        self.status.update(phase="Saving application size", message="Writing final image size")
        self._write_size(len(image))
        self.status.update(phase="Starting application", message="Jumping to updated application")
        self._app_jump()
        self.status.update(phase="Complete", progress=100, message="Firmware update completed successfully")
        self.log("Firmware update completed successfully", "success")

    def _force_upload(self) -> None:
        if not self.firmware:
            raise RuntimeError("Select a .bin firmware file first")
        if not self._probe_bootloader():
            raise RuntimeError("Bootloader probe failed. Reset or power-cycle the controller, then try Force update again.")
        self.log("Starting validated firmware update from forced bootloader mode", "success")
        self._upload()

    def _start_job(self, phase: str, task: Callable[[], None]) -> None:
        if not self.status["connected"]:
            raise RuntimeError("Connect the USB-CAN adapter first")
        if not self.job_lock.acquire(blocking=False):
            raise RuntimeError("Another controller operation is already running")
        self.status.update(busy=True, phase=phase, progress=0, message=phase)

        def worker() -> None:
            try:
                with self.lock:
                    task()
            except Exception as error:
                self.status.update(phase="Error", message=str(error))
                self.log(str(error), "error")
            finally:
                self.status["busy"] = False
                self.job_lock.release()

        threading.Thread(target=worker, daemon=True).start()

    def start_info_read(self) -> None:
        self._start_job("Reading controller information", self._read_controller_info)

    def start_update(self) -> None:
        self._start_job("Preparing firmware update", self._upload)

    def start_force_update(self) -> None:
        self._start_job("Preparing forced firmware update", self._force_upload)

    def stage_software_ids(self, project_id: object, firmware_id: object) -> dict[str, float]:
        if self.status["busy"]:
            raise RuntimeError("Wait for the active controller operation to finish")
        try:
            values = {"project_id": float(project_id), "firmware_id": float(firmware_id)}
        except (TypeError, ValueError) as error:
            raise RuntimeError("Project ID and firmware ID must be numeric values") from error
        if any(not math.isfinite(value) or value < 0 for value in values.values()):
            raise RuntimeError("Project ID and firmware ID must be finite non-negative values")
        if any(value != round(value, 1) for value in values.values()):
            raise RuntimeError("Project ID and firmware ID can have at most one digit after the decimal point")
        self.pending_ids = values
        self.log(f"Software IDs queued for post-CRC update: project {values['project_id']:.1f}, firmware {values['firmware_id']:.1f}", "success")
        return values

    def clear_logs(self) -> None:
        self.logs.clear()
        self.log_generation += 1


service = UploadService()


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/ports")
def ports():
    return jsonify([{"device": port.device, "description": port.description} for port in list_ports.comports()])


@app.post("/api/connect")
def connect():
    data = request.get_json(force=True)
    service.connect(str(data["port"]), int(data.get("bitrate", 500000)))
    return jsonify({"ok": True})


@app.post("/api/disconnect")
def disconnect():
    if service.status["busy"]:
        return jsonify({"error": "Wait for the active controller operation to finish"}), 409
    service.disconnect()
    return jsonify({"ok": True})


@app.post("/api/firmware")
def upload_file():
    file = request.files.get("firmware")
    if not file or not file.filename or not file.filename.lower().endswith(".bin"):
        return jsonify({"error": "Select a .bin firmware file"}), 400
    filename = secure_filename(file.filename)
    if not filename:
        return jsonify({"error": "Invalid firmware file name"}), 400
    path = UPLOAD_DIR / filename
    file.save(path)
    size = path.stat().st_size
    if not size:
        path.unlink(missing_ok=True)
        return jsonify({"error": "Firmware file is empty"}), 400
    content = path.read_bytes()
    service.firmware = {"name": filename, "path": path, "size": size, "crc": zlib.crc32(content) & 0xFFFFFFFF}
    service.log(f"Firmware loaded: {filename} ({size:,} bytes)", "success")
    return jsonify({"ok": True, "name": filename, "size": size, "crc": f"0x{service.firmware['crc']:08X}"})


@app.post("/api/controller/read")
def read_controller():
    service.start_info_read()
    return jsonify({"ok": True})


@app.post("/api/update")
def update():
    service.start_update()
    return jsonify({"ok": True})


@app.post("/api/force-update")
def force_update():
    service.start_force_update()
    return jsonify({"ok": True})


@app.post("/api/software-ids")
def stage_software_ids():
    data = request.get_json(force=True)
    values = service.stage_software_ids(data.get("project_id"), data.get("firmware_id"))
    return jsonify({"ok": True, "pending_ids": values})


@app.post("/api/logs/clear")
def clear_logs():
    service.clear_logs()
    return jsonify({"ok": True})


@app.get("/api/status")
def status():
    firmware = None if not service.firmware else {key: value for key, value in service.firmware.items() if key != "path"}
    try:
        after = max(0, int(request.args.get("after", "0")))
    except ValueError:
        after = 0
    logs = [entry for entry in service.logs if int(entry["id"]) > after]
    return jsonify({
        "status": service.status,
        "controller": service.controller,
        "firmware": firmware,
        "pending_ids": service.pending_ids,
        "logs": logs,
        "log_generation": service.log_generation,
    })


@app.errorhandler(Exception)
def handle_error(error):
    return jsonify({"error": str(error)}), 400


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
