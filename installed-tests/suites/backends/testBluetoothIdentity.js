// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

const modulePath = import.meta.url.includes('/suites/backends/')
    ? '../../../src/service/backends/bluetoothIdentity.js'
    : `file://${(await import('../config.js')).default.PACKAGE_DATADIR}` +
      '/service/backends/bluetoothIdentity.js';
const {authorizePeer} = await import(modulePath);

describe('Bluetooth identity authorization', function () {
    const phone = '/org/bluez/hci0/dev_00_11_22_33_44_55';
    const other = '/org/bluez/hci0/dev_66_77_88_99_AA_BB';
    const paired = {
        paired: true,
        approvedPeer: phone,
        peer: phone,
        hasCertificate: true,
        certificateMatches: true,
    };

    it('rejects a copied public certificate from another Bluetooth peer', function () {
        expect(() => authorizePeer({...paired, peer: other})).toThrow();
        expect(() => authorizePeer(paired)).not.toThrow();
    });

    it('requires Bluetooth approval for a LAN-only pairing', function () {
        expect(() => authorizePeer({...paired, approvedPeer: ''})).toThrow();
    });

    it('rejects changed or missing certificates even for an approved peer', function () {
        expect(() => authorizePeer({...paired, certificateMatches: false})).toThrow();
        expect(() => authorizePeer({...paired, hasCertificate: false})).toThrow();
    });

    it('allows an unpaired peer to reach the ordinary GSConnect pairing flow', function () {
        expect(() => authorizePeer({
            paired: false,
            approvedPeer: '',
            peer: other,
            hasCertificate: false,
            certificateMatches: false,
        })).not.toThrow();
    });
});
