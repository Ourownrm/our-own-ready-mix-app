// Round 195 — a minimal, READ-ONLY client for eSSL / ZKTeco attendance
// machines over TCP (the "ZK protocol", port 4370).
//
// eSSL's K30 is a ZKTeco machine with eSSL's badge on it, and it speaks the
// same binary protocol eTimeTrackLite itself uses through zkemkeeper.dll. This
// file talks that protocol directly so the plant needs no eSSL software, no
// SDK DLL and no 32-bit anything — only Node.
//
// WHAT IT CAN DO, AND THE THINGS IT DELIBERATELY CANNOT:
//   can     connect, authenticate with the comm key, read the serial number,
//           firmware and clock, read the user list and the attendance log.
//   cannot  clear the attendance log, delete or enrol users, set the clock,
//           restart the machine, open a door. None of those command codes even
//           appear below. A bug in this file can fail to read; it cannot lose
//           a single punch on the machine. That is the whole safety design, so
//           do not add a write command here "just for convenience".
//
// The wire format below matches pyzk (github.com/fananimi/pyzk), the reference
// implementation most ZK integrations in the field are built on, byte for byte
// — including its checksum being computed over the PREVIOUS reply id, which
// looks wrong but is what working devices expect.
//
// Framing: every TCP packet is
//   [0x50 0x50 0x82 0x7d][u32 LE length][payload of `length` bytes]
// and the payload is
//   [u16 command][u16 checksum][u16 session id][u16 reply id][data...]

import net from "net";

export const CMD = {
  CONNECT: 1000,
  EXIT: 1001,
  AUTH: 1102,
  ACK_OK: 2000,
  ACK_ERROR: 2001,
  ACK_DATA: 2002,
  ACK_UNAUTH: 2005,
  PREPARE_DATA: 1500,
  DATA: 1501,
  FREE_DATA: 1502,
  PREPARE_BUFFER: 1503, // "read with buffer" request
  READ_BUFFER: 1504,    // fetch one chunk of a prepared buffer
  GET_FREE_SIZES: 50,
  OPTIONS_RRQ: 11,
  GET_TIME: 201,
  GET_VERSION: 1100,
  USERTEMP_RRQ: 9,
  ATTLOG_RRQ: 13,
};

const FCT_USER = 5;
const USHRT_MAX = 65535;
const MAX_CHUNK = 0xffc0;

export function checksum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    sum += i === buf.length - 1 ? buf[i] : buf.readUInt16LE(i);
    sum %= USHRT_MAX;
  }
  return USHRT_MAX - sum - 1;
}

// The machine packs a timestamp into one u32 as seconds since 2000-01-01 on a
// calendar where every month has 31 days. It is plant-local wall-clock time
// with no timezone; we return the parts, never a Date, so nobody's PC timezone
// can shift it.
export function decodeTime(t) {
  const second = t % 60; t = Math.floor(t / 60);
  const minute = t % 60; t = Math.floor(t / 60);
  const hour = t % 24; t = Math.floor(t / 24);
  const day = (t % 31) + 1; t = Math.floor(t / 31);
  const month = (t % 12) + 1; t = Math.floor(t / 12);
  const year = t + 2000;
  return { year, month, day, hour, minute, second };
}

export function encodeTimeForTest({ year, month, day, hour, minute, second }) {
  return ((year % 100) * 12 * 31 + (month - 1) * 31 + day - 1) * (24 * 60 * 60) +
    (hour * 60 + minute) * 60 + second;
}

const p2 = (n) => String(n).padStart(2, "0");
export function partsToLocalString(p) {
  return `${p.year}-${p2(p.month)}-${p2(p.day)} ${p2(p.hour)}:${p2(p.minute)}:${p2(p.second)}`;
}

// The comm key scramble, as the machine expects it (pyzk make_commkey).
export function makeCommKey(key, sessionId, ticks = 50) {
  key = Number(key) >>> 0;
  let k = 0;
  for (let i = 0; i < 32; i++) {
    k = (key & (1 << i)) ? ((k << 1) | 1) >>> 0 : (k << 1) >>> 0;
  }
  k = (k + sessionId) >>> 0;
  const b = Buffer.alloc(4);
  b.writeUInt32LE(k);
  const x = Buffer.from([b[0] ^ 0x5a, b[1] ^ 0x4b, b[2] ^ 0x53, b[3] ^ 0x4f]); // 'Z','K','S','O'
  // swap the two 16-bit halves
  const swapped = Buffer.from([x[2], x[3], x[0], x[1]]);
  const B = ticks & 0xff;
  return Buffer.from([swapped[0] ^ B, swapped[1] ^ B, B, swapped[3] ^ B]);
}

function cString(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString("latin1").trim();
}

export class ZkClient {
  constructor({ ip, port = 4370, commKey = 0, timeoutMs = 15000 }) {
    this.ip = ip;
    this.port = port;
    this.commKey = commKey;
    this.timeoutMs = timeoutMs;
    this.sessionId = 0;
    this.replyId = USHRT_MAX - 1;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.closedError = null;
  }

  // ---------------------------------------------------------------- transport

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    this._drain();
  }

  _drain() {
    while (this.waiters.length) {
      const frame = this._takeFrame();
      if (!frame) return;
      const w = this.waiters.shift();
      clearTimeout(w.timer);
      if (frame instanceof Error) w.reject(frame);
      else w.resolve(frame);
    }
  }

  _takeFrame() {
    if (this.buf.length < 8) return null;
    if (this.buf.readUInt16LE(0) !== 0x5050 || this.buf.readUInt16LE(2) !== 0x7d82) {
      const bad = this.buf.subarray(0, 8).toString("hex");
      this.buf = Buffer.alloc(0);
      return new Error(`Unexpected bytes from the machine (${bad}) — is this really a ZK/eSSL machine on port ${this.port}?`);
    }
    const len = this.buf.readUInt32LE(4);
    if (this.buf.length < 8 + len) return null;
    const payload = this.buf.subarray(8, 8 + len);
    this.buf = this.buf.subarray(8 + len);
    if (payload.length < 8) return new Error("Short packet from the machine.");
    return {
      cmd: payload.readUInt16LE(0),
      session: payload.readUInt16LE(4),
      reply: payload.readUInt16LE(6),
      data: Buffer.from(payload.subarray(8)),
    };
  }

  _nextFrame() {
    return new Promise((resolve, reject) => {
      if (this.closedError) return reject(this.closedError);
      const w = { resolve, reject };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`The machine at ${this.ip} stopped answering (timed out after ${this.timeoutMs / 1000}s).`));
      }, this.timeoutMs);
      this.waiters.push(w);
      this._drain();
    });
  }

  _packet(command, data = Buffer.alloc(0)) {
    const head = Buffer.alloc(8);
    head.writeUInt16LE(command, 0);
    head.writeUInt16LE(0, 2);
    head.writeUInt16LE(this.sessionId, 4);
    head.writeUInt16LE(this.replyId, 6);
    const body = Buffer.concat([head, data]);
    body.writeUInt16LE(checksum(body), 2);
    this.replyId = (this.replyId + 1) % USHRT_MAX;
    body.writeUInt16LE(this.replyId, 6);
    const top = Buffer.alloc(8);
    top.writeUInt16LE(0x5050, 0);
    top.writeUInt16LE(0x7d82, 2);
    top.writeUInt32LE(body.length, 4);
    return Buffer.concat([top, body]);
  }

  async command(command, data) {
    if (!this.socket) throw new Error("Not connected.");
    this.socket.write(this._packet(command, data));
    const frame = await this._nextFrame();
    this.replyId = frame.reply;
    return frame;
  }

  // ---------------------------------------------------------------- session

  async connect() {
    await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.ip, port: this.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`Could not reach the machine at ${this.ip}:${this.port} within ${this.timeoutMs / 1000}s. ` +
          `Check it is switched on, on the network, and that this PC can ping it.`));
      }, this.timeoutMs);
      s.once("connect", () => { clearTimeout(timer); resolve(); });
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to the machine at ${this.ip}:${this.port} — ${err.code || err.message}.`));
      });
      s.on("data", (c) => this._onData(c));
      s.on("close", () => {
        this.closedError = new Error("The machine closed the connection.");
        for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(this.closedError); }
      });
      s.on("error", () => { /* surfaced through close / timeouts */ });
      this.socket = s;
    });

    const r = await this.command(CMD.CONNECT);
    this.sessionId = r.session;
    if (r.cmd === CMD.ACK_UNAUTH) {
      const a = await this.command(CMD.AUTH, makeCommKey(this.commKey, this.sessionId));
      if (a.cmd !== CMD.ACK_OK) {
        throw new Error("The machine refused the comm key. Set \"commKey\" in config.json to the machine's " +
          "Comm Key (machine menu: Comm. → Comm Key, or the eTimeTrackLite device settings).");
      }
    } else if (r.cmd !== CMD.ACK_OK) {
      throw new Error(`The machine refused the connection (reply ${r.cmd}). It may be busy with another program — try again in a minute.`);
    }
  }

  async disconnect() {
    try {
      if (this.socket && !this.closedError) await this.command(CMD.EXIT);
    } catch { /* leaving anyway */ }
    try { this.socket?.destroy(); } catch { /* ignore */ }
    this.socket = null;
  }

  // ---------------------------------------------------------------- info

  async option(name) {
    const r = await this.command(CMD.OPTIONS_RRQ, Buffer.from(`${name}\0`, "latin1"));
    if (r.cmd !== CMD.ACK_OK) return null;
    const s = cString(r.data);
    const eq = s.indexOf("=");
    return eq >= 0 ? s.slice(eq + 1).trim() || null : null;
  }

  async firmware() {
    const r = await this.command(CMD.GET_VERSION);
    return r.cmd === CMD.ACK_OK ? cString(r.data) || null : null;
  }

  async time() {
    const r = await this.command(CMD.GET_TIME);
    if (r.cmd !== CMD.ACK_OK || r.data.length < 4) return null;
    return partsToLocalString(decodeTime(r.data.readUInt32LE(0)));
  }

  async sizes() {
    const r = await this.command(CMD.GET_FREE_SIZES);
    if (r.cmd !== CMD.ACK_OK || r.data.length < 80) return null;
    const f = (i) => r.data.readInt32LE(i * 4);
    return {
      users: f(4), fingers: f(6), records: f(8),
      fingerCapacity: f(14), userCapacity: f(15), recordCapacity: f(16),
    };
  }

  // ---------------------------------------------------------------- bulk reads

  async _readChunk(start, size) {
    const req = Buffer.alloc(8);
    req.writeInt32LE(start, 0);
    req.writeInt32LE(size, 4);
    const first = await this.command(CMD.READ_BUFFER, req);
    if (first.cmd === CMD.DATA) return first.data;
    if (first.cmd !== CMD.PREPARE_DATA) {
      throw new Error(`Unexpected reply ${first.cmd} while reading data from the machine.`);
    }
    // PREPARE_DATA says how many bytes follow; they arrive as one or more DATA
    // packets and then a closing ACK_OK.
    const total = first.data.readUInt32LE(0);
    const parts = [];
    let got = 0;
    while (got < total) {
      const f = await this._nextFrame();
      if (f.cmd === CMD.DATA) { parts.push(f.data); got += f.data.length; continue; }
      if (f.cmd === CMD.ACK_OK) break; // shorter than announced — take what came
      throw new Error(`Unexpected reply ${f.cmd} in the middle of a data transfer.`);
    }
    // The closing ACK_OK (when the loop ended on byte count).
    if (got >= total) {
      const end = await this._nextFrame().catch(() => null);
      if (end && end.cmd !== CMD.ACK_OK) {
        // Not fatal: put nothing back, but say so in case a firmware differs.
        this.lastWarning = `expected ACK_OK after a data transfer, got ${end.cmd}`;
      }
    }
    return Buffer.concat(parts);
  }

  async readWithBuffer(command, fct = 0, ext = 0) {
    const req = Buffer.alloc(11);
    req.writeInt8(1, 0);
    req.writeInt16LE(command, 1);
    req.writeInt32LE(fct, 3);
    req.writeInt32LE(ext, 7);
    const r = await this.command(CMD.PREPARE_BUFFER, req);
    if (r.cmd === CMD.DATA) return r.data;
    if (r.cmd !== CMD.ACK_OK || r.data.length < 5) {
      throw new Error(`The machine would not prepare data (reply ${r.cmd}).`);
    }
    const size = r.data.readUInt32LE(1);
    const parts = [];
    let start = 0;
    while (start < size) {
      const n = Math.min(MAX_CHUNK, size - start);
      parts.push(await this._readChunk(start, n));
      start += n;
    }
    await this.command(CMD.FREE_DATA).catch(() => {});
    return Buffer.concat(parts);
  }

  async users(expectedCount) {
    const data = await this.readWithBuffer(CMD.USERTEMP_RRQ, FCT_USER);
    if (data.length < 4) return [];
    const total = data.readUInt32LE(0);
    const body = data.subarray(4, 4 + total);
    let size = expectedCount ? total / expectedCount : 0;
    if (size !== 28 && size !== 72) size = total % 72 === 0 ? 72 : 28;
    const out = [];
    for (let o = 0; o + size <= body.length; o += size) {
      const r = body.subarray(o, o + size);
      if (size === 28) {
        out.push({ uid: r.readUInt16LE(0), privilege: r[2], name: cString(r.subarray(8, 16)),
          userId: String(r.readUInt32LE(24)) });
      } else {
        out.push({ uid: r.readUInt16LE(0), privilege: r[2], name: cString(r.subarray(11, 35)),
          userId: cString(r.subarray(48, 72)) || String(r.readUInt16LE(0)) });
      }
    }
    return out;
  }

  // Every punch the machine holds. `users` (from users()) is only needed for
  // the oldest 8-byte record format, which stores the internal uid instead of
  // the user ID people know.
  async attendance(expectedCount, users = []) {
    const data = await this.readWithBuffer(CMD.ATTLOG_RRQ);
    if (data.length < 4) return [];
    const total = data.readUInt32LE(0);
    const body = data.subarray(4, 4 + total);
    let size = expectedCount ? total / expectedCount : 0;
    if (![8, 16, 40].includes(size)) size = total % 40 === 0 ? 40 : total % 16 === 0 ? 16 : 8;
    const byUid = new Map(users.map((u) => [u.uid, u.userId]));
    const out = [];
    for (let o = 0; o + size <= body.length; o += size) {
      const r = body.subarray(o, o + size);
      let userId, t, state, verify, workCode = null;
      if (size === 8) {
        const uid = r.readUInt16LE(0);
        userId = byUid.get(uid) || String(uid);
        verify = r[2]; t = r.readUInt32LE(3); state = r[7];
      } else if (size === 16) {
        userId = String(r.readUInt32LE(0)); t = r.readUInt32LE(4);
        verify = r[8]; state = r[9]; workCode = r.readUInt32LE(12);
      } else {
        userId = cString(r.subarray(2, 26)) || String(r.readUInt16LE(0));
        verify = r[26]; t = r.readUInt32LE(27); state = r[31];
      }
      out.push({ userId, at: partsToLocalString(decodeTime(t)), state, verify, workCode });
    }
    return out;
  }
}
