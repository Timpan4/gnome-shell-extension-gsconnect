<!-- SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect -->
<!-- SPDX-License-Identifier: GPL-2.0-or-later -->

# Install the Bluetooth fork on Fedora

Use this guide on DNF-based Fedora Workstation, logged into GNOME as your normal
user. You need an Android phone with KDE Connect and a working Bluetooth adapter.
The extension installs for your user. Only the dependency installation uses sudo.
Run the steps in order and stop if a command reports an error.

This is an experimental fork. Its automated checks pass, but the procedure and
Bluetooth interoperability have not been run on Fedora or a physical phone by the
fork author. Installing successfully does not prove SMS or notifications work.
The last section explains how to return to your previous installation.

## 1. Check your desktop

Open Terminal and run:

```sh
gnome-shell --version
```

This checkout declares GNOME Shell 46, 47, 48, 49, 50, and 51 in
[metadata.json.in](data/metadata.json.in). The declaration is not a hardware test.
If your major version is absent, stop rather than disabling version validation.
This guide is for GNOME, not a Plasma session, and its DNF commands are not an
Atomic Desktop package-layering procedure.

On the computer, GSConnect replaces the KDE Connect desktop application. If you
already use KDE Connect on Fedora, quit it and turn off its desktop autostart
before proceeding. Keep KDE Connect installed on the phone. Avoid running both
desktop implementations at the same time, since they claim the same protocol.
See [upstream installation requirements](https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Installation#dependencies).

## 2. Install dependencies

Run this in Terminal, then review DNF's proposed transaction before accepting it:

```sh
sudo dnf install git gcc meson ninja-build gettext glib2-devel zip unzip \
    gjs gtk3 openssl openssh-clients bluez dconf
```

Meson and Ninja build the extension ZIP. GLib's build tools compile the resources
and settings schema, and gettext builds translations. GJS, GTK 3, OpenSSL and
BlueZ support the service at runtime. The GNOME session supplies the Shell and
its preferences libraries. Package names are based on Fedora's
[Meson](https://packages.fedoraproject.org/pkgs/meson/meson/),
[Ninja](https://packages.fedoraproject.org/pkgs/ninja-build/ninja-build/),
[GLib development tools](https://packages.fedoraproject.org/pkgs/glib2/glib2-devel/),
[GJS](https://packages.fedoraproject.org/pkgs/gjs/gjs/),
[GTK 3](https://packages.fedoraproject.org/pkgs/gtk3/gtk3/), and
[BlueZ](https://packages.fedoraproject.org/pkgs/bluez/bluez/) packages.

## 3. Download and build this branch

Use a new directory. If `gsconnect-bluetooth` already exists, choose another name
in both the clone and cd commands instead of overwriting it.

```sh
git clone --branch feat/bluetooth-transport --single-branch \
    https://github.com/Timpan4/gnome-shell-extension-gsconnect.git gsconnect-bluetooth
cd gsconnect-bluetooth
git log -1 --oneline
```

Check that you cloned `Timpan4` and selected `feat/bluetooth-transport`. Installing
the stock Fedora package or upstream ZIP will not install this Bluetooth patch.

Configure the build with Fedora's library directory, then create the ZIP:

```sh
meson setup _build --prefix=/usr \
    -Dgnome_shell_libdir="$(rpm --eval '%{_libdir}')" \
    -Dinstalled_tests=false
ninja -C _build make-zip
unzip -t _build/gsconnect@andyholmes.github.io.zip
unzip -l _build/gsconnect@andyholmes.github.io.zip service/backends/bluetooth.js
```

The ZIP should pass its integrity check and contain `service/backends/bluetooth.js`.
Stop if either check fails. The `make-zip` target stages files under `_build`;
`--prefix=/usr` does not install files into the system during this step.
These commands follow the repository's [Meson targets](meson.build) and
[ZIP builder](build-aux/ego/mkzip.sh). No npm install is needed to build the ZIP.

## 4. Preserve your current installation

If GSConnect is already installed, close its preferences window and disable it:

```sh
gnome-extensions disable gsconnect@andyholmes.github.io
```

On a new installation, skip that command. Create a private backup and copy any
existing identity and settings into it:

```sh
backup_dir="$HOME/gsconnect-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$backup_dir"
dconf dump /org/gnome/shell/extensions/gsconnect/ > "$backup_dir/settings.dconf"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/gsconnect"
if [ -d "$config_dir" ]; then
    cp -a "$config_dir" "$backup_dir/config"
fi
user_ext="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/gsconnect@andyholmes.github.io"
if [ -d "$user_ext" ]; then
    mv "$user_ext" "$backup_dir/extension"
fi
printf 'Keep this backup path: %s\n' "$backup_dir"
```

Record the printed path for rollback. The backup may contain your private device
key, so keep it private. The move preserves an existing user extension and makes
room for the fork. A Fedora RPM under `/usr/share` is left intact. Do not remove
the GSConnect configuration directory or reset its settings.

## 5. Install and enable the fork

Still inside `gsconnect-bluetooth`, run without sudo:

```sh
gnome-extensions install _build/gsconnect@andyholmes.github.io.zip
```

If it reports an existing user installation, stop and check step 4. Do not bypass
the error with an overwrite flag.

Save your work, log out of GNOME, and log back in. This loads the new code and
avoids retaining an older service from your session. Logging out is the normal
Wayland reload path in the [upstream ZIP instructions](https://github.com/GSConnect/gnome-shell-extension-gsconnect/wiki/Installation#install-from-zip).

Open Terminal again and run:

```sh
gnome-extensions enable gsconnect@andyholmes.github.io
gnome-extensions info gsconnect@andyholmes.github.io
gnome-extensions prefs gsconnect@andyholmes.github.io
```

The extension should be enabled and its Path should point into your user's
`gnome-shell/extensions/gsconnect@andyholmes.github.io` directory. Confirm the
Bluetooth module is installed there:

```sh
test -f "${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/gsconnect@andyholmes.github.io/service/backends/bluetooth.js" \
    && echo 'Bluetooth backend is installed'
```

If preferences show an error or the extension is not enabled, use troubleshooting
below before pairing. Do not accept an extension update from the public extension
catalog while testing this fork; it uses the same extension UUID.

## 6. Pair Bluetooth, then pair GSConnect

These are separate approvals. A system Bluetooth pairing alone does not authorize
GSConnect plugins.

1. On Android, install or update KDE Connect from
   [Google Play](https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp)
   or [F-Droid](https://f-droid.org/packages/org.kde.kdeconnect_tp/).
2. In KDE Connect's settings, enable its Bluetooth backend and grant the requested
   Nearby devices/Bluetooth permission. Labels can vary by Android/app version.
   See the [Android Bluetooth setting and permission flow](https://github.com/KDE/kdeconnect-android/blob/master/src/main/java/org/kde/kdeconnect/ui/SettingsFragment.kt#L219-L237).
3. On Fedora, open Settings, then Bluetooth. Turn it on, select your phone, and
   confirm the matching pairing code on both devices. Leave KDE Connect open.
4. If this phone was already paired to GSConnect over Wi-Fi, unpair it in GSConnect
   and KDE Connect before the next step. Leave the system Bluetooth pairing in
   place. This fork deliberately refuses to reuse LAN approval as Bluetooth
   approval. Existing saved Bluetooth pairings from older experiments also need
   approval again if they lack the peer binding.
5. Temporarily turn off Wi-Fi on both devices and disconnect the computer's
   Ethernet or other IP connection. Leave Bluetooth on and leave the phone's
   cellular service available for SMS. Do not use airplane mode.
6. Open GSConnect preferences and use its refresh/discovery action. Refresh the
   device list in KDE Connect too. Select the computer and request pairing.
7. Check the device names and compare the verification key on both ends. Accept
   the request only for your phone. Both applications should show a paired device.
   Keep the clocks on both devices correct; protocol 8 pairing checks timestamps.

If discovery shows nothing, follow the checks below. Wi-Fi is not required for
this fork's Bluetooth path, and opening firewall ports does not fix RFCOMM.

## 7. Verify Bluetooth-only operation

Keep the IP connections disconnected while checking these actions:

1. Use Ring/Find my phone from GSConnect. Confirm the phone responds.
2. On Android, enable KDE Connect notification access and allow the relevant
   plugin. Generate a new notification and check that it appears on Fedora.
3. Grant KDE Connect its SMS permissions. Open GSConnect's messaging window and
   check conversation sync. If you send a test SMS, use a recipient you choose;
   your carrier's normal charges may apply.
4. Send a small file through the applications, then check its contents at the
   destination. Also test cancelling a transfer; this fork currently disconnects
   Bluetooth when a transfer is cancelled, then reconnects.

For a direct connection check, list the saved GSConnect device IDs:

```sh
dconf list /org/gnome/shell/extensions/gsconnect/device/
```

Choose the relevant ID, omit its trailing slash, and replace `DEVICE_ID` below:

```sh
dconf read /org/gnome/shell/extensions/gsconnect/device/DEVICE_ID/last-connection
```

The result should begin with `'bluetooth://`. A `'lan://` result is a LAN record,
not evidence of Bluetooth connectivity. Combine this check with successful actions
while the IP links are disconnected. Re-enable networking after the test.

SFTP browsing needs an IP connection. Unknown-length payloads are unsupported.
Bluetooth speed and phone interoperability have not been measured or verified by
the fork author. See [BLUETOOTH.md](BLUETOOTH.md) for the validation checklist.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Build cannot find a C compiler, GLib tools, or msgfmt | Confirm step 2 completed successfully. Use `gcc --version`, `glib-compile-resources --version`, and `msgfmt --version`. |
| Extension is missing after installation | Log out and back in, then run `gnome-extensions info` again. Check GNOME compatibility and the install command's output. |
| Waiting for service or preferences fail | Confirm GJS, GTK 3 and OpenSSL are installed. Check the logs below and the loaded extension Path. |
| Phone is system-paired but absent in GSConnect | Enable Android's Bluetooth backend, grant permissions, keep its app open, and refresh both device lists. Confirm Bluetooth is powered and the phone is not blocked. |
| Pairing was rejected after previous Wi-Fi use | Unpair at the GSConnect/KDE Connect level, then pair again over Bluetooth. Do not delete pins or manually fill in `bluetooth-peer`. |
| Pairing broke after changing adapters | The saved approval is bound to a BlueZ peer path. Unpair and approve again on the new adapter. |
| SMS or notifications alone fail | Check Android permissions, notification access and each plugin toggle on both devices. Confirm Ring works over Bluetooth first. |

Read-only diagnostics:

```sh
systemctl status bluetooth.service --no-pager
bluetoothctl show
journalctl --user -b --no-pager -g 'GSConnect|gsconnect|Bluetooth'
```

If Bluetooth is not running, use Fedora's Bluetooth settings and normal service
administration to address it. The fork does not power adapters or start BlueZ.
Do not disable SELinux or loosen D-Bus policy to work around an error. Review logs
for phone numbers, device names, and message content before sharing them.

## Updating the fork

From your clone, check for local changes before pulling:

```sh
git status --short
```

If status lists changes, stop and preserve your work before updating. Otherwise:

```sh
git pull --ff-only
meson setup --reconfigure _build
ninja -C _build make-zip
```

If Git reports a conflict, stop. Do not reset or force the update.
Repeat steps 4 and 5 with a new backup to
replace the installed user extension, then log out and back in.

## Return to your previous installation

1. Close GSConnect preferences and disable the fork:

   ```sh
   gnome-extensions disable gsconnect@andyholmes.github.io
   ```

2. Open Files and enable hidden files with Ctrl+H. Navigate to
   `~/.local/share/gnome-shell/extensions/`, or the corresponding directory under
   your custom `XDG_DATA_HOME`. Move the fork's `gsconnect@andyholmes.github.io`
   folder to a separate folder outside `extensions` to retain it.
3. If step 4 saved an `extension` folder, copy it back into the extensions
   directory and rename the copy exactly `gsconnect@andyholmes.github.io`. If you
   previously used Fedora's RPM, leave the user folder absent so GNOME can load
   the system copy. If you had no previous installation, leave the fork disabled.
4. Save your work, log out, and log back in. Enable GSConnect again if restoring
   a previous copy. Confirm its Path with `gnome-extensions info`.

Keep the configuration and settings backups. These steps preserve them and do not
overwrite current settings. A restored version may require pairing your devices
again. Restore configuration backups only as a deliberate separate recovery step.

## Guide verification

Commands were checked against this branch's build scripts and current primary
sources on 2026-11-02. The Fedora installation, login, pairing and hardware steps
have not been executed by the author. The code has 40 passing focused tests;
those tests are not a substitute for following the Bluetooth-only checks above.
