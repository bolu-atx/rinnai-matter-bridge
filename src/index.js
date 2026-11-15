import { Endpoint, Environment, ServerNode, VendorId } from "@matter/main";
import { BridgedDeviceBasicInformationServer, ThermostatServer } from "@matter/main/behaviors";
import { Thermostat } from "@matter/main/clusters";
import { OnOffPlugInUnitDevice, ThermostatDevice } from "@matter/main/devices";
import { AggregatorEndpoint } from "@matter/main/endpoints";
import { QrCode } from "@matter/main/types";
import { RinnaiClient, c100ToF, fToC100, snapTemp } from "./rinnai.js";

const env = process.env;
const num = (name, fallback) => (env[name] ? Number(env[name]) : fallback);

const cfg = {
    host: env.RINNAI_HOST ?? "10.0.0.23",
    port: num("RINNAI_PORT", 9798),
    pollMs: num("POLL_SECONDS", 15) * 1000,
    minF: num("MIN_TEMP_F", 98),
    maxF: num("MAX_TEMP_F", 120),
    recircMs: num("RECIRC_MINUTES", 5) * 60 * 1000,
    storage: env.STORAGE_DIR ?? "./data",
    matterPort: num("MATTER_PORT", 5540),
    passcode: env.MATTER_PASSCODE ? Number(env.MATTER_PASSCODE) : undefined,
    discriminator: env.MATTER_DISCRIMINATOR ? Number(env.MATTER_DISCRIMINATOR) : undefined,
};
const UNREACHABLE_MS = 2 * 60 * 1000;
const READBACK_DELAY_MS = 3000;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

Environment.default.vars.set("storage.path", cfg.storage);

const rinnai = new RinnaiClient({ host: cfg.host, port: cfg.port });

const server = await ServerNode.create({
    id: "rinnai-bridge",
    network: { port: cfg.matterPort },
    // Omit unset keys so matter.js generates (and persists) its own.
    commissioning: {
        ...(cfg.passcode !== undefined && { passcode: cfg.passcode }),
        ...(cfg.discriminator !== undefined && { discriminator: cfg.discriminator }),
    },
    productDescription: { name: "Rinnai Bridge", deviceType: AggregatorEndpoint.deviceType },
    basicInformation: {
        vendorName: "thermos",
        vendorId: VendorId(0xfff1),
        productName: "Rinnai Bridge",
        productId: 0x8000,
        nodeLabel: "Rinnai Bridge",
        serialNumber: "rinnai-bridge-1",
    },
});

const aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
await server.add(aggregator);

const heater = new Endpoint(
    ThermostatDevice.with(BridgedDeviceBasicInformationServer, ThermostatServer.with(Thermostat.Feature.Heating)),
    {
        id: "water-heater",
        bridgedDeviceBasicInformation: {
            nodeLabel: "Water Heater",
            productName: "Rinnai Water Heater",
            uniqueId: "rinnai-water-heater",
            reachable: true,
        },
        thermostat: {
            controlSequenceOfOperation: Thermostat.ControlSequenceOfOperation.HeatingOnly,
            systemMode: Thermostat.SystemMode.Heat,
            localTemperature: null,
            occupiedHeatingSetpoint: fToC100(cfg.minF),
            absMinHeatSetpointLimit: fToC100(cfg.minF),
            minHeatSetpointLimit: fToC100(cfg.minF),
            absMaxHeatSetpointLimit: fToC100(cfg.maxF),
            maxHeatSetpointLimit: fToC100(cfg.maxF),
        },
    },
);

const recirc = new Endpoint(OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer), {
    id: "recirculation",
    bridgedDeviceBasicInformation: {
        nodeLabel: "Hot Water Recirculation",
        productName: "Rinnai Recirculation",
        uniqueId: "rinnai-recirculation",
        reachable: true,
    },
});

await aggregator.add(heater);
await aggregator.add(recirc);

// Last state read from the heater. Matter changes that differ from it came from a controller.
const known = { setpointF: undefined, recirc: undefined };
let lastOk = 0;
let reachable = true;

async function setReachable(value) {
    if (value === reachable) return;
    reachable = value;
    log(value ? "heater reachable" : "heater unreachable");
    for (const ep of [heater, recirc]) await ep.set({ bridgedDeviceBasicInformation: { reachable: value } });
}

async function refresh() {
    let props;
    try {
        props = await rinnai.list();
    } catch (e) {
        log("poll failed:", e.message);
        if (Date.now() - lastOk > UNREACHABLE_MS) await setReachable(false);
        return;
    }
    lastOk = Date.now();
    await setReachable(true);

    const setpointF = props.set_domestic_temperature?.value;
    const outletF = props.m02_outlet_temperature?.value;
    const recirculating = props.recirculation_enabled?.value;

    const thermostat = {};
    if (typeof setpointF === "number" && setpointF !== known.setpointF) {
        if (known.setpointF !== undefined) log(`setpoint now ${setpointF}F`);
        known.setpointF = setpointF;
        // Matter rejects values outside the limits; the heater may sit outside our cap.
        thermostat.occupiedHeatingSetpoint = fToC100(Math.min(Math.max(setpointF, cfg.minF), cfg.maxF));
    }
    if (typeof outletF === "number") thermostat.localTemperature = fToC100(outletF);
    if (Object.keys(thermostat).length) await heater.set({ thermostat });

    if (typeof recirculating === "boolean" && recirculating !== known.recirc) {
        if (known.recirc !== undefined) log(`recirculation now ${recirculating ? "on" : "off"}`);
        known.recirc = recirculating;
        await recirc.set({ onOff: { onOff: recirculating } });
    }
}

async function command(description, fn) {
    log(`sending ${description}`);
    try {
        await fn();
    } catch (e) {
        log(`${description} failed:`, e.message);
    }
    await sleep(READBACK_DELAY_MS);
    await refresh();
}

heater.events.thermostat.occupiedHeatingSetpoint$Changed.on(value => {
    const wanted = snapTemp(c100ToF(value), cfg.minF, cfg.maxF);
    // Our own readback (possibly clamped to the cap) must not echo back as a command.
    if (known.setpointF === undefined || wanted === snapTemp(known.setpointF, cfg.minF, cfg.maxF)) return;
    void command(`temperature ${wanted}`, () => rinnai.setTemperature(wanted));
});

heater.events.thermostat.systemMode$Changed.on(mode => {
    if (mode !== Thermostat.SystemMode.Heat) {
        log("ignoring system mode change; water heater is always Heat");
        void heater.set({ thermostat: { systemMode: Thermostat.SystemMode.Heat } });
    }
});

// Recirculation started from Matter stops itself after RECIRC_MINUTES.
let recircTimer;
recirc.events.onOff.onOff$Changed.on(on => {
    if (on === known.recirc) return;
    clearTimeout(recircTimer);
    if (on) {
        recircTimer = setTimeout(() => {
            if (known.recirc) void command("recirculation 0 (timer)", () => rinnai.setRecirculation(false));
        }, cfg.recircMs);
    }
    void command(`recirculation ${on ? 1 : 0}`, () => rinnai.setRecirculation(on));
});

await refresh();
await server.start();

if (!server.lifecycle.isCommissioned) {
    const { qrPairingCode, manualPairingCode } = server.state.commissioning.pairingCodes;
    console.log(QrCode.get(qrPairingCode));
    log(`QR code: ${qrPairingCode}`);
    log(`Manual pairing code: ${manualPairingCode}`);
}

const timer = setInterval(() => void refresh(), cfg.pollMs);

async function shutdown() {
    clearInterval(timer);
    clearTimeout(recircTimer);
    await server.close();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
