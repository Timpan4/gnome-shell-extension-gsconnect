// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import * as Core from '../core.js';
import Device from '../device.js';
import {BUFFER_SIZE, DEFAULT_CHANNEL, Multiplexer} from './bluetoothMultiplexer.js';
import {authorizePeer} from './bluetoothIdentity.js';

const SERVICE_UUID = '185f3df4-3268-4e3f-9fca-d4d5059915bd';
const PROFILE_PATH = '/org/gnome/Shell/Extensions/GSConnect/Bluetooth';
const PROFILE_XML = `<node><interface name="org.bluez.Profile1">
<method name="Release"/>
<method name="NewConnection">
<arg type="o" direction="in"/><arg type="h" direction="in"/>
<arg type="a{sv}" direction="in"/></method>
<method name="RequestDisconnection"><arg type="o" direction="in"/></method>
</interface></node>`;

/**
 * Remove capabilities that require an IP connection.
 *
 * @param {Core.Packet} identity - A validated identity packet
 */
function removeNetworkCapabilities(identity) {
    for (const key of ['incomingCapabilities', 'outgoingCapabilities']) {
        identity.body[key] = identity.body[key].filter(type =>
            type !== 'kdeconnect.sftp' && type !== 'kdeconnect.sftp.request');
    }
}

// Keep callbacks explicit for APIs not promisified by service/init.js.
/**
 * Read a byte chunk without changing the application's promise wrappers.
 *
 * @param {Gio.InputStream} stream - The source stream
 * @param {number} count - Maximum bytes to read
 * @param {Gio.Cancellable} cancellable - Operation cancellation
 * @returns {Promise<Uint8Array>} The bytes read
 */
function readBytes(stream, count, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(count, GLib.PRIORITY_DEFAULT, cancellable, (object, result) => {
            try {
                resolve(object.read_bytes_finish(result).toArray());
            } catch (error) {
                reject(error);
            }
        });
    });
}

export const ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannelService',
}, class BluetoothChannelService extends Core.ChannelService {
    _init(params = {}) {
        super._init(params);
        this.channels = new Map();
        this._pending = new Set();
        this._watch = 0;
        this._owner = null;
        this._profile = null;
    }

    _call(path, iface, method, parameters, cancellable = this.cancellable) {
        return this._bus.call(this._owner, path, iface, method, parameters,
            null, Gio.DBusCallFlags.NONE, -1, cancellable);
    }

    buildIdentity() {
        super.buildIdentity();
        removeNetworkCapabilities(this.identity);
    }

    start() {
        if (this.active)
            return;
        this._cancellable = new Gio.Cancellable();
        this.certificate = Gio.TlsCertificate.new_from_files(
            GLib.build_filenamev([Config.CONFIGDIR, 'certificate.pem']),
            GLib.build_filenamev([Config.CONFIGDIR, 'private.pem']));
        this._active = true;
        this.notify('active');
        this._watch = Gio.bus_watch_name(Gio.BusType.SYSTEM, 'org.bluez',
            Gio.BusNameWatcherFlags.NONE,
            (bus, name, owner) => {
                this._bus = bus;
                this._owner = owner;
                this._register(owner).catch(error => debug(error));
            }, () => this._release());
    }

    async _register(owner) {
        const profile = Gio.DBusExportedObject.wrapJSObject(PROFILE_XML, this);
        this._profile = profile;
        profile.export(this._bus, PROFILE_PATH);
        try {
            await this._call('/org/bluez', 'org.bluez.ProfileManager1', 'RegisterProfile',
                new GLib.Variant('(osa{sv})', [PROFILE_PATH, SERVICE_UUID, {
                    Name: new GLib.Variant('s', 'KDE Connect'),
                    // BlueZ treats zero as automatic RFCOMM channel allocation.
                    Channel: new GLib.Variant('q', 0),
                    RequireAuthentication: new GLib.Variant('b', true),
                    RequireAuthorization: new GLib.Variant('b', true),
                }]));
            if (this.active && this._owner === owner)
                this.broadcast();
        } catch (error) {
            if (this._profile === profile) {
                profile.unexport();
                this._profile = null;
            }
            throw error;
        }
    }

    _release() {
        this._owner = null;
        for (const channel of this.channels.values())
            channel.close();
        this._pending.clear();
        this._profile?.unexport();
        this._profile = null;
    }

    ReleaseAsync(parameters, invocation) {
        if (invocation.get_sender() !== this._owner) {
            invocation.return_dbus_error('org.bluez.Error.Rejected', 'Invalid caller');
            return;
        }
        this._release();
        invocation.return_value(null);
    }

    RequestDisconnectionAsync([path], invocation) {
        if (invocation.get_sender() !== this._owner) {
            invocation.return_dbus_error('org.bluez.Error.Rejected', 'Invalid caller');
            return;
        }
        this.channels.get(`bluetooth://${path}`)?.close();
        invocation.return_value(null);
    }

    NewConnectionAsync([path, handle], invocation) {
        if (!this.active || invocation.get_sender() !== this._owner) {
            invocation.return_dbus_error('org.bluez.Error.Rejected', 'Invalid caller');
            return;
        }
        let channel;
        try {
            const fd = invocation.get_message().get_unix_fd_list().get(handle);
            let socket;
            try {
                socket = Gio.Socket.new_from_fd(fd);
            } catch (error) {
                GLib.close(fd);
                throw error;
            }
            const connection = new Gio.SocketConnection({socket});
            if (this.channels.has(`bluetooth://${path}`)) {
                connection.close(null);
                throw new Error('Duplicate Bluetooth connection');
            }
            channel = new Channel({backend: this, path, connection});
            this.channels.set(channel.address, channel);
            invocation.return_value(null);
            channel.negotiate().then(() => {
                if (!channel.closed && this.active)
                    this.channel(channel);
            }).catch(error => {
                channel.close();
                debug(error);
            });
        } catch (error) {
            channel?.close();
            invocation.return_dbus_error('org.bluez.Error.Rejected', error.message);
        }
    }

    broadcast(address = null) {
        if (!this.active || !this._owner || !this._profile)
            return;
        this._connectDevices(address).catch(error => debug(error));
    }

    async _connectDevices(address) {
        const owner = this._owner;
        const reply = await this._call('/', 'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects', null);
        if (!this.active || this._owner !== owner)
            return;
        for (const [path, interfaces] of Object.entries(reply.deepUnpack()[0])) {
            const props = interfaces['org.bluez.Device1'];
            if (!props || (address !== null && address !== path) ||
                !props.Paired?.deepUnpack() || props.Blocked?.deepUnpack() ||
                !props.UUIDs?.deepUnpack().includes(SERVICE_UUID) ||
                this.channels.has(`bluetooth://${path}`) || this._pending.has(path))
                continue;
            this._pending.add(path);
            this._call(path, 'org.bluez.Device1', 'ConnectProfile',
                new GLib.Variant('(s)', [SERVICE_UUID]))
                .catch(error => debug(error))
                .finally(() => this._pending.delete(path));
        }
    }

    stop() {
        if (!this.active)
            return;
        this._active = false;
        this.notify('active');
        if (this._watch)
            Gio.bus_unwatch_name(this._watch);
        this._watch = 0;
        if (this._owner && this._profile) {
            this._call('/org/bluez', 'org.bluez.ProfileManager1', 'UnregisterProfile',
                new GLib.Variant('(o)', [PROFILE_PATH]), null).catch(error => debug(error));
        }
        this.cancellable.cancel();
        this._release();
    }

    destroy() {
        this.stop();
    }
});

export const Channel = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannel',
}, class BluetoothChannel extends Core.Channel {
    _init({backend, path, connection}) {
        super._init();
        this.backend = backend;
        this.path = path;
        this._connection = connection;
        this._lines = new Uint8Array();
        this._packets = Promise.resolve();
        this.mux = new Multiplexer({
            read: count => readBytes(connection.input_stream, count, this.cancellable),
            write: bytes => connection.output_stream.write_all_async(bytes,
                GLib.PRIORITY_DEFAULT, this.cancellable),
            close: () => {
                this.cancellable.cancel();
                connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
            },
        }, () => this.close());
        this._main = this.mux.channels.get(DEFAULT_CHANNEL);
    }

    get address() {
        return `bluetooth://${this.path}`;
    }

    async negotiate() {
        this.mux.start();
        // Both peers may send first; a client may also wait for our identity.
        const identity = new Core.Packet(JSON.parse(JSON.stringify(this.backend.identity)));
        identity.body.certificate = this.backend.certificate.certificate_pem;
        const sent = this.sendPacket(identity);
        sent.catch(() => this.close());
        try {
            this.identity = await this.readPacket();
            const body = this.identity.body;
            if (this.identity.type !== 'kdeconnect.identity' || !body ||
                typeof body.deviceId !== 'string' || !Device.validateId(body.deviceId) ||
                body.deviceId === this.backend.id || typeof body.deviceName !== 'string' ||
                !body.deviceName || !Number.isInteger(body.protocolVersion) ||
                !Array.isArray(body.incomingCapabilities) ||
                !body.incomingCapabilities.every(type => typeof type === 'string') ||
                !Array.isArray(body.outgoingCapabilities) ||
                !body.outgoingCapabilities.every(type => typeof type === 'string') ||
                typeof body.certificate !== 'string')
                throw new Error('Invalid Bluetooth identity');
            body.deviceName = Device.sanitizeName(body.deviceName);
            this.peer_certificate = Gio.TlsCertificate.new_from_pem(body.certificate, -1);
            if (this.peer_certificate.common_name !== body.deviceId)
                throw new Error('Bluetooth certificate identity mismatch');
            const settings = new Gio.Settings({
                settings_schema: Config.GSCHEMA.lookup(
                    'org.gnome.Shell.Extensions.GSConnect.Device', true),
                path: `/org/gnome/shell/extensions/gsconnect/device/${body.deviceId}/`,
            });
            removeNetworkCapabilities(this.identity);
            await sent;
            // Recheck immediately before emitting the channel. Pairing may have
            // changed while the identity write was waiting for receive credit.
            const pem = settings.get_string('certificate-pem');
            authorizePeer({
                paired: settings.get_boolean('paired'),
                approvedPeer: settings.get_string('bluetooth-peer'),
                peer: this.path,
                hasCertificate: pem !== '',
                certificateMatches: pem !== '' && this.peer_certificate.is_same(
                    Gio.TlsCertificate.new_from_pem(pem, -1)),
            });
        } catch (error) {
            this.close();
            await sent.catch(() => {});
            throw error;
        }
    }

    async readPacket() {
        while (true) {
            const end = this._lines.indexOf(10);
            if (end !== -1) {
                const line = this._lines.slice(0, end);
                this._lines = this._lines.slice(end + 1);
                return new Core.Packet(new TextDecoder('utf-8', {fatal: true}).decode(line));
            }
            const chunk = await this._main.read();
            const bytes = new Uint8Array(this._lines.length + chunk.length);
            bytes.set(this._lines);
            bytes.set(chunk, this._lines.length);
            this._lines = bytes;
        }
    }

    sendPacket(packet) {
        const bytes = new TextEncoder().encode(packet.serialize());
        const sent = this._packets.then(() => this._main.write(bytes));
        this._packets = sent.catch(() => {});
        return sent;
    }

    async _payload(channel, stream, operation, cancellable) {
        // Closing RFCOMM also wakes a packet write waiting for main credit.
        const cancel = () => this.close();
        const id = cancellable?.connect(cancel);
        try {
            if (cancellable?.is_cancelled())
                throw new Error('Bluetooth transfer cancelled');
            return await operation();
        } finally {
            if (id)
                cancellable.disconnect(id);
            channel.close();
            this.mux.channels.delete(channel.uuid);
            await stream.close_async(GLib.PRIORITY_DEFAULT, null).catch(error => debug(error));
        }
    }

    async download(packet, target, cancellable = null) {
        const channel = this.mux.claim(packet.payloadTransferInfo?.uuid);
        if (!Number.isSafeInteger(packet.payloadSize) || packet.payloadSize < 0) {
            channel.close();
            throw new Error('Unsupported Bluetooth payload size');
        }
        await this._payload(channel, target, async () => {
            let remaining = packet.payloadSize;
            while (remaining > 0) {
                const bytes = await channel.read();
                if (bytes.length > remaining)
                    throw new Error('Bluetooth payload exceeds declared size');
                await target.write_all_async(bytes, GLib.PRIORITY_DEFAULT,
                    cancellable ?? this.cancellable);
                remaining -= bytes.length;
            }
        }, cancellable);
    }

    async upload(packet, source, size, cancellable = null) {
        if (!Number.isSafeInteger(size) || size < 0)
            throw new Error('Unsupported Bluetooth payload size');
        const channel = await this.mux.open(GLib.uuid_string_random());
        await this._payload(channel, source, async () => {
            packet.payloadSize = size;
            packet.payloadTransferInfo = {uuid: channel.uuid};
            await this.sendPacket(packet);
            let remaining = size;
            while (remaining > 0) {
                const bytes = await readBytes(source, Math.min(BUFFER_SIZE, remaining),
                    cancellable ?? this.cancellable);
                if (bytes.length === 0)
                    throw new Error('Bluetooth payload ended before declared size');
                await channel.write(bytes);
                remaining -= bytes.length;
            }
        }, cancellable);
    }

    rejectTransfer(packet) {
        try {
            const channel = this.mux.claim(packet.payloadTransferInfo?.uuid);
            channel.close();
            this.mux.channels.delete(channel.uuid);
        } catch (error) {
            debug(error);
        }
    }

    close() {
        if (this.closed)
            return;
        this._closed = true;
        this.mux.close();
        if (this.backend.channels.get(this.address) === this)
            this.backend.channels.delete(this.address);
        this.notify('closed');
    }
});
