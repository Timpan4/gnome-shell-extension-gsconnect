// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {TextEncoder, TextDecoder} from 'node:util';
import {URL} from 'node:url';
import {test} from 'node:test';
import vm from 'node:vm';

const uuid = '11111111-2222-3333-4444-555555555555';

// Evaluate complete production modules. Only framework and unrelated service
// boundaries are replaced; relative Bluetooth protocol modules remain real.
/**
 * Load production code with fake framework boundaries.
 * @param {string} path - Production module path
 * @param {object} overrides - Framework replacements
 * @returns {Promise<object>} Module exports
 */
async function loadModule(path, overrides = {}) {
    const context = vm.createContext({
        debug() {},
        _: value => value,
        TextEncoder,
        TextDecoder,
    });
    const defaults = {
        'gi://Gio': {},
        'gi://Gtk': {},
        'gi://GLib': {PRIORITY_DEFAULT: 0, uuid_string_random: randomUUID},
        'gi://GObject': {registerClass: (options, implementation) => implementation},
        '../core.js': {Channel: class {}, ChannelService: class {}},
        '../device.js': {default: {}},
        '../plugin.js': {default: class {}},
        '../ui/notification.js': {default: class {}},
        '../components/index.js': {},
        '../../config.js': {default: {}},
        ...overrides,
    };
    const cache = new Map();
    /**
     * Resolve relative production imports recursively.
     * @param {URL} url - Module location
     * @returns {Promise<vm.Module>} Linked module
     */
    async function resolve(url) {
        if (cache.has(url.href))
            return cache.get(url.href);
        const source = await readFile(url, 'utf8');
        const module = new vm.SourceTextModule(source, {context, identifier: url.href});
        cache.set(url.href, module);
        await module.link((specifier, referencing) => {
            if (!Object.hasOwn(defaults, specifier))
                return resolve(new URL(specifier, referencing.identifier));
            const value = defaults[specifier];
            const exports = Object.hasOwn(value, 'default') || specifier === '../core.js'
                ? value : {default: value};
            return new vm.SyntheticModule(Object.keys(exports), function () {
                for (const [key, entry] of Object.entries(exports))
                    this.setExport(key, entry);
            }, {context});
        });
        return module;
    }
    const module = await resolve(new URL(path, import.meta.url));
    await module.evaluate();
    return module.namespace;
}

const backend = await loadModule('../src/service/backends/bluetooth.js');
const {Multiplexer} = await loadModule('../src/service/backends/bluetoothMultiplexer.js');

/**
 * Create a stream that records cleanup and writes.
 * @returns {object} Stream substitute
 */
function stream() {
    return {
        closed: 0,
        writes: [],
        async close_async() { this.closed++; },
        async write_all_async(bytes) { this.writes.push(...bytes); },
    };
}

/**
 * Create a real backend Channel with controlled transport boundaries.
 * @returns {object} Channel and observable effects
 */
function fixture() {
    const channel = Object.create(backend.Channel.prototype);
    const payload = {
        uuid,
        closed: false,
        reads: 0,
        async read() { this.reads++; return new Uint8Array([1, 2]); },
        close() { this.closed = true; },
    };
    const channels = new Map([[uuid, payload]]);
    let cancelled = false;
    const listeners = new Map();
    const cancellable = {
        connect(callback) { listeners.set(1, callback); return 1; },
        disconnect(id) { listeners.delete(id); },
        is_cancelled: () => cancelled,
        cancel() {
            cancelled = true;
            for (const callback of listeners.values())
                callback();
        },
    };
    Object.assign(channel, {
        mux: {
            channels,
            claim(id) {
                if (!channels.has(id))
                    throw new Error('Invalid Bluetooth payload channel');
                return channels.get(id);
            },
            async open(id) {
                const opened = {...payload, uuid: id};
                channels.set(id, opened);
                return opened;
            },
        },
        close() { this.closedByCancellation = true; },
        async sendPacket() {},
    });
    return {channel, payload, channels, cancellable, listeners};
}

test('invalid payload metadata closes the target and removes any retained payload channel', async () => {
    for (const [id, size] of [[undefined, 0], ['invalid', 0], [uuid, -1],
        [uuid, NaN], [uuid, Infinity], [uuid, '2'], [uuid, 1.5]]) {
        const {channel, payload, channels} = fixture();
        const target = stream();
        await assert.rejects(channel.download({
            payloadTransferInfo: {uuid: id}, payloadSize: size,
        }, target));
        assert.equal(target.closed, 1);
        if (id === uuid) {
            assert.equal(channels.size, 0);
            assert.equal(payload.closed, true);
        }
    }
});

test('download success and write failure both release the target and channel', async () => {
    for (const failWrite of [false, true]) {
        const {channel, payload, channels, cancellable, listeners} = fixture();
        const target = stream();
        if (failWrite)
            target.write_all_async = async () => { throw new Error('Disk full'); };
        const result = channel.download({payloadTransferInfo: {uuid}, payloadSize: 2},
            target, cancellable);
        if (failWrite)
            await assert.rejects(result, /Disk full/);
        else
            await result;
        assert.equal(target.closed, 1);
        assert.equal(payload.closed, true);
        assert.equal(channels.size, 0);
        assert.equal(listeners.size, 0);
    }
});

test('opening failure closes upload source and removes the partially opened channel', async () => {
    const {channel, channels, cancellable, listeners} = fixture();
    channels.clear();
    channel.mux.open = async id => {
        channels.set(id, {close() {}});
        throw new Error('Open failed');
    };
    const source = stream();
    await assert.rejects(channel.upload({}, source, 0, cancellable), /Open failed/);
    assert.equal(source.closed, 1);
    assert.equal(channels.size, 0);
    assert.equal(listeners.size, 0);
});

test('rejecting an ignored payload wakes a sender waiting for receive credit', async () => {
    const channel = Object.create(backend.Channel.prototype);
    channel.mux = new Multiplexer({write: async () => {}, close() {}});
    try {
        const payload = await channel.mux.open(uuid);
        const writer = payload.write(new Uint8Array([1]));
        channel.rejectTransfer({payloadTransferInfo: {uuid}});
        await assert.rejects(writer, /channel closed/);
        assert.equal(channel.mux.channels.has(uuid), false);
    } finally {
        channel.mux.close();
    }
});

test('upload cancellation is installed before open and closes the source on rejection', async () => {
    const {channel, channels, cancellable, listeners} = fixture();
    channels.clear();
    let rejectOpen;
    channel.mux.open = id => {
        assert.equal(listeners.size, 1);
        channels.set(id, {close() {}});
        return new Promise((resolve, reject) => { rejectOpen = reject; });
    };
    channel.close = () => rejectOpen(new Error('Connection closed'));
    const source = stream();
    const result = channel.upload({}, source, 0, cancellable);
    cancellable.cancel();
    await assert.rejects(result, /Connection closed/);
    assert.equal(source.closed, 1);
    assert.equal(channels.size, 0);
    assert.equal(listeners.size, 0);
});

test('already cancelled upload never opens a channel and still closes its source', async () => {
    const {channel, cancellable, listeners} = fixture();
    cancellable.cancel();
    channel.mux.open = () => assert.fail('must not open');
    const source = stream();
    await assert.rejects(channel.upload({}, source, 0, cancellable), /cancelled/);
    assert.equal(source.closed, 1);
    assert.equal(listeners.size, 0);
});

test('download cancellation wakes a blocked read and releases its target', async () => {
    const {channel, payload, channels, cancellable, listeners} = fixture();
    let rejectRead;
    payload.read = () => new Promise((resolve, reject) => { rejectRead = reject; });
    channel.close = () => rejectRead(new Error('Connection closed'));
    const target = stream();
    const result = channel.download({payloadTransferInfo: {uuid}, payloadSize: 2},
        target, cancellable);
    cancellable.cancel();
    await assert.rejects(result, /Connection closed/);
    assert.equal(target.closed, 1);
    assert.equal(payload.closed, true);
    assert.equal(channels.size, 0);
    assert.equal(listeners.size, 0);
});

test('upload success and invalid size both close the source', async () => {
    for (const size of [0, -1, NaN, '0']) {
        const {channel, channels, cancellable, listeners} = fixture();
        channels.clear();
        const source = stream();
        const result = channel.upload({}, source, size, cancellable);
        if (size === 0)
            await result;
        else
            await assert.rejects(result, /payload size/);
        assert.equal(source.closed, 1);
        assert.equal(channels.size, 0);
        assert.equal(listeners.size, 0);
    }
});

test('cached Bluetooth notification drains its payload before returning the cached icon', async () => {
    const file = {query_exists: () => true};
    const {default: Notification} = await loadModule('../src/service/plugins/notification.js', {
        'gi://Gio': {
            File: {new_for_path: () => file},
            FileIcon: class { constructor(params) { Object.assign(this, params); } },
        },
        'gi://GLib': {
            VariantType: class {},
            path_get_basename: value => value,
            build_filenamev: parts => parts.join('/'),
        },
    });
    const {channel, payload, channels} = fixture();
    Object.defineProperty(channel, 'address', {value: 'bluetooth://peer'});
    const plugin = Object.create(Notification.prototype);
    plugin.device = {channel, createTransfer() { assert.fail('cached icon must not be overwritten'); }};
    const icon = await plugin._downloadIcon({
        hasPayload: () => true,
        body: {payloadHash: 'cached'},
        payloadTransferInfo: {uuid},
        payloadSize: 4,
    });
    assert.equal(icon.file, file);
    assert.equal(payload.reads, 2);
    assert.equal(payload.closed, true);
    assert.equal(channels.size, 0);
});
