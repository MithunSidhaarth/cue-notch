<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="Tock, Cue's amber capsule character">

# Cue

**A notch for Windows. Cue lives at the top of your screen, and Tock lives in it.**

Approve what your coding agents ask for, watch them build, control whatever is playing, talk to an assistant, and reach your phone, without leaving the window you are in.

![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust)
![Licence: PolyForm Strict](https://img.shields.io/badge/licence-PolyForm%20Strict-black)

</div>

---

## How it looks

Closed, Cue is a small black bar at the top centre of the screen: Tock on the left, the track that is playing, a dot for each coding session, and the clock. Move the pointer onto it and it opens into a page of tiles with five tabs.

| Tab | What is on it |
|---|---|
| **Home** | Now playing, Cue (ask or talk), Today, Focus timer, Agents with their live build, To-do, System (volume, brightness, battery, focus, screenshot, lock, mic) |
| **Media** | The player, every app playing on this PC (click one to switch), and the songs you saved |
| **Files** | A shelf of the files you dropped on the notch, and your clipboard history with search |
| **Phone** | Calls through Phone Link, messages, send a note to your phone, find my phone |
| **Agents** | Every coding session, the request that is waiting for you, and the receipt of the last one that finished |

The gear opens **Settings** inside the notch. The pin keeps the notch open.

When nothing has happened for a while the notch shrinks to a dot with one amber point in it, and comes back when you move the pointer there.

Tock is the amber capsule. Its eyes follow your pointer, it leans out of the notch when the pointer is near, works when an agent works, smiles when a build finishes, dances to music and sleeps at night.

## What it does

### Coding agents

- **Approvals in the notch.** When Claude Code, Codex, Copilot CLI or another agent asks for permission, the notch opens on the request: allow or deny with a click, or with `Y` and `N`. Questions with choices show up the same way.
- **Live build.** The Agents tile shows the session's last steps as they happen, each new line popping in.
- **Build pop.** When a build finishes or fails while the notch is closed, the notch stretches sideways with the result and Tock reacts. If you do not open it, it stays as a green or red dot so nothing is lost.
- **Receipt.** After a session finishes: files changed, lines added and removed, test runs, time taken, and a button to its pull request.
- **Two at once.** With two sessions at work the closed notch splits in half, a Tock in each half with its own eye colour.

Supported: Claude Code, Claude Desktop, Codex, GitHub Copilot CLI, Gemini CLI, Cursor Agent, Antigravity, Muse Code, OpenCode, Amp and Hermes. Any other tool can call `cue-hook --agent <name> <Event>` from its own hooks.

### Music

- **Any player.** Spotify, Apple Music, YouTube in a browser, VLC: anything that reports to Windows' media controls, with play, pause, next, previous and progress.
- **Lyrics.** The line being sung, under the track name. Off until you tap the lines button on the cover (see Privacy).
- **Heart.** Saves the song to Cue's own list on the Media tab, with a link back to the service it came from. It works the same for every player because it is Cue's list, not the service's library.

### Phone

- **Calls and messages** through Phone Link, answered or declined from the notch.
- **Alerts on your phone** when an agent needs you, finishes or fails while you are away, through [ntfy](https://ntfy.sh).
- **Send to phone** and **Find my phone** (an urgent alert that rings through Do Not Disturb).
- **Codes.** A one-time code in a text message is copied to the clipboard, hidden in the inbox, kept out of the clipboard history, and cleared after 60 seconds.

### Everything else

- **Chat and voice.** Type to Anthropic, OpenAI, Google, Ollama, LM Studio or any OpenAI-compatible server. Or talk: a wake word, then your own ElevenLabs agent, which can control music, set timers and to-dos, open apps, and hand bigger jobs to Hermes.
- **Focus, to-do and reminders**, with alerts held while you focus.
- **File drop.** Drag a file onto the notch to keep it on the shelf or hand it to the chat.
- **Transfer blip.** A big download or upload shows its speed in the bar while it runs.
- **Weekly recap** of time coding, sessions, files and commands, with an image to share.
- **Services** at a glance: GitHub, Vercel, Stripe, Notion, Cal.com, Resend and n8n.

## Install

There are no published releases yet, so build the installer yourself (see **Build it yourself**). `npm run pack` produces `release/Cue-Windows-<version>-setup.exe`. It installs for the current user with no admin prompt.

The installer is not code-signed, so Windows SmartScreen warns the first time: choose **More info**, then **Run anyway**.

Cue has no taskbar window. The notch and the icon in the notification area are the whole app; **Quit** is in that icon's menu.

## Set it up

Everything below is in **Settings** (the gear in the notch).

**Coding agents.** Open **Claude Code** or **Agents**. Cue shows the exact change it will make to the agent's config file and where the dated backup goes. Nothing is written until you click, and removing it takes out only Cue's own entries. The hooks run a small relay, `cue-hook.exe`, which passes each event to Cue over a local named pipe. If Cue is not running the relay exits quietly and the agent carries on. With no click from you it never lets a permission through.

**Phone alerts.** Install the free ntfy app on your phone and subscribe to a topic name you make up. Enter the same name under **iPhone**. That one topic is used for alerts, Send to phone and Find my phone.

**Voice.** Under **Voice**, switch Voice on and choose a wake word. For conversations, add your ElevenLabs API key, paste your agent's id into **Agent id**, and switch **ElevenLabs agent** on. The agent needs two client tools, `cue` and `ask_hermes`; there is no built-in agent.

**Animations.** Cue follows Windows' *Animation effects* switch. If that is off and you still want pops, springs and music bars, set **General → Motion** to **Full animation**.

## Keyboard

Global shortcuts can be changed or turned off in **Settings → Shortcuts**.

| Shortcut | What it does |
|---|---|
| `Ctrl+Alt+Space` | Open the chat |
| `Ctrl+Alt+A` | Go to the alert that is waiting |
| `Ctrl+Alt+T` | Jump to the session's terminal |
| `Ctrl+Alt+S` | Mute or unmute sounds |
| `Ctrl+Alt+N` | Open or close the notch (off by default) |

With the notch open: `Ctrl+←` and `Ctrl+→` move between tabs, and on the Agents tab `Y` allows and `N` denies the waiting request.

## Privacy

- API keys and the ntfy topic are kept in the Windows Credential Manager, never in a file.
- Hook events, the log, the recap, saved songs and to-dos stay on this PC. There is no telemetry.
- Network requests go only to the services you set up, with one exception you switch on yourself: **Lyrics** sends the title and artist of the playing track to [LRCLIB](https://lrclib.net), a public lyrics database. It is off by default.
- Voice is off until you add your own ElevenLabs key and agent id.
- One-time codes from your phone are never stored: not in the inbox, not in the clipboard history.
- Preferences: `%APPDATA%\Cue\settings.json`. Data (dropped files, log, recap): `%LOCALAPPDATA%\app.cue.notch`.

## Languages

English, Chinese (Simplified), Hindi, Spanish, Arabic, French, Bengali, Portuguese (Brazil), Russian and Indonesian. Cue follows the system language, or pick one in Settings.

## Build it yourself

You need [Rust](https://rustup.rs), [Node 20+](https://nodejs.org) and the **MSVC build tools** (Visual Studio Build Tools with "Desktop development with C++"). WebView2 ships with Windows 10 and 11.

```powershell
npm install
npm run tauri dev      # live-reloading development build
npm test               # front-end tests
cargo test --workspace # Rust tests (build first: it produces the relay)
npm run pack           # builds the installer into release/
```

`npm run dev` alone serves the front end in a browser. `dev/home-preview.html` shows the widget page on sample data (add `?page=media`, `files`, `phone` or `agents`), which is the quickest way to work on its looks.

The app and tray icons are drawn in code, like Tock:

```powershell
npm run icons          # regenerates src-tauri/icons from scripts/gen-icons.mjs
```

Every push and pull request is type-checked, tested and packaged on Windows by `.github/workflows/ci.yml`.

### Layout

```
src/                 front end (TypeScript, no framework)
  avatar/            Tock, in Canvas 2D
  core/              state, layout, and the pure logic (moments.ts, motion.ts…)
  island/            the notch itself: state machine, hooks, live activities
  views/             the widget page (home.ts, home-pages.ts, song.ts) and the cards
  settings/          the settings page, shown in the notch and in its own window
src-tauri/           Rust backend: window, named pipe, media, phone, providers
hook/                cue-hook.exe, the agent relay
design/              prototypes; cue.html is the design the app follows
docs/                architecture, handoff plan, licence notes
```

### Log

`%LOCALAPPDATA%\app.cue.notch\cue.log` records hook events, permission decisions, errors and, for each time the notch resizes, how smooth it was (frames, average and worst frame time). It starts fresh past about 1 MB.

## Not done yet

- The installer is not code-signed and there is no auto-update.
- The chat, question, focus, to-do and file-drop cards still use the earlier, narrower layout.
- A few labels in Settings still say "Island" and "pills".
- Sounds: Cue ships silent until it has its own.
- The Today tile has no weather or calendar event, and the phone's battery shows only if the phone reports it through a Shortcut.

## Licence and credits

Cue is source-available under the [PolyForm Strict License 1.0.0](LICENSE): you can read the code and use the app for noncommercial purposes, but you may not change it, build on it or redistribute it. It includes code derived from the MIT-licensed [Coucou](https://github.com/Louis-CFM/coucou) by Louis Raillé, whose notice is kept in [NOTICE](NOTICE). Coucou's name, its character and its artwork are not part of Cue. Details are in [docs/LICENCE_AND_ATTRIBUTION.md](docs/LICENCE_AND_ATTRIBUTION.md).
