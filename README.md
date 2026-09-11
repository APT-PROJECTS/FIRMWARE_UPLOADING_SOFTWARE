# PIC32MK CAN Firmware Uploader

Offline Flask service tool for programming a PIC32MK1024MCM064 application through a Waveshare USB-CAN-A adapter. It uses only local serial/CAN communication; it does not download firmware, check for versions, or send reports.

## Run

```powershell
cd firmware_upload_software
python -m pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:5000` in a browser, choose the Waveshare COM port and CAN bitrate, then connect.

## Update sequence

`Read controller data → jump to bootloader → validate image size → erase → transfer 1 KiB chunks → CRC validation → write image size → jump to application`

Project ID and Firmware ID can be entered in the Controller information card and queued with **Update IDs**. The uploader writes them after a successful CRC validation and before it saves the final application size.

Use **Force update** when the normal application cannot accept the bootloader-jump request. It sends `STAY_IN_BOOT` (`0x09`) repeatedly for about 20 seconds; reset or power-cycle the controller during that period. Once the bootloader replies, the tool performs the same validated update sequence.

Each request that expects an acknowledgement retries up to five times. The CAN log filters to bootloader IDs `0x0B0` (host) and `0x0B1` (controller), retaining the most recent 1,200 entries. The final application jump intentionally has no retry because the controller resets before it can acknowledge that frame.

The uploader follows the CAN protocol in this repository's `src/middleware/boot_handler.[ch]`. Firmware files are stored temporarily in the local `uploads` folder and are excluded from Git.
