# Architecture (current state, Phase 0 audit)

Everything relevant lives in `windows/`. The rest of the repo is the macOS app
(`NotchBuddy/`), the iPhone relay (`relay/`), Arch packaging (`linux/`) and
Coucou's website — none of it ships on Windows.

## Shape

```
 Claude Code / Codex / Gemini / Copilot / Cursor / … hooks
            │  spawn
            ▼
   hook/  coucou-hook.exe ──named pipe (300 ms budget)──┐
                                                        ▼
 ┌───────────────────────── src-tauri/ (Rust, Tauri 2) ─────────────────────────┐
 │ lib.rs      app setup, ~100 #[tauri::command]s, tray, single instance         │
 │ island.rs   window placement, monitor choice, DPI, click-through, cursor poll │
 │ pipe.rs, hooks.rs   hook events → island; approval replies back to the hook   │
 │ agents.rs, agent_hooks.rs, config_file.rs   install hooks into each agent's   │
 │             config: strict parse, diff, dated backup, fingerprint, atomic     │
 │ chat.rs     conversation + provider routing                                   │
 │   claude.rs (Messages API, web search, no streaming)                          │
 │   claude_cli.rs (`claude -p` on the user's plan; streams; voice_ask)          │
 │   openai_compat.rs (OpenAI / Gemini / OpenRouter, no streaming)               │
 │   local_chat.rs (Ollama / LM Studio / custom, streaming SSE)                  │
 │ voice.rs    WinRT SpeechRecognizer, phrase-list grammar, wake word            │
 │ eleven.rs   ElevenLabs signed URL, Hermes CLI bridge, open_app, play_song     │
 │ media_win.rs  SMTC sessions, event-driven                                     │
 │ notify.rs, callctl.rs, phone.rs   toasts, Phone Link calls via UIA, iCloud    │
 │ secrets.rs  keyring → Windows Credential Manager                              │
 │ settings.rs plain JSON, tolerant per-field load, atomic save                  │
 │ github.rs, integrations.rs, codex_plan.rs, recap.rs, spotify.rs (Linux) …     │
 └───────────────────────────────┬──────────────────────────────────────────────┘
                     invoke / emit│(core/bridge.ts is the only IPC surface)
 ┌───────────────────────── src/ (TypeScript, no framework) ─────────────────────┐
 │ main.ts → island/island.ts  one rAF loop; parks when nothing animates         │
 │ island/fsm.ts   hidden → petit → home ↔ coucou (open/close only)              │
 │ core/state.ts   global mutable State + notify()                               │
 │ core/anim.ts    Spring (SwiftUI-equivalent, sub-stepped) + Ease + bezier      │
 │ mochi/engine.ts 1.3k-line Canvas 2D character (port of the Mac BotEngine)     │
 │ views/*.ts      imperative DOM per view; style.css 3.3k lines                 │
 │ voice/voice.ts  intents → actions, speechSynthesis TTS                        │
 │ voice/eleven.ts ElevenLabs ConvAI WebSocket, 16 kHz PCM, client tools         │
 │ settings/       separate settings window (1.5k-line main.ts)                  │
 └───────────────────────────────────────────────────────────────────────────────┘
```

## Feature inventory

| Area | Status | Notes |
|---|---|---|
| Island window, monitor choice, DPI, click-through | **Works** | 16 ms cursor poll thread, parked when hidden. No fullscreen-app detection on Windows. |
| Open/close spring motion | **Works** | Spring + timed close curve; interruptible. No reduced-motion branch in the TS loop (one CSS media query only). |
| Character | Works, **not ours** | Mochi; must be replaced (see licence doc). |
| Agent hooks + approvals (10+ agents) | **Works, strongest asset** | Careful config writer; never auto-approves; fail-open to the agent's own prompt. |
| Live diff, session ticker, weekly recap | Works | Keep; restyle later. |
| Chat: Anthropic API | Works | **No streaming**, no cancel. Default model `claude-opus-5`. |
| Chat: Claude on the user's plan (`claude -p`) | Works | Streams. Needs Claude Code installed and logged in. |
| Chat: OpenAI / Gemini / OpenRouter | Works | No streaming, no tools. Default models hard-coded (`gpt-4o`, `gemini-2.0-flash`) — verify against current docs. |
| Chat: Ollama / LM Studio / custom | Works | Streaming; `<think>` hidden. |
| Provider abstraction | Partial | Per-provider modules + routing in `chat.rs`; no capability model, no unified streaming/cancel/error type. |
| Voice: wake word + command grammar | Works, **limited** | Closed phrase list (~400 phrases); Windows free-form dictation fails without package identity (noted in `voice.rs`). Not open speech. |
| Voice: open questions | Partial | Grammar must match first; then `claude -p --model haiku`, **no timeout, no cancel**. |
| Voice: ElevenLabs agent | Works for the author | Hard-coded personal agent id; brain is Hermes CLI (≈35 s/turn). |
| TTS | Partial | `speechSynthesis` in WebView2; no chunking, no interruption state. |
| Voice state machine | **Missing** | State spread over booleans in Rust (`ON`, `ASK`, `CONVERSE`, `TALKING`) and strings in TS. |
| Tools / permissions / undo | **Missing** | Voice intents act directly. `open_app`, `lock_screen`, `play_song` run with no risk model. |
| Screen context / OCR | Missing | Chat can attach a *window title/URL* or a dropped file only. |
| Media (SMTC) | **Works** | Event-driven, artwork, controls. Visualiser is not fed by real audio. |
| Notifications, Phone Link calls | Works (experimental UIA) | |
| Settings persistence | Works | Plain JSON, tolerant load, atomic write; no schema version field. |
| Secrets | **Works** | Credential Manager; keys never reach the webview. |
| Logging | Works | `%LOCALAPPDATA%\Coucou\coucou.log`; transcripts not logged; Hermes commands are. |
| Tests | Works | Rust 265 pass / 1 ignored; TS 369 pass; `tsc` clean (2026-10-13, this machine). |
| Mic-in-use indicator, cancel button, PTT hold | Missing | |

## Baseline machine

i7-14650HX, 13.7 GB RAM, Intel UHD + RTX 4050 Laptop, Windows 11 Home
26100. Node 22.23, Rust via `%USERPROFILE%\.cargo\bin` (not on `PATH`),
VS 2026 Community with MSVC. Performance numbers not yet measured.

## Build gotcha

`cargo test` fails until `cargo build --release -p coucou-hook` has run once:
`tauri.conf.json` bundles `../target/release/coucou-hook.exe` as a resource and
the build script checks it exists. `npm run tauri dev` does this via `predev`.
