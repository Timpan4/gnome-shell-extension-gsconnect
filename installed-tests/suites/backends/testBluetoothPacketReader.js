// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

const modulePath = import.meta.url.includes('/suites/backends/')
    ? '../../../src/service/backends/bluetoothPacketReader.js'
    : `file://${(await import('../config.js')).default.PACKAGE_DATADIR}` +
      '/service/backends/bluetoothPacketReader.js';
const {PacketReader} = await import(modulePath);
const {BUFFER_SIZE} = await import(modulePath.replace('bluetoothPacketReader', 'bluetoothMultiplexer'));

describe('Bluetooth packet reader', function () {
    it('assembles fragmented UTF-8 across pages and preserves following packets', async function () {
        const text = `${'x'.repeat(BUFFER_SIZE)}åäö`;
        const bytes = new TextEncoder().encode(`${text}\n\nnext\n`);
        let offset = 0;
        const reader = new PacketReader(() => Promise.resolve(bytes.subarray(offset, ++offset)));
        expect(await reader.readLine()).toBe(text);
        expect(await reader.readLine()).toBe('');
        expect(await reader.readLine()).toBe('next');
    });

    it('accepts an exact byte limit and rejects a line exceeding it', async function () {
        // Use the protocol frame size as a fixture boundary for the parser.
        const bytes = new TextEncoder().encode(`${'x'.repeat(BUFFER_SIZE)}\nnext\n`);
        const reader = new PacketReader(() => Promise.resolve(bytes), BUFFER_SIZE);
        expect(await reader.readLine()).toBe('x'.repeat(BUFFER_SIZE));
        expect(await reader.readLine()).toBe('next');
        const overflow = new PacketReader(
            () => Promise.resolve(new Uint8Array(BUFFER_SIZE + 1)), BUFFER_SIZE);
        await expectAsync(overflow.readLine()).toBeRejected();
    });

    it('rejects EOF and invalid UTF-8 without returning a partial packet', async function () {
        const eof = new PacketReader(() => Promise.resolve(new Uint8Array()));
        await expectAsync(eof.readLine()).toBeRejected();
        const invalid = new PacketReader(() => Promise.resolve(new Uint8Array([0xff, 10])));
        await expectAsync(invalid.readLine()).toBeRejected();
    });
});
