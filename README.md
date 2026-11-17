# CAST VOLUME

> [!IMPORTANT]  
> This is a 100% vibe-coded adhoc solution prompted in a few minutes. No human has written a single line of code. 

Chrome extension with a small helper for adjusting the volume of active Google Cast receivers on your local network. Probably works on Edge and some other browsers as well (untested).

<img width="545" height="245" alt="image" src="https://github.com/user-attachments/assets/2381b6f7-255d-463f-84a9-bb4697d959f9" />

Some streaming services, such as [Pluto TV channels](https://pluto.tv) and [Rakuten TV channels](https://www.rakuten.tv/live_channels) don't have a volume slider while casting. This extension fixes the problem. It controls the _Cast receiver's_ volume directly, not the _session's_ volume, so it will allow you to adjust current cast volume from any tab, and you do not even need access to the casting tab, browser, or device.

### About the helper:

- Chrome does not expose active Google Cast receivers or their volume levels through its public extension APIs. The extension will use the included helper to retrieve that information from your local network.
- Once installed, the helper starts when you open Cast Volume. It stays connected while the view is open and exits when you close it.

## INSTALL

1. From the upper right corner of this page, click Code (green button) -> Download ZIP.
2. Extract the whole ZIP to a folder you can keep.
3. Install the helper.
   - **Windows:** Double-click `install-helper.cmd` and wait for "Cast Volume helper installed".
   - **macOS & Linux:**
     - Prerequisite: Python 3.10+ with SSL support.
     - Run `sh ./install-helper.sh` (or `CAST_VOLUME_PYTHON="/absolute/path/to/python3" sh ./install-helper.sh`)
5. In Chrome, go to address `chrome://extensions`. Turn on _Developer mode_, click _Load
   unpacked_, and choose the extracted extension folder.
6. Open Chrome's Extensions menu (puzzle icon) and pin _Cast Volume_.

## USE

Start casting as usual, then click _Cast Volume_. Each active receiver has its
own volume slider. Use the refresh button to rescan.

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
