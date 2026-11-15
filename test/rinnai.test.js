import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import { test } from "node:test";
import { RinnaiClient, c100ToF, fToC100, parseList, snapTemp } from "../src/rinnai.js";

const fixture = readFileSync(new URL("./fixtures/list.txt", import.meta.url), "utf8");

test("parseList reads a real capture", () => {
    const p = parseList(fixture);
    assert.deepEqual(p.m02_outlet_temperature, { value: 111, writable: false });
    assert.deepEqual(p.set_domestic_temperature, { value: 125, writable: true });
    assert.equal(p.recirculation_enabled.value, false);
    assert.equal(p.recirculation_capable.value, true);
    assert.equal(p.error_code.value, "   ");
    assert.equal(p.m13.value, null);
    assert.equal(p.module_firmware_version.value, "238");
    assert.deepEqual(JSON.parse(p.ca_info.value).ca["revocation-sn"], "0000000000000010");
    assert.equal(p.monitor, undefined);
});

test("snapTemp snaps to valid setpoints and clamps", () => {
    assert.equal(snapTemp(124, 98, 130), 125);
    assert.equal(snapTemp(125, 98, 120), 120);
    assert.equal(snapTemp(112, 98, 130), 113);
    assert.equal(snapTemp(150, 98, 130), 130);
    assert.equal(snapTemp(50, 98, 130), 98);
    assert.equal(snapTemp(135, 98, 130), 130);
});

test("F <-> 0.01C round-trips every valid setpoint", () => {
    for (const f of [98, 100, 113, 120, 125, 130, 140]) assert.equal(c100ToF(fToC100(f)), f);
    assert.equal(fToC100(125), 5167);
});

function fakeHeater() {
    const commands = [];
    let active = 0;
    let maxActive = 0;
    const server = net.createServer(sock => {
        active++;
        maxActive = Math.max(maxActive, active);
        sock.on("close", () => active--);
        sock.write("# monitor\n#   help for help\n");
        sock.setEncoding("utf8");
        sock.on("data", d => {
            for (const cmd of d.split("\n").filter(Boolean)) {
                commands.push(cmd);
                if (cmd === "list") setTimeout(() => sock.write(fixture), 50);
                if (cmd === "quit") sock.end();
            }
        });
    });
    return new Promise(resolve =>
        server.listen(0, "127.0.0.1", () =>
            resolve({ server, port: server.address().port, commands, maxActive: () => maxActive }),
        ),
    );
}

test("client sends only allowed commands, one session at a time", async () => {
    const fake = await fakeHeater();
    const client = new RinnaiClient({ host: "127.0.0.1", port: fake.port, idleMs: 100 });
    const [props] = await Promise.all([client.list(), client.setTemperature(120), client.setRecirculation(true)]);
    await client.setRecirculation(false);
    assert.equal(props.set_domestic_temperature.value, 125);
    assert.deepEqual(
        fake.commands.filter(c => c !== "quit"),
        ["list", "temperature 120", "recirculation 1", "recirculation 0"],
    );
    assert.equal(fake.maxActive(), 1);
    await assert.rejects(client.setTemperature(121), /invalid setpoint/);
    fake.server.close();
});

test("client rejects when the heater is unreachable", async () => {
    const client = new RinnaiClient({ host: "127.0.0.1", port: 1, timeoutMs: 500 });
    await assert.rejects(client.list());
});
