import { Endpoint, Environment, ServerNode, VendorId } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { AggregatorEndpoint } from "@matter/main/endpoints";
import { QrCode } from "@matter/main/types";
import { RinnaiClient } from "./rinnai.js";

const env = process.env;
const num = (name, fallback) => (env[name] ? Number(env[name]) : fallback);

const cfg = {
    host: env.RINNAI_HOST ?? "10.0.0.23",
    port: num("RINNAI_PORT", 9798),
    pollMs: num("POLL_SECONDS", 15) * 1000,
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

const recirc = new Endpoint(OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer), {
    id: "recirculation",
    bridgedDeviceBasicInformation: {
        nodeLabel: "Hot Water Recirculation",
        productName: "Rinnai Recirculation",
        uniqueId: "rinnai-recirculation",
        reachable: true,
    },
});
await aggregator.add(recirc);

// Last state read from the heater. Matter changes that differ from it came from a controller.
const known = { recirc: undefined };
let lastOk = 0;
let reachable = true;

async function setReachable(value) {
    if (value === reachable) return;
    reachable = value;
    log(value ? "heater reachable" : "heater unreachable");
    await recirc.set({ bridgedDeviceBasicInformation: { reachable: value } });
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

    const recirculating = props.recirculation_enabled?.value;
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
