// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

// Meson runs the source suite; installed-tests places it under backends/.
const modulePath = import.meta.url.includes('/suites/backends/')
    ? '../../../src/service/backends/bluetoothMultiplexer.js'
    : `file://${(await import('../config.js')).default.PACKAGE_DATADIR}` +
      '/service/backends/bluetoothMultiplexer.js';
const {BUFFER_SIZE, DEFAULT_CHANNEL, frame, Multiplexer} = await import(modulePath);

// A stream that deliberately fragments reads at every byte boundary.
/**
 * Create connected, fragmenting byte transports.
 *
 * @returns {object[]} Two connected endpoints
 */
function transportPair() {
    /**
     * Create one byte transport endpoint.
     *
     * @returns {object} The endpoint
     */
    function endpoint() {
        return {
            bytes: [],
            waiter: null,
            closed: false,
            read() {
                if (this.bytes.length > 0)
                    return Promise.resolve(new Uint8Array([this.bytes.shift()]));
                if (this.closed)
                    return Promise.resolve(new Uint8Array());
                return new Promise(resolve => {
                    this.waiter = resolve;
                });
            },
            push(bytes) {
                this.bytes.push(...bytes);
                if (this.waiter) {
                    this.waiter(new Uint8Array([this.bytes.shift()]));
                    this.waiter = null;
                }
            },
            close() {
                this.closed = true;
                this.waiter?.(new Uint8Array());
                this.waiter = null;
            },
        };
    }
    const a = endpoint();
    const b = endpoint();
    a.write = bytes => Promise.resolve(b.push(bytes));
    b.write = bytes => Promise.resolve(a.push(bytes));
    return [a, b];
}

describe('Bluetooth multiplexing', function () {
    let a, b, ios;
    const uuid = '00000000-1234-4567-89ab-0123456789ab';

    beforeEach(function () {
        ios = transportPair();
        a = new Multiplexer(ios[0]);
        b = new Multiplexer(ios[1]);
    });

    afterEach(function () {
        a.close();
        b.close();
    });

    it('encodes the official big-endian header and UUID', function () {
        const bytes = frame(3, uuid, new Uint8Array([0x10, 0]));
        expect(Array.from(bytes)).toEqual([
            3, 0, 2, 0, 0, 0, 0, 0x12, 0x34, 0x45, 0x67,
            0x89, 0xab, 1, 0x23, 0x45, 0x67, 0x89, 0xab, 0x10, 0,
        ]);
    });

    it('transfers fragmented UTF-8 packet bytes with backpressure', async function () {
        a.start();
        b.start();
        const source = new TextEncoder().encode('SMS: hej åäö\n'.repeat(BUFFER_SIZE));
        const writer = a.channels.get(DEFAULT_CHANNEL).write(source);
        const received = new Uint8Array(source.length);
        let offset = 0;
        while (offset < source.length) {
            const chunk = await b.channels.get(DEFAULT_CHANNEL).read();
            received.set(chunk, offset);
            offset += chunk.length;
        }
        await writer;
        expect(received).toEqual(source);
    });

    it('keeps payload channels independent of packet traffic', async function () {
        a.start();
        b.start();
        const payload = await a.open(uuid);
        // A main-channel barrier proves the preceding OPEN has arrived.
        const barrier = a.channels.get(DEFAULT_CHANNEL).write(new Uint8Array([1]));
        await b.channels.get(DEFAULT_CHANNEL).read();
        await barrier;
        const receiver = b.claim(uuid);
        const data = new Uint8Array([1, 2, 3]);
        const sent = payload.write(data);
        expect(await receiver.read()).toEqual(data);
        await sent;
        payload.close();
    });

    it('rejects unsupported versions and wakes blocked readers', async function () {
        a.start();
        const read = a.channels.get(DEFAULT_CHANNEL).read();
        ios[0].push(frame(0, DEFAULT_CHANNEL, new Uint8Array([0, 2, 0, 3])));
        await expectAsync(read).toBeRejected();
        expect(a.closed).toBeTrue();
    });

    it('rejects data sent without receive credit', async function () {
        a.start();
        ios[0].push(frame(0, DEFAULT_CHANNEL, new Uint8Array([0, 1, 0, 1])));
        ios[0].push(frame(4, DEFAULT_CHANNEL, new Uint8Array([1])));
        // exact() is asynchronous even for a buffered input. Observe closure.
        await new Promise(resolve => {
            a.onClose = resolve;
        });
        expect(a.closed).toBeTrue();
    });

    it('wakes writers waiting for credit when the connection closes', async function () {
        a.start();
        const writer = a.channels.get(DEFAULT_CHANNEL).write(new Uint8Array([1]));
        a.close();
        await expectAsync(writer).toBeRejected();
        expect(a.channels.size).toBe(0);
    });

    it('rejects malformed control lengths before reading a body', async function () {
        a.start();
        const closed = new Promise(resolve => {
            a.onClose = resolve;
        });
        ios[0].push(frame(0, DEFAULT_CHANNEL, new Uint8Array([0, 1, 0, 1])));
        ios[0].push(frame(3, DEFAULT_CHANNEL));
        await closed;
        expect(a.closed).toBeTrue();
    });

    it('rejects payload UUIDs that alias the packet channel', function () {
        expect(() => a.claim(DEFAULT_CHANNEL)).toThrow();
        expect(() => a.claim('../payload')).toThrow();
        expect(() => a.claim(uuid)).toThrow();
    });

    it('rejects repeated negotiation without accepting later frames', async function () {
        a.start();
        const closed = new Promise(resolve => {
            a.onClose = resolve;
        });
        const protocol = frame(0, DEFAULT_CHANNEL, new Uint8Array([0, 1, 0, 1]));
        ios[0].push(protocol);
        ios[0].push(protocol);
        await closed;
        expect(a.closed).toBeTrue();
    });

    it('retains received payload bytes after remote close', async function () {
        a.start();
        b.start();
        const sender = await a.open(uuid);
        const barrier = a.channels.get(DEFAULT_CHANNEL).write(new Uint8Array([1]));
        await b.channels.get(DEFAULT_CHANNEL).read();
        await barrier;
        const receiver = b.claim(uuid);
        const read = receiver.read();
        await sender.write(new Uint8Array([42]));
        expect(await read).toEqual(new Uint8Array([42]));
        // Use the remaining receive credit without another pending read.
        await sender.write(new Uint8Array([43]));
        sender.close();
        // Process a second barrier so CLOSE has been consumed.
        const second = a.channels.get(DEFAULT_CHANNEL).write(new Uint8Array([2]));
        await b.channels.get(DEFAULT_CHANNEL).read();
        await second;
        expect(receiver.closed).toBeTrue();
        expect(await receiver.read()).toEqual(new Uint8Array([43]));
        await expectAsync(receiver.read()).toBeRejected();
    });

    it('closes and wakes blocked operations on EOF', async function () {
        a.start();
        const read = a.channels.get(DEFAULT_CHANNEL).read();
        ios[0].close();
        await expectAsync(read).toBeRejected();
        expect(a.closed).toBeTrue();
    });
});
