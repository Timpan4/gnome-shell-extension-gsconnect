// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

export const DEFAULT_CHANNEL = 'a0d0aaf4-1072-4d81-aa35-902a954b1266';
// KDE Connect Android's receive buffer, also used as our receive window.
export const BUFFER_SIZE = 4096;
// Fork policy chosen under the owner's authorization to select resource limits.
export const MAX_PAYLOAD_CHANNELS = 64;
const HEADER_SIZE = 19;

/**
 * Validate a wire channel identifier.
 *
 * @param {string} uuid - Channel UUID
 * @returns {boolean} Whether the UUID is canonical
 */
export function validUuid(uuid) {
    return typeof uuid === 'string' &&
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(uuid);
}

/**
 * Encode a multiplex frame in network byte order.
 *
 * @param {number} type - Wire message type
 * @param {string} uuid - Channel UUID
 * @param {Uint8Array} data - Message body
 * @returns {Uint8Array} Complete frame
 */
export function frame(type, uuid, data = new Uint8Array()) {
    const bytes = new Uint8Array(HEADER_SIZE + data.length);
    bytes[0] = type;
    new DataView(bytes.buffer).setUint16(1, data.length);
    const hex = uuid.replaceAll('-', '');
    for (let i = 0; i < 16; i++)
        bytes[3 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    bytes.set(data, HEADER_SIZE);
    return bytes;
}

/** A credit-controlled byte channel. One reader and one writer per channel. */
class ByteChannel {
    constructor(mux, uuid) {
        this.mux = mux;
        this.uuid = uuid;
        this.chunks = [];
        this.buffered = 0;
        this.credit = 0;
        this.requested = 0;
        this.closed = false;
        this.waiters = new Set();
    }

    wake() {
        for (const resolve of this.waiters)
            resolve();
        this.waiters.clear();
    }

    wait() {
        return new Promise(resolve => this.waiters.add(resolve));
    }

    async read() {
        while (this.chunks.length === 0) {
            if (this.closed)
                throw new Error('Bluetooth channel closed');
            const amount = BUFFER_SIZE - this.buffered - this.requested;
            if (amount > 0) {
                this.requested += amount;
                const data = new Uint8Array(2);
                new DataView(data.buffer).setUint16(0, amount);
                await this.mux.send(3, this.uuid, data);
            }
            if (this.chunks.length === 0 && !this.closed)
                await this.wait();
        }
        const chunk = this.chunks.shift();
        this.buffered -= chunk.length;
        return chunk;
    }

    async write(bytes) {
        let offset = 0;
        while (offset < bytes.length) {
            if (this.closed)
                throw new Error('Bluetooth channel closed');
            if (this.credit === 0) {
                await this.wait();
                continue;
            }
            const count = Math.min(bytes.length - offset, this.credit, BUFFER_SIZE);
            this.credit -= count;
            await this.mux.send(4, this.uuid, bytes.subarray(offset, offset + count));
            offset += count;
        }
    }

    close(remote = false) {
        if (this.closed)
            return;
        this.closed = true;
        this.wake();
        if (this.uuid === DEFAULT_CHANNEL) {
            this.mux.close();
        } else if (!remote) {
            this.mux.channels.delete(this.uuid);
            this.mux.send(2, this.uuid).catch(() => {});
        }
        // Retain remotely closed channels until a payload consumer claims them.
    }
}

/** KDE Connect multiplexing v1 over an async byte transport. */
export class Multiplexer {
    constructor(io, onClose = () => {}) {
        this.io = io;
        this.onClose = onClose;
        this.channels = new Map();
        this.channels.set(DEFAULT_CHANNEL, new ByteChannel(this, DEFAULT_CHANNEL));
        this.closed = false;
        this.negotiated = false;
        this.writes = Promise.resolve();
    }

    start() {
        this.send(0, DEFAULT_CHANNEL, new Uint8Array([0, 1, 0, 1])).catch(() => {});
        this.receive().catch(error => this.close(error));
    }

    send(type, uuid, data) {
        const operation = this.writes.then(() => {
            if (this.closed)
                throw new Error('Bluetooth connection closed');
            return this.io.write(frame(type, uuid, data));
        });
        this.writes = operation.catch(error => this.close(error));
        return operation;
    }

    async exact(size) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        while (offset < size) {
            const chunk = await this.io.read(size - offset);
            if (chunk.length === 0)
                throw new Error('Bluetooth end of stream');
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return bytes;
    }

    async receive() {
        while (!this.closed) {
            const header = await this.exact(HEADER_SIZE);
            const type = header[0];
            const size = new DataView(header.buffer).getUint16(1);
            const hex = Array.from(header.subarray(3), b => b.toString(16).padStart(2, '0'))
                .join('');
            const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
                `${hex.slice(16, 20)}-${hex.slice(20)}`;
            if ((!this.negotiated && type !== 0) || type > 4 ||
                (type === 0 && (this.negotiated || size < 4)) ||
                ((type === 1 || type === 2) && size !== 0) ||
                (type === 3 && size !== 2) || (type === 4 && size > BUFFER_SIZE))
                throw new Error('Invalid Bluetooth multiplex frame');
            const data = await this.exact(size);
            const view = new DataView(data.buffer);
            if (type === 0) {
                if (view.getUint16(0) > 1 || view.getUint16(2) < 1)
                    throw new Error('Unsupported Bluetooth multiplex version');
                this.negotiated = true;
                continue;
            }
            let channel = this.channels.get(uuid);
            if (type === 1) {
                if (channel)
                    throw new Error('Duplicate Bluetooth channel');
                this.checkChannelCapacity();
                channel = new ByteChannel(this, uuid);
                this.channels.set(uuid, channel);
            } else if (channel && type === 2) {
                channel.close(true);
            } else if (channel && !channel.closed && type === 3) {
                const credit = channel.credit + view.getUint16(0);
                if (!Number.isSafeInteger(credit))
                    throw new Error('Bluetooth credit overflow');
                channel.credit = credit;
                channel.wake();
            } else if (channel && !channel.closed && type === 4) {
                if (size > channel.requested)
                    throw new Error('Bluetooth peer exceeded receive credit');
                channel.requested -= size;
                if (size > 0) {
                    channel.chunks.push(data);
                    channel.buffered += size;
                    channel.wake();
                }
            }
        }
    }

    async open(uuid) {
        this.checkChannelCapacity();
        const channel = new ByteChannel(this, uuid);
        this.channels.set(uuid, channel);
        await this.send(1, uuid);
        return channel;
    }

    checkChannelCapacity() {
        // Include closed-but-unclaimed payloads; reserve the default channel.
        if (this.channels.size - 1 >= MAX_PAYLOAD_CHANNELS) {
            this.close();
            throw new Error('Bluetooth payload channel limit reached');
        }
    }

    claim(uuid) {
        if (!validUuid(uuid) || uuid === DEFAULT_CHANNEL || !this.channels.has(uuid))
            throw new Error('Invalid Bluetooth payload channel');
        return this.channels.get(uuid);
    }

    close(error = new Error('Bluetooth connection closed')) {
        if (this.closed)
            return;
        this.closed = true;
        for (const channel of this.channels.values()) {
            channel.closed = true;
            channel.wake();
        }
        this.channels.clear();
        this.io.close();
        this.onClose(error);
    }
}
