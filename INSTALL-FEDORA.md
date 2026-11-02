<!-- SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect -->
<!-- SPDX-License-Identifier: GPL-2.0-or-later -->

# Install the Bluetooth fork on Fedora

This guide installs the Timpan4 Bluetooth fork of GSConnect for your user on
Fedora Workstation with GNOME. You need an Android phone with KDE Connect and a
working Bluetooth adapter. Fedora Atomic desktops such as Silverblue are not
covered.

The fork is experimental. Its installation and Bluetooth connection have not been
tested on Fedora or with a real phone. Technical limits are listed in
[BLUETOOTH.md](BLUETOOTH.md).

Run the steps in order in Terminal and stop if a command fails.

## 1. Check GNOME

```sh
gnome-shell --version
```

This build declares support for GNOME Shell 46, 47, 48, 49, 50 and 51. If your
major version is not in that list, stop.

If you use the KDE Connect desktop app on this computer, quit it and turn off its
autostart. It conflicts with GSConnect. Keep KDE Connect on the phone.

## 2. Install build tools

```sh
sudo dnf install git gcc meson ninja-build gettext glib2-devel zip unzip \
    gjs gtk3 openssl openssh-clients bluez dconf
```

Review the package list before you accept it. This is the only step that uses
sudo.

## 3. Download and build

```sh
git clone --branch main --single-branch \
    https://github.com/Timpan4/gnome-shell-extension-gsconnect.git gsconnect-bluetooth
cd gsconnect-bluetooth
meson setup _build --prefix=/usr \
    -Dgnome_shell_libdir="$(rpm --eval '%{_libdir}')" \
    -Dinstalled_tests=false
ninja -C _build make-zip
unzip -l _build/gsconnect@andyholmes.github.io.zip service/backends/bluetooth.js
```

If `gsconnect-bluetooth` already exists, use a different directory name in the
clone and `cd` commands.

The last command must list `service/backends/bluetooth.js`. If it does not, stop.
The build only writes inside `_build`.

## 4. Back up your current GSConnect

If GSConnect is already installed, close its preferences window and disable it:

```sh
gnome-extensions disable gsconnect@andyholmes.github.io
```

Then run this, even on a new installation:

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

Write down the printed path. The backup can contain your device's private key,
so do not share it. The script moves any existing user copy of the extension into
the backup. A Fedora RPM install under `/usr/share` is not touched.

## 5. Install and enable the fork

From the `gsconnect-bluetooth` directory, without sudo:

```sh
gnome-extensions install _build/gsconnect@andyholmes.github.io.zip
```

If it reports an existing installation, go back to step 4. Do not add `--force`.

Save your work, log out of GNOME and log back in. Then run:

```sh
gnome-extensions enable gsconnect@andyholmes.github.io
gnome-extensions info gsconnect@andyholmes.github.io
```

The output should show the extension enabled without an error. `Path` should point
to your user extension directory, normally `~/.local/share/gnome-shell/extensions/`.

Do not accept GSConnect updates from extensions.gnome.org while you use this fork.
They use the same extension ID and would replace it.

## 6. Pair the phone

The phone needs two approvals: a system Bluetooth pairing and a GSConnect
pairing. The first does not grant the second.

1. On the phone, install or update KDE Connect from
   [Google Play](https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp)
   or [F-Droid](https://f-droid.org/packages/org.kde.kdeconnect_tp/).
2. In KDE Connect settings, turn on Bluetooth support and allow the Nearby
   devices or Bluetooth permission it asks for. The exact labels depend on the
   app version.
3. On Fedora, open Settings, then Bluetooth. Select the phone and confirm that
   the pairing code matches on both devices.
4. If this phone was paired with GSConnect over Wi-Fi before, unpair it in both
   GSConnect and KDE Connect. Keep the system Bluetooth pairing. Wi-Fi approval
   does not carry over to Bluetooth.
5. Turn off Wi-Fi on both devices. On the computer, also disconnect Ethernet and
   any other network connection. Keep Bluetooth on. Do not use airplane mode,
   because SMS needs mobile service.
6. Open GSConnect preferences with
   `gnome-extensions prefs gsconnect@andyholmes.github.io` and press refresh.
   Refresh the device list in KDE Connect too.
7. Request pairing from one device. Check that the device names and verification
   key match on both screens, then accept. Pairing can fail if either device's
   clock is wrong.

## 7. Check that it works over Bluetooth only

Keep Wi-Fi and Ethernet off on both devices while you check:

1. Ring the phone from GSConnect.
2. Give KDE Connect notification access on the phone, then trigger a
   notification and check that it appears on Fedora.
3. Give KDE Connect its SMS permissions, open GSConnect's messaging window and
   check that conversations load.
4. Send a small file in each direction and open it.

Then confirm the connection type:

```sh
for device_id in $(dconf list /org/gnome/shell/extensions/gsconnect/device/); do
    device_path="/org/gnome/shell/extensions/gsconnect/device/$device_id"
    printf '%s %s\n' "$(dconf read "${device_path}name")" "$(dconf read "${device_path}last-connection")"
done
```

Your phone's line should show a value starting with `'bluetooth://`. A value
starting with `'lan://` means it last connected over the network.

Turn networking back on when you are done.

## Troubleshooting

| Problem | Try |
| --- | --- |
| Build cannot find a compiler, GLib tools or `msgfmt` | Rerun step 2 and check that it finished without errors. |
| Extension missing after install | Log out and back in, then rerun `gnome-extensions info`. |
| Phone paired in Settings but not shown in GSConnect | Check KDE Connect's Bluetooth setting and permissions, keep the app open, and refresh both device lists. |
| Pairing rejected after earlier Wi-Fi use | Unpair in GSConnect and KDE Connect, then pair again over Bluetooth. |
| Pairing lost after changing Bluetooth adapter | Unpair and pair again. Pairings are tied to the adapter. |
| Ring works but SMS or notifications do not | Check the phone's permissions and the plugin switches on both devices. |

These commands only read status:

```sh
systemctl status bluetooth.service --no-pager
bluetoothctl show
journalctl --user -b --no-pager -g 'GSConnect|gsconnect|Bluetooth'
```

If Bluetooth is off or not running, fix it in Fedora's Bluetooth settings. The
fork does not turn the adapter on. Do not disable SELinux to work around an
error. Logs can contain phone numbers, device names and message text, so check
them before you share them.

## Update the fork

From the `gsconnect-bluetooth` directory:

```sh
git status --short
```

If this lists changes, preserve them before updating. Otherwise:

```sh
git pull --ff-only
meson setup --reconfigure _build
ninja -C _build make-zip
```

If `git pull` fails, stop. Do not reset or force it. Otherwise repeat steps 4 and
5, which makes a new backup and installs the new build.

## Go back to your previous GSConnect

Replace `BACKUP_PATH` with the path you wrote down in step 4, then run:

```sh
backup_dir="BACKUP_PATH"
ls "$backup_dir"
```

The list should include `settings.dconf`. If it does not, correct the path. Then,
in the same Terminal window, run:

```sh
user_ext="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/gsconnect@andyholmes.github.io"
gnome-extensions disable gsconnect@andyholmes.github.io
mv -T -- "$user_ext" "$backup_dir/fork-extension" &&
if [ -d "$backup_dir/extension" ]; then
    cp -a "$backup_dir/extension" "$user_ext"
fi
```

This keeps the fork inside the backup folder and restores your earlier user copy,
if you had one. If you used Fedora's RPM, GNOME loads it again because the user
copy is gone. If you had no earlier GSConnect, nothing is loaded.

Log out and back in. If you had an earlier GSConnect, enable it and check its
`Path`:

```sh
gnome-extensions enable gsconnect@andyholmes.github.io
gnome-extensions info gsconnect@andyholmes.github.io
```

You may need to pair your devices again. Your saved settings and configuration
stay in the backup folder and are not restored automatically.
