<!-- SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect -->
<!-- SPDX-License-Identifier: GPL-2.0-or-later -->

# Bluetooth in the Timpan4 fork

This fork implements the KDE Connect Bluetooth multiplexing v1 transport through
BlueZ Profile1. It is experimental. Protocol tests pass under Node; the GJS,
BlueZ, Android, and physical radio paths have not been run in this environment.
Do not interpret those tests as evidence that hardware interoperability works.

The backend registers the KDE Connect service UUID
`185f3df4-3268-4e3f-9fca-d4d5059915bd`. BlueZ allocates the RFCOMM channel.
It requests Bluetooth authentication and authorization. It only initiates
connections to already paired, unblocked devices advertising that service.
It does not power adapters, scan, pair Bluetooth devices, change trust settings,
or start BlueZ. Use the system Bluetooth UI for those actions.

GSConnect's ordinary discovery action tries the paired Bluetooth devices.
The existing manager reconnect loop retries saved `bluetooth://` object paths.
BlueZ restarts release all channels and trigger profile registration again.
New devices or newly enabled Android Bluetooth support may require another
discovery action. There is no properties-change discovery monitor in this port.

## Authentication and pairing

Bluetooth uses the authenticated, encrypted RFCOMM link provided by BlueZ.
Like the current KDE Bluetooth implementations, it does not wrap this link in
TLS. Both sides exchange their public certificate in the identity packet.
The device ID must equal the certificate common name. A remembered certificate
must match before the channel reaches the device manager. A mismatch rejects
the connection without silently replacing the pin or unpairing the device.
An old paired record without a certificate is rejected too.

Public certificates can be copied. To prevent a different Bluetooth-paired device
from claiming an existing GSConnect identity, approval over Bluetooth also saves
the BlueZ device object path. Reconnection requires both that path and the pinned
certificate. The path comes from BlueZ, not from the identity packet. Pending
GSConnect pair requests are cleared when the channel changes. Notification
responses carry a request token and require the originating channel. A queued
Accept or Reject for an old request cannot act on a replacement peer or start a
new outgoing pairing request.

A LAN-only pairing has no approved Bluetooth peer and is rejected over Bluetooth.
To enable Bluetooth for that device, unpair it in GSConnect and pair again over
Bluetooth, checking the system device and pairing prompts. This also permits later
LAN connections with the same certificate. Changing adapters or BlueZ object paths
requires pairing again. The backend never migrates this binding automatically.

The existing GSConnect pair request and user approval remain necessary.
Bluetooth pairing alone does not approve GSConnect plugins. The pairing UI now
computes the certificate verification key for Bluetooth too, and GSConnect pins
the certificate on approval. The security of this certificate exchange depends
on Bluetooth authentication. Verify the system pairing prompt and GSConnect
verification key on the actual devices.

## Features and limits

SMS and notifications use the existing plugins and packet handlers. This adds
their transport, not a second SMS implementation. Android still needs its
corresponding permissions, notification access, and Bluetooth option enabled.
Text, replies, notification icons, contact pictures, and attachments can use
the packet channel and UUID payload channels when supported by the peer.
Their actual behavior has not been checked with a phone.

Payloads stream over independent channels with flow control. The receive window
and outgoing frame chunk size are 4096 bytes, matching KDE Connect Android's
buffer contract. The wire header is 19 bytes, with big-endian lengths and UUIDs.
There is one reader and serialized frame writer per RFCOMM connection. Packet
writes are serialized separately so concurrent plugin requests cannot interleave
JSON lines. Partial reads and UTF-8 characters split across frames are supported.

Only known, nonnegative, JavaScript-safe integer payload sizes are supported.
Unknown-length streams are rejected. Cancellation conservatively closes the
Bluetooth connection, waking blocked packet and payload writers; reconnect can
restore the device. EOF, invalid control lengths, repeated/unsupported version
negotiation, duplicate OPEN, and writes beyond granted receive credit close the
connection. Remotely closed payload channels retain buffered data until claimed.

SFTP still requires IP networking and does not work over this transport.
There is no new Bluetooth settings UI or automatic LAN preference/failover policy.
The existing device manager selects the latest accepted channel. Bluetooth can
be slower than LAN. No throughput claim has been measured.

## Checks

Run the focused framework-independent Jasmine suite from the checkout:

```sh
node installed-tests/run-bluetooth-tests.mjs
node --experimental-vm-modules installed-tests/test-bluetooth-pairing.mjs
```

The runner uses the repository's bundled Jasmine implementation as a script,
adapting its export declaration because its GJS build expects global top-level
`this`. It runs the suites registered as `BluetoothMultiplexer` and
`BluetoothIdentity` in Meson.
Node's module-type warning is expected in this existing package layout.

The suite checks the official header bytes, byte-fragmented packet traffic across
multiple receive windows, separate payload channels, bad version negotiation,
uncredited writes, malformed control lengths, closure while awaiting credit,
and payload UUID validation. Authorization tests reject a copied certificate from
a different peer, missing Bluetooth approval, and missing or changed pins. They
allow the approved peer to reconnect and new peers to enter ordinary pairing.
The pairing check loads the complete device module with framework substitutes.
It covers incoming protocol 8 approval, stale Accept after channel replacement
and after a new request, and rejection of stale protocol 8 timestamps. The
timestamp check uses the active channel's identity and `Math.abs`.

Neither runner loads Gio, registers a BlueZ profile,
exercises certificate parsing, or tests the device pairing UI.

The source files and suite pass the repository ESLint configuration, including
its formatting rules. `git diff --check` passes. Node used here was v24.22.1.
GJS and Meson executables were unavailable, so no Meson build, GJS suite, full
plugin suite, or extension package validation was run. Dependencies were installed
in local `node_modules` without a lockfile change. npm reported seven moderate
development dependency vulnerabilities; dependencies were not upgraded in this task.

## Manual hardware validation still required

1. Build and run this fork on a supported GNOME/GJS system with BlueZ. Record
   GNOME, GJS, BlueZ, phone OS, and KDE Connect Android versions. Ensure another
   KDE Connect service is not claiming the same Bluetooth profile.
2. Enable Bluetooth support in KDE Connect Android and grant its requested
   permissions. Pair in the system Bluetooth UI, then use GSConnect discovery.
   Confirm that discovery works both when the phone connects first and when
   GSConnect requests ConnectProfile.
3. With Wi-Fi and other IP routes disabled on both devices, approve GSConnect
   pairing after comparing the verification keys. Confirm the saved connection
   is `bluetooth://...` and the device stays connected. Test rejection of pairing
   and verify unpaired devices cannot invoke plugins.
4. Send and receive SMS containing non-ASCII text. Check conversation sync and
   replies. Forward notifications with and without icons, reply to one, and
   dismiss one in each direction. Test attachments supported by the phone.
5. Transfer empty and multi-window payloads in both directions while sending
   notifications. Compare complete files. Cancel a transfer and confirm the
   connection closes, streams release, and reconnect succeeds.
6. Disconnect the phone, disable its radio, restart BlueZ, restart GSConnect,
   and suspend/resume the computer. Check reconnection and absence of leaked
   descriptors or stale channels. Repeat with simultaneous incoming/outgoing
   attempts and verify there is one active channel per BlueZ object path.
7. In an isolated test profile, present a changed certificate for the same device
   ID, a certificate with a different common name, and a paired record missing
   its pin. Confirm rejection without replacing the stored certificate. Verify
   ordinary LAN pairing still works and shares the same device identity. Try a
   second system-paired Bluetooth device with a copy of the approved phone's
   public identity and certificate. Confirm rejection before plugin activation.
   Confirm a LAN-only pairing requires unpairing and approving over Bluetooth.
   Switch channels while a pair request is pending and confirm the old approval
   cannot authorize the replacement channel.

## Sources inspected

GSConnect baseline was `61cc76b966f95a19d396fe0fc42a755fcb902bd4`.
References were inspected on 2026-11-02 through Git and GitHub's API.

* [GSConnect Bluetooth reference](https://github.com/GSConnect/gnome-shell-extension-gsconnect/tree/c012a27267fc9f5566d59c601452c92499e6a770/src/service/protocol),
  branch `bluetooth-multiplexing`, revision
  `c012a27267fc9f5566d59c601452c92499e6a770`. Its backend and multiplexing code
  target the old API and were used as references, not copied as a working backend.
* [KDE desktop Bluetooth sources and protocol](https://github.com/KDE/kdeconnect-kde/tree/c94448838b0eeca1f7b6ad06ec560bc2a5f69982/core/backends/bluetooth),
  revision `c94448838b0eeca1f7b6ad06ec560bc2a5f69982`. Inspected the protocol
  description, device link, provider wrapper, and provider implementation.
* [KDE Android Bluetooth sources](https://github.com/KDE/kdeconnect-android/tree/a23de6c5d836f568e7a94bae35d3eb4e63733882/src/main/java/org/kde/kdeconnect/backends/bluetooth),
  revision `a23de6c5d836f568e7a94bae35d3eb4e63733882`. Inspected the provider
  certificate exchange and ConnectionMultiplexer flow-control implementation.
* [BlueZ profile API](https://github.com/bluez/bluez/blob/14bd6ab65f4a647302edbd6df27f6faa91bee8a8/doc/org.bluez.Profile.rst),
  [profile manager API](https://github.com/bluez/bluez/blob/14bd6ab65f4a647302edbd6df27f6faa91bee8a8/doc/org.bluez.ProfileManager.rst),
  and [profile implementation](https://github.com/bluez/bluez/blob/14bd6ab65f4a647302edbd6df27f6faa91bee8a8/src/profile.c),
  revision `14bd6ab65f4a647302edbd6df27f6faa91bee8a8`, including automatic channel
  allocation and authenticated Profile1 descriptor delivery.
