import net from "node:net";

// Setpoints the Rinnai controller accepts (deg F).
export const VALID_TEMPS_F = [98, 100, 102, 104, 106, 108, 110, 113, 115, 120, 125, 130, 135, 140];

export const fToC100 = f => Math.round(((f - 32) * 5) / 9 * 100);
export const c100ToF = c => Math.round((c / 100) * 9 / 5 + 32);

/** Snap to the nearest valid setpoint within [min, max]. */
export function snapTemp(f, min, max) {
    const allowed = VALID_TEMPS_F.filter(t => t >= min && t <= max);
    if (!allowed.length) throw new Error(`no valid setpoint in [${min}, ${max}]`);
    return allowed.reduce((best, t) => (Math.abs(t - f) < Math.abs(best - f) ? t : best));
}

const LINE = /^\s*(\w+):([+ ])\s*(.*?)\s*\{[^}]*\}\s*$/;

function parseValue(raw) {
    if (raw === "null") return null;
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
    const n = /^(-?\d+)(?:\s+\(0x[0-9a-f]+\))?$/i.exec(raw);
    return n ? Number(n[1]) : raw;
}

/** Parse `list` output into { name: { value, writable } }. */
export function parseList(text) {
    const props = {};
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith("#")) continue;
        const m = LINE.exec(line);
        if (m) props[m[1]] = { value: parseValue(m[3]), writable: m[2] === "+" };
    }
    return props;
}

/**
 * Talks to the Control-R module's plain-text console on TCP 9798.
 * One connection per command, all commands serialized: the module is a tiny console.
 */
export class RinnaiClient {
    #queue = Promise.resolve();

    constructor({ host, port = 9798, idleMs = 1500, timeoutMs = 6000 }) {
        Object.assign(this, { host, port, idleMs, timeoutMs });
    }

    async list() {
        return parseList(await this.#send("list"));
    }

    async setTemperature(f) {
        if (!Number.isInteger(f) || !VALID_TEMPS_F.includes(f)) throw new Error(`invalid setpoint ${f}`);
        await this.#send(`temperature ${f}`);
    }

    async setRecirculation(on) {
        await this.#send(`recirculation ${on ? 1 : 0}`);
    }

    #send(command) {
        const run = () => this.#exchange(command);
        const result = this.#queue.then(run, run);
        this.#queue = result.catch(() => {});
        return result;
    }

    #exchange(command) {
        return new Promise((resolve, reject) => {
            const socket = net.connect({ host: this.host, port: this.port });
            let data = "";
            let idle;
            let error;
            // Settle only once the socket is fully closed, so sessions never overlap.
            const close = err => {
                error ??= err;
                clearTimeout(idle);
                socket.destroy();
            };
            const overall = setTimeout(() => close(data ? undefined : new Error(`timeout: ${command}`)), this.timeoutMs);
            const armIdle = () => {
                clearTimeout(idle);
                idle = setTimeout(() => {
                    socket.end("quit\n");
                    idle = setTimeout(() => close(), 500);
                }, this.idleMs);
            };
            socket.setEncoding("utf8");
            socket.on("connect", () => {
                socket.write(`${command}\n`);
                armIdle();
            });
            socket.on("data", chunk => {
                data += chunk;
                armIdle();
            });
            socket.on("error", close);
            socket.on("close", () => {
                clearTimeout(idle);
                clearTimeout(overall);
                error ? reject(error) : resolve(data);
            });
        });
    }
}
