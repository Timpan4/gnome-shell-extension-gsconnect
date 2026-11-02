// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Authorize an identity received on a BlueZ-authenticated connection.
 * Public certificate equality does not prove possession of its private key.
 *
 * @param {object} state - Current pairing state and authenticated peer
 * @param {boolean} state.paired - Whether GSConnect plugins are authorized
 * @param {string} state.approvedPeer - BlueZ path saved on user approval
 * @param {string} state.peer - BlueZ path supplied by Profile1.NewConnection
 * @param {boolean} state.hasCertificate - Whether a certificate pin exists
 * @param {boolean} state.certificateMatches - Whether the pin matches
 */
export function authorizePeer({paired, approvedPeer, peer, hasCertificate,
    certificateMatches}) {
    if (hasCertificate && !certificateMatches)
        throw new Error('Bluetooth certificate does not match paired device');
    if (paired && (!hasCertificate || !approvedPeer || approvedPeer !== peer))
        throw new Error('Bluetooth peer requires GSConnect pairing over Bluetooth');
}
