# wordcollector

The point of this program is to be able to launch a program that can store words and their dictionary definition. The user should be able to hit a button which prompts to add a word to their library, and the word they type should come from the merriam-webster dictionary. If the word they type is not in the merriam-webster dictionary, the user can still use the word, but the definition(s) will not be autofilled. The user should be able to sort their words, add notes to them, and favorite them. The aesthetic should be something like Claude itself and be semi customizable.

## Features

- **Add a word** and its definitions fill in automatically from the Merriam-Webster Collegiate Dictionary, with example sentences, pronunciation audio, etymology and the date of first known use. The add dialog shows what was found before you save.
- **Thesaurus**: synonyms and antonyms from the Merriam-Webster Collegiate Thesaurus. Long lists are collapsed behind "Show all". Click one to open it, or to add it if it isn't in your library yet.
- **Words not in any dictionary** can still be saved. Merriam-Webster's "Did you mean…?" suggestions are shown when it has them.
- **One ordered list of definitions**: Merriam-Webster text is read-only, and your own definitions can be added, edited and deleted. Reorder them by dragging, with the arrow buttons, or with **Set as main**. The top definition is the one shown on the card. **Refresh definitions** keeps your order.
- **Where I found it**: title, author and page number for each word.
- **Tags**: add tags to words and filter the library by tag.
- **Notes** (they save automatically) and **favorites**.
- **Flashcard review**: see a word, recall its meaning, reveal the definition and mark whether you knew it. Words you miss come back sooner. You can review everything, favorites only, or one tag.
- **Backup**: export the whole library as JSON (which can be imported again) or as a CSV spreadsheet, from Settings.
- **Sorting**: newest/oldest, A→Z/Z→A, or grouped by part of speech, with an optional "Favorites first" toggle. Search covers words, notes, titles and authors.
- **Appearance**: light, dark or system theme; accent color; serif, sans or mono font; text size; card or compact layout.

## Install (Windows)

Download **Word-Collector-Setup-x.y.z.exe** from the [latest release](https://github.com/KaiyoDino/wordcollector/releases/latest) and run it. Then open Settings and add your free Merriam-Webster keys (see below).

- Windows may say "Windows protected your PC", because the installer isn't code-signed. Click **More info → Run anyway**.
- The app updates itself. When a new version has downloaded, a bar at the top says it's ready; click **Restart to update**, or it installs the next time you quit.
- Your library is kept in `%APPDATA%\Word Collector` and survives updates and uninstalling.

## Run from source

Requires [Node.js](https://nodejs.org) 22 or newer.

```sh
npm install
npm start          # web version in your browser
npm run desktop    # the desktop app, in its own window
```

`npm start` opens the app at http://localhost:5173. Both commands use the library in `data/wordcollector.sqlite`, which is never committed.

### Merriam-Webster API keys (free)

1. Register at https://dictionaryapi.com/register/index.
2. Request the **Collegiate Dictionary** and **Collegiate Thesaurus** APIs. Each one gives you its own key.
3. In the app, open **Settings** (the sliders icon) → **Merriam-Webster API keys**, paste both keys and click **Save keys**. Each key is checked with Merriam-Webster before it's saved.

Alternatively, copy `.env.example` to `.env` and put the keys there. A key saved in the app takes priority over `.env`. Keys are never sent to the browser or included in exports, and `.env` is git-ignored.

Without keys the app still runs, but no definitions or synonyms are filled in. You can still save words and add your own definitions. If a lookup fails (for example, while you're offline), open the word later and use **Refresh definitions**.

## Sharing

The easiest way to share is the installer: send people the [latest release page](https://github.com/KaiyoDino/wordcollector/releases/latest). Anyone can also clone this repo and run it from source. Each person uses their own free Merriam-Webster keys, and each person's library stays on their own computer. To move a library between computers, use **Settings → Export backup (JSON)** and **Import backup…**.

## Keyboard shortcuts

- `n` adds a word
- `/` searches
- `r` starts a review
- `Esc` closes the word panel, a dialog or the review
- In review: `Space` reveals, `←` didn't know, `→` knew it

## Project layout

```
server/
  index.js            Express server; exports startServer({ port, dataDir })
  db.js               SQLite (sql.js, WebAssembly — no native build step)
  words.js            Library queries
  backup.js           Export (JSON/CSV) and import validation
  routes/api.js       REST API
  lookup/             Merriam-Webster dictionary + thesaurus clients and markup cleanup
public/               Frontend (plain HTML/CSS/JS modules, no build step)
electron/             Desktop app: window, auto-updates, preload bridge
scripts/              build.mjs (installer) and release.mjs (GitHub Release)
build/                App icon
```

## Releasing an update

Installed copies check this repo's GitHub Releases at startup and every few hours. To ship a new version:

```sh
npm version patch        # 1.0.0 -> 1.0.1 (use minor or major for bigger changes); commits and tags
git push --follow-tags
npm run release          # builds the installer and publishes it as a GitHub Release
```

`npm run release` needs the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`). It refuses to run with uncommitted or unpushed changes, so a release always matches the code on GitHub. To build the installer without publishing, run `npm run dist`. When this folder is inside OneDrive, the output goes to `%LOCALAPPDATA%\WordCollector-build`, so OneDrive doesn't sync (and lock) about 300 MB of build files.

The desktop wrapper is `electron/`: `main.js` starts the same server as `npm start` and opens it in a window; `updater.js` handles updates; `preload.cjs` gives the page a small, fixed API for update controls.
