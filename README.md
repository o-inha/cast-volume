# CAST VOLUME

> [!IMPORTANT]  
> This is a 100% vibe-coded adhoc solution prompted in a few minutes. No human has written a single line of code. 

Chrome extension for Windows 11 (x64), that adds a button to open a small popup for volume control of current casts of Google Cast devices in local network.

<img width="536" height="246" alt="image" src="https://github.com/user-attachments/assets/b83fcc25-6b9c-463b-9a77-a39cb89cf198" />

### Why?

Some streaming services, such as [Pluto TV channels](https://pluto.tv) and [Rakuten TV channels](https://www.rakuten.tv/live_channels) don't have a volume slider while casting. This Extension fixes the problem. As a unintentional bonus feature: of course, this extension will allow you to adjust current cast volume from any tab, so you do not need to find the casting tab, or even casting device (I didn't even think about this, but it's actually very convenient).

## INSTALL

1. From the upper right corner of this page, click Code (green button) -> Download ZIP.
2. Extract the whole ZIP to a folder you can keep.
3. Double-click `install-helper.cmd` and wait for "Cast Volume helper installed".
   - Chrome does not expose active Google Cast receivers or their volume levels through its public extension APIs. The extension will use the helper to retrieve that information from your local network.
   - The helper runs once every time you open the volume popup (is **NOT** some background process).
   - The helper installs for your Windows account and includes its own Python runtime.
5. In Chrome, go to address `chrome://extensions`. Turn on _Developer mode_, click _Load
   unpacked_, and choose the extracted extension folder.
6. Open Chrome's Extensions menu (puzzle icon) and pin _Cast Volume_.

## USE

Start casting as usual. Click Cast Volume and move the slider. The receiver
and current volume should appear within a few seconds. If several receivers
have active casts, select one by name. Use the refresh button to rescan.

The helper discovers active receivers on the same local network. It cannot
identify which browser started a session. Moving the slider adjusts the Cast
receiver's own volume. Some TVs and soundbars use a separate volume setting.
If the popup reports fixed volume, the receiver has disabled software volume.

The helper starts when you open the popup and uses multicast DNS and the
local Cast protocol. Cast traffic uses encrypted TLS with an unverified
receiver certificate. Receiver identity is inferred from local discovery.

## UNINSTALL

1. Close the popup.
2. Go to address `chrome://extensions` and remove Cast Volume extension.
3. Double-click `uninstall-helper.cmd` to remove the Windows helper.

## FILES

extension/ contains the Chrome extension.
- source/ contains the complete Windows helper source.
- helper/ contains the launcher, installer, and the official Python 3.14.10
- Windows x64 embeddable distribution with its included license notices.
