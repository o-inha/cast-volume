# CAST VOLUME

[![Btn Support]][Link Support]

Chrome extension with a small helper for adjusting the volume of active Google Cast receivers on your local network. Probably works on Edge and some other browsers as well (untested).

<img width="545" height="245" alt="image" src="https://github.com/user-attachments/assets/2381b6f7-255d-463f-84a9-bb4697d959f9" />

Some streaming services, such as [Pluto TV channels](https://pluto.tv) and [Rakuten TV channels](https://www.rakuten.tv/live_channels) don't have a volume slider while casting. This extension fixes the problem. It controls the _Cast receiver's_ volume directly, not the _session's_ volume, so it will allow you to adjust current cast volume from any tab, and you do not even need access to the casting tab, browser, or device.

### About the helper:

- Chrome does not expose active Google Cast receivers or their volume levels through its public extension APIs. The extension will use the included helper to retrieve that information from your local network.
- Once installed, the helper runs only while the Cast Volume popup is open. It is **NOT** an always-running background process.

## INSTALL

1. From the upper right corner of this page, click Code (green button) -> Download ZIP.
2. Extract the whole ZIP to a folder you can keep.
3. Install the helper.
   - **Windows:** Double-click `install-helper.cmd` and wait for "Cast Volume helper installed".
   - **macOS & Linux:**
     - Prerequisite: [Python 3.10+ with SSL support](https://docs.python.org/3/using/mac.html).
     - Run `sh ./install-helper.sh` —OR— `CAST_VOLUME_PYTHON="/absolute/path/to/python3" sh ./install-helper.sh`
5. In Chrome, go to address `chrome://extensions`. Turn on _Developer mode_, click _Load
   unpacked_, and choose the extracted folder: _extension_
6. Open Chrome's Extensions menu (puzzle icon) and pin _Cast Volume_.

## USE

Start casting as usual, then click _Cast Volume_. Each active receiver has its
own volume slider. Use the refresh button to rescan.

Speaker groups have a speaker-group icon. When several receivers are active,
hover over a name row briefly to reveal its faint handle, then drag it to
reorder the list. The order is saved across
the popup, separate window, and side panel, including when a receiver is
temporarily inactive. You can also focus a handle and use the up/down arrows.

After updating, run the helper setup command again and reload the extension
at `chrome://extensions` to enable speaker-group detection.

The button next to refresh moves Cast Volume to a separate window, then to
Chrome's side panel, then back to the toolbar popup. The separate window stays
open when you switch tabs or focus another window. The full cycle requires
Chrome 141 or newer.

**macOS only:** allow Local Network access for Chrome if prompted. If discovery
fails, check _System Settings > Privacy & Security > Local Network_ and allow
_Chrome_ if listed.

The helper discovers active receivers on the same local network. It cannot
identify which browser started a session. Moving the slider adjusts the Cast
receiver's own volume. Some TVs and soundbars use a separate volume setting.
If the popup reports fixed volume, the receiver has disabled software volume.

The helper uses multicast DNS and the local Cast protocol.
Cast traffic uses encrypted TLS with an unverified
receiver certificate. Receiver identity is inferred from local discovery.

## UNINSTALL

1. Close the popup.
2. Go to address `chrome://extensions` and remove **Cast Volume** extension.
3. Uninstall the helper:
    - **Windows:** Double-click `uninstall-helper.cmd`
    - **macOS & Linux:** Run `sh ./install-helper.sh --uninstall`

## FILES

- `extension/` contains one extension for all three operating systems.
- `source/` contains the shared Python helper source.
- `helper/` contains setup files and the bundled Windows Python runtime and license.

[Btn Support]: https://img.shields.io/badge/☕️_Insist_on_offering_me_a_coffee-392659?style=for-the-badge
[Link Support]: https://buymeacoffee.com/inha
