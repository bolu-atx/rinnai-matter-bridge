# rinnai-matter-bridge

A small local bridge that exposes a Rinnai tankless water heater with a **Control-R Wi-Fi module** as a **Matter** device. You can then control it from Google Home, Apple Home, Alexa, or any other Matter controller.

It talks to the heater directly over your LAN. It does not use the Rinnai cloud, and it needs no Home Assistant.

The bridge shows one device, **Hot Water Recirculation**, as a Matter on/off switch. It starts and stops recirculation. Runs started from Matter stop on their own after `RECIRC_MINUTES` (default 5). The heater keeps the setpoint you set on its own panel or in the Rinnai app.

> **Not affiliated with Rinnai.** This project uses an undocumented local interface. A firmware update can change or remove it at any time. Use it at your own risk. You are controlling a gas appliance.

## How it works

The Control-R module runs a plain-text console on **TCP port 9798**. It has no authentication and no encryption. The bridge polls it with `list` and sends only `list` and `recirculation 0|1`.

```
Google Home / Nest hub  <── Matter (LAN) ──>  rinnai-matter-bridge  <── TCP 9798 ──>  Control-R module
```

Tested with Control-R module firmware `238`.

## Requirements

- A Rinnai heater with a Control-R module that is on your Wi-Fi. Give it a fixed IP address (a DHCP reservation).
- A Matter hub for your ecosystem:
  - Google: a Nest Mini, Nest Audio, Nest Hub, Nest Wifi Pro, or Google TV device.
  - Apple: a HomePod or Apple TV.
- An always-on Linux machine on the same network, with Docker. Matter needs mDNS and IPv6 link-local, so the container uses host networking. On macOS and Windows, Docker Desktop's host networking is limited, so run it with Node instead (see below).

## Check that your heater answers

```sh
printf 'list\n' | nc -w 3 <heater-ip> 9798
```

You should see lines such as `set_domestic_temperature:+ 120 (0x78)`. If you see nothing, your module may have different firmware.

## Run with Docker

```sh
git clone https://github.com/bolu-atx/rinnai-matter-bridge.git
cd rinnai-matter-bridge
mkdir data
# Edit docker-compose.yml: set RINNAI_HOST, and set user: to the owner of ./data (id -u; id -g)
docker compose up -d --build
docker logs rinnai-bridge
```

The log prints a QR code and an 11-digit manual pairing code.

## Run with Node

You need Node 22 or later.

```sh
npm ci
RINNAI_HOST=<heater-ip> npm start
```

## Pair with Google Home

Google Home needs a free Developer Console project before it accepts a device with Matter test IDs. You do this once:

1. Go to [console.home.google.com](https://console.home.google.com). Sign in with the Google account that owns your home.
2. Create a project. Add a **Matter integration** with Vendor ID `0xFFF1` and Product ID `0x8000`.

Then pair the bridge:

1. Open the Google Home app. Tap **+**, then **Device**, then **New device**, then **Matter-enabled device**.
2. Scan the QR code from the log, or enter the manual pairing code.
3. Google warns that the device is not certified. Choose **Proceed anyway**. The bridge uses Matter test vendor IDs.
4. Say "Hey Google, turn on hot water recirculation."

If the app stays on "Getting your device ready", force-close the Google Home app and open it again. The device is often already in your list.

The pairing keys are saved in `data/`. If you delete that folder, you must pair again.

## Configuration

All settings are environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RINNAI_HOST` | `10.0.0.23` | IP address of the Control-R module |
| `RINNAI_PORT` | `9798` | Console port |
| `POLL_SECONDS` | `15` | How often to read the heater state |
| `RECIRC_MINUTES` | `5` | Recirculation started from Matter stops after this many minutes |
| `STORAGE_DIR` | `./data` (`/data` in Docker) | Matter pairing storage |
| `MATTER_PORT` | `5540` | Matter UDP port |
| `MATTER_PASSCODE` / `MATTER_DISCRIMINATOR` | random, saved | Fixed pairing values, if you want them |
| `MATTER_LOG_LEVEL` | `info` (Docker) | matter.js log level |

### Timer limits

The recirculation timer lives in the bridge. If the bridge restarts during a run, recirculation keeps going until you turn it off. Runs started from the Rinnai app are not timed by the bridge.

## Security

Anything on your network can control the heater through port 9798. This bridge does not add that risk; the module already has it. Consider putting the heater on an IoT VLAN or a guest network that the bridge host can still reach.

## The port 9798 console

The console sends a banner, then accepts one command per line. `help` lists them all. These are the useful ones:

| Command | Effect |
| --- | --- |
| `list` | Print every property as `name:<+ if writable> value {age}` |
| `temperature <F>` | Set the hot water setpoint |
| `recirculation 1` / `0` | Start or stop recirculation |
| `quit` | Close the session |

Write commands print nothing. Read the state back with `list` about 3 seconds later. The module handles one session at a time.

Useful properties: `m02_outlet_temperature`, `m08_inlet_temperature`, `set_domestic_temperature`, `domestic_combustion` (the burner is on), `recirculation_enabled`, `recirculation_capable`, `error_code`, and `module_firmware_version`.

The console has other commands, such as maintenance, lock, schedule, and Zigbee pairing. The bridge never sends them.

The `m..` sensor values (outlet temperature and others) are a cache. The module refreshes them only now and then, for example when the burner fires, so they are often minutes or days old. That is why the bridge does not show a temperature.

## Development

```sh
npm test
```

The tests parse a real `list` capture, which is redacted. They also run the client against a fake console server, to check that it sends only allowed commands, one session at a time.

## License

MIT
