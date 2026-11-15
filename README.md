# Fablehop Unrepost

A browser extension that removes all of your TikTok reposts. Works in Brave (and Chrome, Edge) and Firefox. Made by [slizsy](https://github.com/slizsy).

Press start and it opens your profile, goes to the Reposts tab, and un-reposts each video one by one. A small panel on the page counts them as they go. When it reaches the end it reloads and checks again, until there are none left.

## Install

Download this repo first (Code → Download ZIP, then unzip it).

**Brave / Chrome / Edge**

1. Go to `brave://extensions` (or `chrome://extensions`)
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick the `brave` folder

**Firefox** (127 or newer)

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Pick `manifest.json` inside the `firefox` folder

Firefox forgets temporary add-ons when it closes, so you load it again next time you need it.

## Use

1. Log in on [tiktok.com](https://www.tiktok.com)
2. Click the Fablehop icon in the toolbar and press **Start**
3. Leave the tab open until the panel says done

Speed sets how long it waits between videos. If TikTok starts ignoring the clicks, stop, wait a few minutes and run it again on **Slow**.

## How it's laid out

- `src/`: the extension itself (plain HTML/CSS/JS, no build tools)
- `manifest.brave.json`, `manifest.firefox.json`: one manifest per browser
- `build.sh`: copies `src/` into `brave/` and `firefox/` with the right manifest. Run it after changing anything in `src/`.

It finds TikTok's buttons by their names in the page. If TikTok changes its layout and it stops working, the selectors to update are near the top of `src/content.js`.

It only runs on tiktok.com, and nothing leaves your browser.
