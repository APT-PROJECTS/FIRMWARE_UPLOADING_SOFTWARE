from __future__ import annotations

import time
from dataclasses import dataclass

import serial


SERIAL_BAUDRATE = 2_000_000

CAN_BITRATE_CODES = {
    1_000_000: 0x01,
    800_000: 0x02,
    500_000: 0x03,
    400_000: 0x04,
    250_000: 0x05,
    200_000: 0x06,
    125_000: 0x07,
    100_000: 0x08,
    50_000: 0x09,
    20_000: 0x0A,
    10_000: 0x0B,
    5_000: 0x0C,
}


@dataclass(frozen=True)
class CanFrame:
    can_id: int
    data: bytes
    extended: bool = False
    remote: bool = False


def _checksum(frame: bytes) -> int:
    return sum(frame[2:19]) & 0xFF


def _config_frame(can_bitrate: int) -> bytes:
    if can_bitrate not in CAN_BITRATE_CODES:
        raise ValueError(f"Unsupported CAN bitrate: {can_bitrate}")
    frame = bytearray(20)
    frame[:3] = b"\xAA\x55\x12"
    frame[3] = CAN_BITRATE_CODES[can_bitrate]
    frame[4] = 0x01
    frame[19] = _checksum(frame)
    return bytes(frame)


def _variable_frame(can_id: int, data: bytes, extended: bool = False) -> bytes:
    if not 0 <= len(data) <= 8:
        raise ValueError("CAN data length must be 0..8 bytes")
    if extended:
        if not 0 <= can_id <= 0x1FFFFFFF:
            raise ValueError("Invalid extended CAN ID")
        frame_type, id_bytes = 0xE0 | len(data), can_id.to_bytes(4, "little")
    else:
        if not 0 <= can_id <= 0x7FF:
            raise ValueError("Invalid standard CAN ID")
        frame_type, id_bytes = 0xC0 | len(data), can_id.to_bytes(2, "little")
    return b"\xAA" + bytes([frame_type]) + id_bytes + data + b"\x55"


def _read_exact(port: serial.Serial, count: int, deadline: float) -> bytes | None:
    received = bytearray()
    while len(received) < count and time.monotonic() < deadline:
        part = port.read(count - len(received))
        if part:
            received.extend(part)
    return bytes(received) if len(received) == count else None


def _read_variable_frame(port: serial.Serial, timeout: float) -> CanFrame | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if port.read(1) != b"\xAA":
            continue
        type_byte = _read_exact(port, 1, deadline)
        if not type_byte:
            return None
        frame_type = type_byte[0]
        data_length = frame_type & 0x0F
        if data_length > 8:
            continue
        extended = bool(frame_type & 0x20)
        id_length = 4 if extended else 2
        payload = _read_exact(port, id_length + data_length + 1, deadline)
        if not payload or payload[-1] != 0x55:
            continue
        return CanFrame(
            can_id=int.from_bytes(payload[:id_length], "little"),
            data=payload[id_length:-1],
            extended=extended,
            remote=bool(frame_type & 0x10),
        )
    return None


class WaveshareCANA:
    """Serial protocol wrapper for the Waveshare USB-CAN-A adapter."""

    def __init__(self, port: str, can_bitrate: int, baudrate: int = SERIAL_BAUDRATE) -> None:
        self.ser = serial.Serial(port, baudrate, timeout=0.02)
        self.ser.reset_input_buffer()
        self.ser.reset_output_buffer()
        self.ser.write(_config_frame(can_bitrate))
        self.ser.flush()
        time.sleep(0.2)
        self.ser.reset_input_buffer()

    def send(self, can_id: int, data: bytes | list[int], extended: bool = False) -> None:
        self.ser.write(_variable_frame(can_id, bytes(data), extended))
        self.ser.flush()

    def receive(self, timeout: float = 1.0) -> CanFrame | None:
        return _read_variable_frame(self.ser, timeout)

    def close(self) -> None:
        if self.ser.is_open:
            self.ser.close()
