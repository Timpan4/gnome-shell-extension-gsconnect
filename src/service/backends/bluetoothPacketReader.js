// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import {BUFFER_SIZE} from './bluetoothMultiplexer.js';

// Match BluetoothLink.MAX_PACKET_SIZE in KDE Connect Android (a23de6c5).
export const MAX_PACKET_SIZE = 32 * 1024 * 1024;

/** Assemble packet lines with bounded storage and linear copying. */
export class PacketReader {
    constructor(read, limit = MAX_PACKET_SIZE) {
        this.read = read;
        this.limit = limit;
        this.pending = new Uint8Array();
        this.offset = 0;
    }

    async readLine() {
        const pages = [];
        let length = 0;
        while (true) {
            if (this.offset === this.pending.length) {
                this.pending = await this.read();
                this.offset = 0;
                if (this.pending.length === 0)
                    throw new Error('Bluetooth packet ended before newline');
            }
            const end = this.pending.indexOf(10, this.offset);
            const stop = end === -1 ? this.pending.length : end;
            const count = stop - this.offset;
            if (length + count > this.limit)
                throw new Error('Bluetooth packet exceeds maximum size');

            // Coalesce tiny frames into pages so metadata is bounded too.
            while (this.offset < stop) {
                const position = length % BUFFER_SIZE;
                if (position === 0)
                    pages.push(new Uint8Array(Math.min(BUFFER_SIZE, this.limit - length)));
                const amount = Math.min(stop - this.offset, pages.at(-1).length - position);
                const part = this.pending.subarray(this.offset, this.offset + amount);
                pages.at(-1).set(part, position);
                this.offset += amount;
                length += amount;
            }
            if (end !== -1) {
                this.offset++;
                const line = new Uint8Array(length);
                let copied = 0;
                for (const page of pages) {
                    const part = page.subarray(0, Math.min(page.length, length - copied));
                    line.set(part, copied);
                    copied += part.length;
                }
                return new TextDecoder('utf-8', {fatal: true}).decode(line);
            }
        }
    }
}
