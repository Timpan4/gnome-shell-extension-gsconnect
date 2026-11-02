// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

// Exercise the complete device module with framework substitutes, without GJS.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {URL} from 'node:url';
import {test} from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/service/device.js', import.meta.url), 'utf8');

/**
 * Load real device methods with fake framework boundaries and a Bluetooth peer.
 * @returns {Promise<object>} Device and observable effects
 */
async function fixture() {
    const errors = [];
    const context = vm.createContext({
        logError: error => errors.push(error),
        debug: error => errors.push(error),
        _: value => value,
    });
    vm.runInContext('String.prototype.format = function () { return String(this); };', context);
    let timer = 0;
    class Variant {
        constructor(type, value) {
            this.value = value;
        }

        unpack() {
            return this.value;
        }
    }
    const Gio = {
        SimpleActionGroup: class {},
        ThemedIcon: class {},
        NotificationPriority: {URGENT: 0},
        IOErrorEnum: {CANCELLED: 0},
    };
    const GLib = {
        uuid_string_random: randomUUID,
        Variant,
        PRIORITY_DEFAULT: 0,
        timeout_add_seconds: () => ++timer,
        source_remove() {},
    };
    const GObject = {
        registerClass: (options, implementation) => implementation,
        ParamSpec: {boolean() {}, object() {}, string() {}},
        ParamFlags: {READABLE: 0},
        Object: class {},
    };
    const module = new vm.SourceTextModule(source, {context});
    await module.link(specifier => {
        if (specifier === './core.js') {
            return new vm.SyntheticModule(['Packet'], function () {
                this.setExport('Packet', class {
                    constructor(packet) {
                        if (packet.invalid)
                            throw new Error('Invalid packet');
                        Object.assign(this, packet);
                    }
                });
            }, {context});
        }
        const value = {'gi://Gio': Gio, 'gi://GLib': GLib, 'gi://GObject': GObject}[specifier];
        return new vm.SyntheticModule(['default'], function () {
            this.setExport('default', value ?? {});
        }, {context});
    });
    await module.evaluate();
    const device = Object.create(module.namespace.default.prototype);
    const values = new Map([['paired', false], ['certificate-pem', '']]);
    const packets = [];
    const notifications = [];
    const peer = path => ({
        path,
        address: `bluetooth://${path}`,
        identity: {body: {protocolVersion: 8}},
        peer_certificate: {certificate_pem: 'public certificate'},
        closed: false,
        close() { this.closed = true; },
    });
    Object.assign(device, {
        _channel: peer('/org/bluez/hci0/dev_00_11_22_33_44_55'),
        _connected: true,
        _incomingPairRequest: 0,
        _outgoingPairRequest: 0,
        _procs: new Set(),
        _transfers: new Map(),
        _handlers: new Map(),
        _outputLock: false,
        _outputQueue: [],
        settings: {
            get_string: key => values.get(key) ?? '',
            get_boolean: key => values.get(key) ?? false,
            set_string: (key, value) => values.set(key, value),
            set_boolean: (key, value) => values.set(key, value),
            reset: key => values.delete(key),
        },
        notify() {},
        hideNotification() {},
        showNotification: value => notifications.push(value),
        sendPacket: packet => packets.push(packet),
        _handleIdentity() {},
        _readLoop() {},
        _loadPlugins() {},
    });
    // Fingerprint rendering needs OpenSSL and is outside the pairing contract.
    Object.defineProperty(device, 'encryption_info', {value: 'verification key'});
    device.settings.set_string('last-connection', device.channel.address);
    return {device, values, packets, notifications, errors, peer, Variant};
}

test('accepting protocol 8 pairing approves and binds the originating peer', async () => {
    const {device, values, notifications, errors} = await fixture();
    device._notifyPairRequest(Math.floor(Date.now() / 1000));
    const response = notifications.at(-1).buttons.find(button => button.action === 'acceptPair');
    device._respondPair(true, null, response.parameter);
    assert.equal(values.get('paired'), true);
    assert.equal(values.get('bluetooth-peer'), device.channel.path);
    assert.equal(errors.length, 0);
});

test('stale Accept neither approves nor initiates pairing with a replacement peer', async () => {
    const {device, values, packets, notifications, peer} = await fixture();
    device._notifyPairRequest(Math.floor(Date.now() / 1000));
    const stale = notifications.at(-1).buttons.find(button => button.action === 'acceptPair');
    device.setChannel(peer('/org/bluez/hci0/dev_66_77_88_99_AA_BB'));
    device._respondPair(true, null, stale.parameter);
    assert.equal(packets.length, 0);
    assert.equal(values.get('paired'), false);
    assert.equal(values.has('bluetooth-peer'), false);
    // A new request on that peer must not make the previous token valid again.
    device._notifyPairRequest(Math.floor(Date.now() / 1000));
    device._respondPair(true, null, stale.parameter);
    assert.equal(packets.length, 0);
    assert.equal(values.get('paired'), false);
});

test('expired protocol 8 timestamps cannot approve pairing', async () => {
    const {device, values, notifications, errors} = await fixture();
    device._notifyPairRequest(0);
    const response = notifications.at(-1).buttons.find(button => button.action === 'acceptPair');
    device._respondPair(true, null, response.parameter);
    assert.equal(values.get('paired'), false);
    assert.equal(values.has('bluetooth-peer'), false);
    assert.equal(errors.length, 0);
});

test('nonnumeric and nonfinite protocol 8 timestamps cannot approve pairing', async () => {
    for (const timestamp of [NaN, Infinity, -Infinity,
        String(Math.floor(Date.now() / 1000)), null, {}, []]) {
        const {device, values, errors} = await fixture();
        device._notifyPairRequest(timestamp);
        device.pair();
        assert.equal(values.get('paired'), false);
        assert.equal(values.has('bluetooth-peer'), false);
        assert.equal(errors.length, 0);
    }
});

test('native send failure releases the queue and reconnect sends queued packets', async () => {
    const {device, values, peer, errors} = await fixture();
    delete device.sendPacket;
    values.set('paired', true);
    let fail;
    device.channel.sendPacket = () => new Promise((resolve, reject) => { fail = reject; });
    const first = device.sendPacket({type: 'first'});
    // A concurrent caller that fails before queue admission must not unlock it.
    await device.sendPacket({type: 'invalid', invalid: true});
    assert.equal(device._outputLock, true);
    const replacement = peer('/org/bluez/hci0/dev_new');
    const sent = [];
    replacement.sendPacket = async packet => sent.push(packet.type);
    device.setChannel(replacement);
    await device.sendPacket({type: 'second'});
    assert.equal(sent.length, 0);
    fail(new Error('RFCOMM closed'));
    await first;
    assert.deepEqual(sent, ['second']);
    assert.equal(device._outputLock, false);
    await device.sendPacket({type: 'third'});
    assert.deepEqual(sent, ['second', 'third']);
    assert.equal(errors.some(error => error.message === 'RFCOMM closed'), true);
});

test('unpaired and unsupported packets reject their attached payloads', async () => {
    const {device, values} = await fixture();
    const rejected = [];
    device.channel.rejectTransfer = packet => rejected.push(packet);
    device.unpair = () => {};
    const packet = {type: 'kdeconnect.notification', hasPayload: () => true};
    device.handlePacket(packet);
    values.set('paired', true);
    device.handlePacket(packet);
    assert.deepEqual(rejected, [packet, packet]);
});

test('a replaced channel read loop cannot consume or dispatch the new channel packets', async () => {
    const {device, peer} = await fixture();
    delete device._readLoop;
    let resolveOld;
    const previous = device.channel;
    previous.readPacket = () => new Promise(resolve => { resolveOld = resolve; });
    const handled = [];
    device.handlePacket = packet => handled.push(packet);
    const oldLoop = device._readLoop(previous);
    const replacement = peer('/org/bluez/hci0/dev_new');
    replacement.readPacket = () => assert.fail('old loop must not read replacement');
    // Model replacement after the old read resolves, before its continuation.
    resolveOld({type: 'old'});
    device._channel = replacement;
    await oldLoop;
    assert.equal(handled.length, 0);
    assert.equal(device.channel, replacement);
});
